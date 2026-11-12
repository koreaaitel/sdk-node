import { describe, it, expect, vi } from 'vitest';

import {
  createClawOpsPhoneTools,
  HANG_UP_FAREWELL_PROMPT,
} from '../../src/agent/livekit/toolset.js';
import { BuiltinTool } from '../../src/agent/builtin-tool.js';

/** 가짜 `@livekit/agents` `llm` 네임스페이스 — tool/Toolset/ToolFlag 만 흉내낸다. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeLlm() {
  return {
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
    /** RunContext 중 hang_up 이 쓰는 것만. `spoke` 면 이 턴에 에이전트가 말한 문장이 있다. */
    function fakeCtx(opts: { spoke?: boolean; interrupted?: boolean } = {}) {
      let playedStep!: () => void;
      let turnDone!: () => void;
      const stepPlayed = new Promise<void>((r) => (playedStep = r));
      const doneCbs: Array<() => void> = [];
      const speechHandle = {
        allowInterruptions: true,
        chatItems: opts.spoke
          ? [{ type: 'message', role: 'assistant', textContent: '감사합니다. 좋은 하루 보내세요.' }]
          : [],
        addDoneCallback: (cb: () => void) => doneCbs.push(cb),
      };
      turnDone = () => doneCbs.forEach((cb) => cb());
      const ctx = {
        speechHandle,
        disallowInterruptions: () => {
          if (opts.interrupted) throw new Error('already interrupted');
          speechHandle.allowInterruptions = false;
        },
        waitForPlayout: () => stepPlayed,
      };
      return { ctx, playedStep, turnDone: () => turnDone() };
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
  });
});
