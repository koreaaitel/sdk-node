import { describe, it, expect, vi } from 'vitest';
import { BuiltinTool } from '../../src/agent/builtin-tool.js';
import { createClawOpsPhoneTools } from '../../src/agent/livekit/toolset.js';
import { executeBuiltinTool } from '../../src/agent/pipeline/builtin-tool-schemas.js';
import { transferResultForModel, waitForTransferResult } from '../../src/agent/transfer-tool.js';
import type { CallSession } from '../../src/agent/session.js';

/** 파이썬 SDK tests/agent/test_transfer_tool.py 와 같은 계약이다. */
function callWith(transfer: (...args: unknown[]) => Promise<Record<string, unknown>>): CallSession {
  return { transfer } as unknown as CallSession;
}

function deferred(): { promise: Promise<Record<string, unknown>>; resolve: (v: Record<string, unknown>) => void } {
  let resolve!: (v: Record<string, unknown>) => void;
  const promise = new Promise<Record<string, unknown>>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('transferResultForModel', () => {
  it.each([
    ['no-answer', 'did not answer'],
    ['busy', 'busy'],
    ['failed', 'could not be connected'],
    ['completed', 'finished the call'],
    ['canceled', 'hung up'],
  ])('%s', (status, expected) => {
    const body = JSON.parse(transferResultForModel({ status }));
    expect(body.status).toBe(status);
    expect(body.message).toContain(expected);
  });

  it('상태가 없으면 실패로 본다', () => {
    expect(JSON.parse(transferResultForModel({})).status).toBe('failed');
  });
});

describe('자체 세션의 transfer_call', () => {
  it.each(['terminate', 'return'])('%s 도 기다리지 않는다', async (afterTransfer) => {
    const { promise } = deferred();
    const result = await executeBuiltinTool(
      'transfer_call',
      { to: '010', after_transfer: afterTransfer },
      callWith(() => promise),
    );
    expect(JSON.parse(result!).status).toBe('transfer_initiated');
  });
});

describe('waitForTransferResult', () => {
  it('연결이 끊기면 대기를 접는다', async () => {
    const { promise } = deferred();
    const body = JSON.parse(await waitForTransferResult(promise, Promise.resolve()));
    expect(body.status).toBe('unknown');
  });
});

describe('waitForTransferResult 거절', () => {
  it('끊긴 틈에 부른 전환의 거절은 unknown 이 아니라 실패로 나간다', async () => {
    const rejected = (async () => {
      await (async () => {
        throw new Error('transfer 불가');
      })();
      return {};
    })();
    await expect(waitForTransferResult(rejected, Promise.resolve())).rejects.toThrow('transfer 불가');
  });
});

describe('LiveKit transfer_call 끼어들기', () => {
  function tool() {
    const llm = {
      ToolFlag: { IGNORE_ON_ENTER: 1 },
      tool: (t: unknown) => t,
      Toolset: { create: (t: unknown) => t },
    };
    const phone = createClawOpsPhoneTools(llm, { enabled: new Set([BuiltinTool.TRANSFER_CALL]) });
    return phone as unknown as {
      setCall(c: CallSession): void;
      toolset: { tools: { execute(a: unknown, o?: unknown): Promise<string> }[] };
    };
  }

  function ctx() {
    const speechHandle = { allowInterruptions: true };
    return {
      speechHandle,
      disallowInterruptions: vi.fn(() => { speechHandle.allowInterruptions = false; }),
    };
  }

  it('return 은 기다리는 동안 막고 끝나면 되돌린다', async () => {
    const { promise, resolve } = deferred();
    const phone = tool();
    phone.setCall(callWith(() => promise));
    const c = ctx();
    const run = phone.toolset.tools[0]!.execute({ to: '010', after_transfer: 'return' }, { ctx: c });
    await new Promise((r) => setTimeout(r, 5));
    expect(c.speechHandle.allowInterruptions).toBe(false);
    resolve({ status: 'no-answer' });
    expect(JSON.parse(await run).status).toBe('no-answer');
    expect(c.speechHandle.allowInterruptions).toBe(true);
  });

  it('연결이 끊기면 대기를 접고 끼어들기를 되돌린다', async () => {
    const { promise } = deferred();
    const phone = tool();
    const cancel = vi.fn();
    const call = callWith(() => promise);
    call._transferConnectionLost = () => ({ promise: Promise.resolve(), cancel });
    phone.setCall(call);
    const c = ctx();
    const body = JSON.parse(await phone.toolset.tools[0]!.execute({ to: '010', after_transfer: 'return' }, { ctx: c }));
    expect(body.status).toBe('unknown');
    expect(c.speechHandle.allowInterruptions).toBe(true);
    expect(cancel).toHaveBeenCalled();
  });

  it('요청 실패는 모델에게 간다', async () => {
    const phone = tool();
    phone.setCall(callWith(() => Promise.reject(new Error('boom'))));
    const result = await phone.toolset.tools[0]!.execute({ to: '010', after_transfer: 'return' }, { ctx: ctx() });
    expect(result).toBe('Error: boom');
  });

  it('고객이 끊었으면 모델 응답을 만들지 않는다', async () => {
    class StopResponse extends Error {}
    const llm = {
      ToolFlag: { IGNORE_ON_ENTER: 1 },
      tool: (t: unknown) => t,
      Toolset: { create: (t: unknown) => t },
    };
    const phone = createClawOpsPhoneTools(llm, {
      enabled: new Set([BuiltinTool.TRANSFER_CALL]),
      StopResponse,
    });
    phone.setCall(callWith(() => Promise.resolve({ status: 'canceled' })));
    const tools = (phone.toolset as { tools: { execute(a: unknown, o?: unknown): Promise<string> }[] }).tools;
    await expect(tools[0]!.execute({ to: '010', after_transfer: 'return' }, { ctx: ctx() })).rejects.toBeInstanceOf(StopResponse);
  });

  it('terminate 는 건드리지 않는다', async () => {
    const phone = tool();
    phone.setCall(callWith(() => Promise.resolve({})));
    const c = ctx();
    await phone.toolset.tools[0]!.execute({ to: '010' }, { ctx: c });
    expect(c.disallowInterruptions).not.toHaveBeenCalled();
  });
});
