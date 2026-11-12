import { describe, it, expect, vi } from 'vitest';

import {
  createClawOpsPhoneTools,
  HANG_UP_FAREWELL_PROMPT,
} from '../../src/agent/livekit/toolset.js';
import { BuiltinTool } from '../../src/agent/builtin-tool.js';

/** 가짜 `@livekit/agents` `llm` 네임스페이스 — tool/Toolset/ToolFlag 만 흉내낸다. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
class FakeRealtimeModel {
  constructor(public capabilities: { autoToolReplyGeneration: boolean } = { autoToolReplyGeneration: false }) {}
}

function fakeLlm() {
  return {
    RealtimeModel: FakeRealtimeModel,
    ToolFlag: { IGNORE_ON_ENTER: 1, NONE: 0 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool: (def: any) => ({ ...def, __tool: true }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Toolset: { create: (opts: any) => ({ id: opts.id, tools: opts.tools, __toolset: true }) },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolNames(phone: { toolset: any }): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return phone.toolset.tools.map((t: any) => t.name);
}

describe('createClawOpsPhoneTools', () => {
  it('enabled 셋에 든 도구만 노출한다', () => {
    const phone = createClawOpsPhoneTools(fakeLlm(), {
      enabled: new Set([BuiltinTool.HANG_UP]),
    });
    expect(toolNames(phone)).toEqual(['hang_up']);
  });

  it('네 개 전부 활성화하면 모두 노출한다', () => {
    const phone = createClawOpsPhoneTools(fakeLlm(), {
      enabled: new Set([
        BuiltinTool.HANG_UP,
        BuiltinTool.COLLECT_DTMF,
        BuiltinTool.SEND_DTMF,
        BuiltinTool.TRANSFER_CALL,
      ]),
    });
    expect(toolNames(phone).sort()).toEqual(
      ['collect_dtmf', 'hang_up', 'send_dtmf', 'transfer_call'].sort(),
    );
  });

  it('excludeNames 에 든 도구는 뺀다 (유저 도구 이름 충돌)', () => {
    const phone = createClawOpsPhoneTools(fakeLlm(), {
      enabled: new Set([BuiltinTool.HANG_UP, BuiltinTool.SEND_DTMF]),
      excludeNames: new Set(['hang_up']),
    });
    expect(toolNames(phone)).toEqual(['send_dtmf']);
  });

  it('hang_up/transfer_call 은 IGNORE_ON_ENTER, 나머지는 flag 없음', () => {
    const llm = fakeLlm();
    const phone = createClawOpsPhoneTools(llm, {
      enabled: new Set([BuiltinTool.HANG_UP, BuiltinTool.SEND_DTMF, BuiltinTool.TRANSFER_CALL]),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byName = Object.fromEntries((phone.toolset as any).tools.map((t: any) => [t.name, t]));
    expect(byName['hang_up'].flags).toBe(llm.ToolFlag.IGNORE_ON_ENTER);
    expect(byName['transfer_call'].flags).toBe(llm.ToolFlag.IGNORE_ON_ENTER);
    expect(byName['send_dtmf'].flags).toBeUndefined();
  });

  it('setCall 전에 실행하면 에러를 던진다', async () => {
    const phone = createClawOpsPhoneTools(fakeLlm(), { enabled: new Set([BuiltinTool.HANG_UP]) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hangUp = (phone.toolset as any).tools[0] as any;
    await expect(hangUp.execute({})).rejects.toThrow('통화가 아직 연결되지 않았습니다');
  });

  it('setCall 후 실행하면 executeBuiltinTool 로 위임한다 (hang_up → call.hangup)', async () => {
    const phone = createClawOpsPhoneTools(fakeLlm(), { enabled: new Set([BuiltinTool.HANG_UP]) });
    const call = { hangup: vi.fn(async () => {}) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    phone.setCall(call as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hangUp = (phone.toolset as any).tools[0] as any;
    const result = await hangUp.execute({});
    expect(call.hangup).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined(); // 결과 없음 = LiveKit 이 끊은 뒤 응답을 만들지 않는다
  });

  describe('hang_up 은 작별 인사 재생을 마친 뒤 끊는다', () => {
    /**
     * RunContext 중 hang_up 이 쓰는 것만. LiveKit 처럼 이 단계의 assistant 메시지는 단계 재생이 끝날 때
     * (`playedStep`) 들어온다. `earlier` 는 같은 턴 앞 단계에서 이미 한 말.
     */
    function fakeCtx(
      opts: {
        spoke?: boolean;
        interrupted?: boolean;
        earlier?: string;
        realtime?: boolean;
        autoReply?: boolean;
      } = {},
    ) {
      let resolveStep!: () => void;
      const stepPlayed = new Promise<void>((r) => (resolveStep = r));
      const doneCbs: Array<() => void> = [];
      const chatItems: Array<Record<string, unknown>> = opts.earlier
        ? [{ type: 'message', role: 'assistant', textContent: opts.earlier }]
        : [];
      const speechHandle = {
        allowInterruptions: true,
        chatItems,
        addDoneCallback: (cb: () => void) => doneCbs.push(cb),
      };
      const listeners: Record<string, Array<(ev: unknown) => void>> = {};
      const session = {
        llm:
          opts.realtime || opts.autoReply
            ? new FakeRealtimeModel({ autoToolReplyGeneration: !!opts.autoReply })
            : {},
        on: (ev: string, fn: (e: unknown) => void) => (listeners[ev] ??= []).push(fn),
        off: (ev: string, fn: (e: unknown) => void) => {
          listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn);
        },
        emit: (ev: string, e: unknown) => (listeners[ev] ?? []).slice().forEach((f) => f(e)),
        listeners,
      };
      const ctx = {
        speechHandle,
        session,
        disallowInterruptions: () => {
          if (opts.interrupted) throw new Error('already interrupted');
          speechHandle.allowInterruptions = false;
        },
        waitForPlayout: () => stepPlayed,
      };
      const playedStep = () => {
        if (opts.spoke) {
          chatItems.push({ type: 'message', role: 'assistant', textContent: '감사합니다. 좋은 하루 보내세요.' });
        }
        resolveStep();
      };
      return { ctx, playedStep, turnDone: () => doneCbs.forEach((cb) => cb()) };
    }

    function setup() {
      const phone = createClawOpsPhoneTools(fakeLlm(), {
        enabled: new Set([BuiltinTool.HANG_UP]),
      });
      const call = { hangup: vi.fn(async () => {}) };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      phone.setCall(call as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hangUp = (phone.toolset as any).tools[0] as any;
      return { call, hangUp };
    }

    const tick = () => new Promise((r) => setTimeout(r, 20));

    it('같은 응답에서 말한 인사가 재생될 때까지 끊지 않고, 끊은 뒤 결과 없이 끝낸다', async () => {
      const { call, hangUp } = setup();
      const { ctx, playedStep } = fakeCtx({ spoke: true });
      const running = hangUp.execute({}, { ctx });
      await tick();
      expect(call.hangup).not.toHaveBeenCalled();
      expect(ctx.speechHandle.allowInterruptions).toBe(false);
      playedStep();
      await expect(running).resolves.toBeUndefined(); // 결과 없음 = 끊은 뒤 응답 안 만듦
      expect(call.hangup).toHaveBeenCalledTimes(1);
    });

    it('재생 완료 신호가 끝내 안 와도 상한에서 끊는다', async () => {
      vi.useFakeTimers();
      try {
        const { call, hangUp } = setup();
        const { ctx } = fakeCtx({ spoke: true });
        const running = hangUp.execute({}, { ctx });
        const settled = expect(running).resolves.toBeUndefined();
        await vi.advanceTimersByTimeAsync(15_000);
        await settled;
        expect(call.hangup).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('이미 끼어들기가 일어났으면 끊지 않는다', async () => {
      const { call, hangUp } = setup();
      const { ctx } = fakeCtx({ interrupted: true });
      const out = await hangUp.execute({}, { ctx });
      expect(out).toContain('끊지 않았습니다');
      expect(call.hangup).not.toHaveBeenCalled();
    });

    it('말 없이 hang_up 만 부르면 인사를 시키고, 그 턴이 끝난 뒤 한 번만 끊는다', async () => {
      const { call, hangUp } = setup();
      const { ctx, playedStep, turnDone } = fakeCtx({ spoke: false });
      playedStep();
      const out = await hangUp.execute({}, { ctx });
      expect(out).toBe(HANG_UP_FAREWELL_PROMPT);
      await tick();
      expect(call.hangup).not.toHaveBeenCalled(); // 인사 턴이 아직 재생 중
      // 인사와 함께 hang_up 을 또 불러도 끊기는 한 번
      const second = fakeCtx({ spoke: true });
      second.playedStep();
      await expect(hangUp.execute({}, { ctx: second.ctx })).resolves.toBeUndefined();
      turnDone();
      await tick();
      expect(call.hangup).toHaveBeenCalledTimes(1);
    });

    it('같은 턴 앞 단계의 말은 작별 인사로 치지 않는다 — 인사를 시킨다', async () => {
      const { call, hangUp } = setup();
      const { ctx, playedStep } = fakeCtx({ earlier: '확인해 볼게요.' });
      playedStep();
      await expect(hangUp.execute({}, { ctx })).resolves.toBe(HANG_UP_FAREWELL_PROMPT);
      expect(call.hangup).not.toHaveBeenCalled();
    });

    it('OpenAI realtime 도 말 없이 hang_up 만 부르면 인사를 시키고, 그 턴이 끝난 뒤 끊는다', async () => {
      const { call, hangUp } = setup();
      const { ctx, playedStep, turnDone } = fakeCtx({ realtime: true });
      playedStep();
      await expect(hangUp.execute({}, { ctx })).resolves.toBe(HANG_UP_FAREWELL_PROMPT);
      await tick();
      expect(call.hangup).not.toHaveBeenCalled();
      turnDone();
      await tick();
      expect(call.hangup).toHaveBeenCalledTimes(1);
    });

    it('도구 응답이 새 발화로 오는 realtime 은 그 발화가 끝난 뒤 끊는다 (createEndCallTool 과 같다)', async () => {
      const { call, hangUp } = setup();
      const { ctx, playedStep, turnDone } = fakeCtx({ autoReply: true });
      playedStep();
      await expect(hangUp.execute({}, { ctx })).resolves.toBe(HANG_UP_FAREWELL_PROMPT);
      turnDone(); // 도구를 부른 발화가 끝나도
      await tick();
      expect(call.hangup).not.toHaveBeenCalled(); // 인사 발화가 아직이면 끊지 않는다
      const replyDone: Array<() => void> = [];
      ctx.session.emit('speech_created', {
        speechHandle: { addDoneCallback: (cb: () => void) => replyDone.push(cb) },
      });
      await tick();
      expect(call.hangup).not.toHaveBeenCalled();
      replyDone.forEach((cb) => cb());
      await tick();
      expect(call.hangup).toHaveBeenCalledTimes(1);
      expect(ctx.session.listeners['speech_created']).toEqual([]); // 구독을 남기지 않는다
    });

    it('새 발화가 끝내 안 생기면 상한에서 끊는다', async () => {
      vi.useFakeTimers();
      try {
        const { call, hangUp } = setup();
        const { ctx, playedStep } = fakeCtx({ autoReply: true });
        playedStep();
        await expect(hangUp.execute({}, { ctx })).resolves.toBe(HANG_UP_FAREWELL_PROMPT);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(call.hangup).toHaveBeenCalledTimes(1);
        expect(ctx.session.listeners['speech_created']).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('단계 재생 대기가 상한을 다 쓰면 인사를 시키지 않고 끊는다 (대기 합계 = 상한)', async () => {
      vi.useFakeTimers();
      try {
        const { call, hangUp } = setup();
        const { ctx } = fakeCtx(); // 재생 완료 신호가 끝내 안 온다
        const running = hangUp.execute({}, { ctx });
        const settled = expect(running).resolves.toBeUndefined();
        await vi.advanceTimersByTimeAsync(15_000);
        await settled;
        expect(call.hangup).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('인사 도중 상대가 먼저 끊어 닫힌 회선이어도 뒤에서 끊는 작업이 예외를 흘리지 않는다', async () => {
      const phone = createClawOpsPhoneTools(fakeLlm(), { enabled: new Set([BuiltinTool.HANG_UP]) });
      const call = { hangup: vi.fn(async () => { throw new Error('media ws closed'); }) };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      phone.setCall(call as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hangUp = (phone.toolset as any).tools[0] as any;
      const { ctx, playedStep, turnDone } = fakeCtx();
      playedStep();
      await expect(hangUp.execute({}, { ctx })).resolves.toBe(HANG_UP_FAREWELL_PROMPT);
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        turnDone();
        await tick();
        expect(call.hangup).toHaveBeenCalledTimes(1);
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('작별 인사 요청 문구는 언어 중립이고, 이미 인사했으면 반복하지 않게 한다', () => {
      expect(HANG_UP_FAREWELL_PROMPT).toContain('same language as this conversation');
      expect(HANG_UP_FAREWELL_PROMPT).toContain('already a goodbye');
    });
  });
});
