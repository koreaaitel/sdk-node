import { describe, it, expect, vi, beforeEach } from 'vitest';

// onIncoming 에서 call.transfer(to) — AI 세션 없이 받아 곧바로 넘긴다.

const media = vi.hoisted(() => {
  class FakeMedia {
    static instances: FakeMedia[] = [];
    static sendAudioFrame = true;
    onAudioFn: ((a: Buffer, t: number) => void) | null = null;
    onCloseFn: (() => void) | null = null;
    closedBySdk = false;
    url = '';
    constructor() {
      FakeMedia.instances.push(this);
    }
    setLogger(): void {}
    onAudio(fn: (a: Buffer, t: number) => void): void {
      this.onAudioFn = fn;
    }
    onClose(fn: () => void): void {
      this.onCloseFn = fn;
    }
    onStart(): void {}
    onDtmf(): void {}
    async connect(url: string): Promise<void> {
      this.url = url;
      if (FakeMedia.sendAudioFrame) setTimeout(() => this.onAudioFn?.(Buffer.alloc(160, 0xff), 0), 5);
    }
    serverClose(): void {
      this.onCloseFn?.();
    }
    close(): void {
      this.closedBySdk = true;
      this.onCloseFn?.();
    }
  }
  return { FakeMedia };
});

vi.mock('../../src/agent/media-ws.js', () => ({ MediaWebSocket: media.FakeMedia }));

import { ClawOpsAgent } from '../../src/agent/agent.js';
import { IncomingCall } from '../../src/agent/incoming.js';
import { AgentConnectionError } from '../../src/error.js';
import type { Session } from '../../src/agent/pipeline/base.js';

const { FakeMedia } = media;

class ControlWS {
  sent: Record<string, unknown>[] = [];
  transfers: [string, Record<string, unknown>][] = [];
  constructor(private results: unknown[] = [{ status: 'completed' }]) {}
  send(msg: Record<string, unknown>): void {
    this.sent.push(msg);
  }
  async requestTransfer(callId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.transfers.push([callId, params]);
    const r = this.results.length > 1 ? this.results.shift()! : this.results[0]!;
    if (r instanceof Error) throw r;
    if (r === 'hang') return new Promise(() => {}); // 결과가 오지 않는다(대상이 울리는 중)
    return r as Record<string, unknown>;
  }
}

function build(results?: unknown[]) {
  const started: unknown[] = [];
  const session = {
    start: async () => {
      started.push(1);
    },
    stop: async () => {},
  } as unknown as Session;
  const agent = new ClawOpsAgent({ apiKey: 'sk_test', accountId: 'AC123', from: '07012341234', session });
  const ws = new ControlWS(results);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = agent as any;
  a._controlWs = ws;
  a._safeStartCallSession = vi.fn();
  return { agent, a, ws, made: started };
}

const incoming = (extra: Record<string, unknown> = {}) => ({
  event: 'call.incoming',
  callId: 'C1',
  from: '01062915351',
  mediaUrl: 'wss://m',
  ...extra,
});

async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not met');
}

beforeEach(() => {
  FakeMedia.instances = [];
  FakeMedia.sendAudioFrame = true;
});

describe('IncomingCall.transfer', () => {
  it('AI 세션 없이 받고, 발신자 음성이 오면 blind/terminate 로 전환한다', async () => {
    const { agent, a, ws, made } = build();
    agent.onIncoming(async (call) => {
      await call.transfer('0221012266', { callerIdMode: 'original', failureMessage: '연결이 어렵습니다' });
    });
    await a._handleIncoming(incoming());
    await until(() => ws.transfers.length > 0);

    expect(ws.sent).toEqual([{ event: 'call.accept', callId: 'C1' }]);
    const [callId, params] = ws.transfers[0]!;
    expect(callId).toBe('C1');
    expect(params).toMatchObject({
      to: '0221012266',
      mode: 'blind',
      afterTransfer: 'terminate',
      callerIdMode: 'original',
      failureMessage: '연결이 어렵습니다',
    });
    expect(made).toEqual([]);
    expect(a._safeStartCallSession).not.toHaveBeenCalled();

    FakeMedia.instances[0]!.serverClose();
    await until(() => !a._activeSessions.has('C1'));
    expect(FakeMedia.instances[0]!.closedBySdk).toBe(false);
  });

  it('NO_SESSION 거절은 다시 시도한다', async () => {
    const noSession = { status: 'failed', reason: 'No active media session' };
    const { agent, a, ws } = build([noSession, noSession, { status: 'completed' }]);
    agent.onIncoming((call) => {
      void call.transfer('0221012266');
    });
    await a._handleIncoming(incoming());
    await until(() => ws.transfers.length === 3, 3000);
    FakeMedia.instances[0]!.serverClose();
    await until(() => !a._activeSessions.has('C1'));
    expect(FakeMedia.instances[0]!.closedBySdk).toBe(false);
  });

  it('시작도 못 한 거절이면 무음으로 두지 않고 끊는다', async () => {
    const { agent, a, ws } = build([{ status: 'failed', reason: 'Invalid phone number' }]);
    agent.onIncoming(async (call) => call.transfer('123'));
    await a._handleIncoming(incoming());
    await until(() => ws.transfers.length > 0);
    await until(() => !a._activeSessions.has('C1'));
    expect(FakeMedia.instances[0]!.closedBySdk).toBe(true);
  });

  it('대상 무응답(사유 없는 실패)은 서버에 맡긴다', async () => {
    const { agent, a, ws } = build([{ status: 'failed' }]);
    agent.onIncoming(async (call) => call.transfer('0221012266'));
    await a._handleIncoming(incoming());
    await until(() => ws.transfers.length > 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeMedia.instances[0]!.closedBySdk).toBe(false);
    FakeMedia.instances[0]!.serverClose();
    await until(() => !a._activeSessions.has('C1'));
  });

  it('음성 전에 발신자가 끊으면 전환하지 않는다', async () => {
    FakeMedia.sendAudioFrame = false;
    const { agent, a, ws } = build();
    agent.onIncoming(async (call) => call.transfer('0221012266'));
    await a._handleIncoming(incoming());
    await until(() => FakeMedia.instances.length > 0);
    await new Promise((r) => setTimeout(r, 10));
    FakeMedia.instances[0]!.serverClose();
    await until(() => !a._activeSessions.has('C1'));
    expect(ws.transfers).toEqual([]);
  });

  it('대상자는 평소대로 AI 가 받는다', async () => {
    const { agent, a, ws } = build();
    agent.onIncoming(async (call) => {
      if (call.fromNumber !== '01062915351') await call.transfer('0221012266');
    });
    await a._handleIncoming(incoming());
    expect(ws.transfers).toEqual([]);
    expect(a._safeStartCallSession).toHaveBeenCalledOnce();
  });

  it('reject 와 transfer 는 먼저 부른 것만 남는다', async () => {
    const mk = () =>
      new IncomingCall({ callId: 'C', fromNumber: '010', toNumber: '070', callerIdRestricted: false, onReject: () => {} });
    const x = mk();
    await x.transfer('0221012266');
    await x.reject();
    expect(x.transferRequest).not.toBeNull();
    expect(x.rejected).toBe(false);

    const y = mk();
    await y.reject({ reason: 'busy' });
    await y.transfer('0221012266');
    expect(y.transferRequest).toBeNull();
    expect(y.rejectReason).toBe('busy');
  });

  it('callerIdMode 오타는 예외', async () => {
    const c = new IncomingCall({ callId: 'C', fromNumber: '010', toNumber: '070', callerIdRestricted: false, onReject: () => {} });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(c.transfer('0221012266', { callerIdMode: 'orignal' as any })).rejects.toThrow();
  });

  it('결과를 못 받은 채 연결이 끊기면(drain) 끊지 않고 서버를 기다린다', async () => {
    const { agent, a, ws } = build([new Error('connection closed')]);
    agent.onIncoming(async (call) => call.transfer('0221012266'));
    await a._handleIncoming(incoming());
    await until(() => ws.transfers.length > 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeMedia.instances[0]!.closedBySdk).toBe(false);
    expect(a._activeSessions.has('C1')).toBe(true);
    FakeMedia.instances[0]!.serverClose();
    await until(() => !a._activeSessions.has('C1'));
    expect(FakeMedia.instances[0]!.closedBySdk).toBe(false);
  });

  it('요청을 보내지 못했으면 끊는다', async () => {
    const { agent, a, ws } = build([new AgentConnectionError('transfer 불가')]);
    agent.onIncoming(async (call) => call.transfer('0221012266'));
    await a._handleIncoming(incoming());
    await until(() => ws.transfers.length > 0);
    await until(() => !a._activeSessions.has('C1'));
    expect(FakeMedia.instances[0]!.closedBySdk).toBe(true);
  });

  it('결과를 기다리는 중 미디어가 닫히면 깔끔히 끝난다', async () => {
    const { agent, a, ws } = build(['hang']);
    agent.onIncoming(async (call) => call.transfer('0221012266'));
    await a._handleIncoming(incoming());
    await until(() => ws.transfers.length > 0);
    FakeMedia.instances[0]!.serverClose();
    await until(() => !a._activeSessions.has('C1'));
    expect(FakeMedia.instances[0]!.closedBySdk).toBe(false);
  });

  it('transfer() 는 선별 함수가 끝나기를 기다리지 않고 받는다', async () => {
    const { agent, a, ws } = build();
    agent.onIncoming(async (call) => {
      await call.transfer('0221012266');
      await new Promise((r) => setTimeout(r, 1000)); // 뒤에 더 일한다
    });
    const t0 = Date.now();
    await a._handleIncoming(incoming());
    expect(Date.now() - t0).toBeLessThan(500);
    expect(ws.sent).toEqual([{ event: 'call.accept', callId: 'C1' }]);
    await until(() => ws.transfers.length > 0);
    FakeMedia.instances[0]!.serverClose();
    await until(() => !a._activeSessions.has('C1'));
  });
});
