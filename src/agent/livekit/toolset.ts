/**
 * ClawOps 전화 내장 도구를 LiveKit Toolset 으로 노출한다.
 *
 * `hang_up` / `collect_dtmf` / `send_dtmf` / `transfer_call` — 스키마와 동작을
 * `pipeline/builtin-tool-schemas.ts` 에서 그대로 재사용한다 (핸들러 중복 없음).
 *
 * 설계 메모:
 * - LiveKit 이 파는 전화 도구(`end_call`/`send_dtmf`)는 room(`get_job_context()`)을
 *   잡아 room 없이는 죽으므로 쓰지 않는다. 패턴만 가져오고 실행은 우리 것을 쓴다.
 * - `CallSession` 은 클로저 상태로 들고 간다 (prewarm -> attach 시 setCall 로 교체).
 */

import type { BuiltinTool } from '../builtin-tool.js';
import {
  getBuiltinToolSchemas,
  executeBuiltinTool,
  transferOptionsFromArgs,
} from '../pipeline/builtin-tool-schemas.js';
import { CALL_OVER, waitForTransferResult } from '../transfer-tool.js';
import type { CallSession } from '../session.js';

/** 인사말 도중 모델이 통화를 끊거나 전환하는 사고를 막는다 (ToolFlag.IGNORE_ON_ENTER). */
const IGNORE_ON_ENTER_TOOLS = new Set(['hang_up', 'transfer_call']);

/** `hang_up` 이 작별 인사 재생을 기다리는 상한(ms). 재생 완료 신호가 안 와도 통화는 끊는다. */
export const HANG_UP_PLAYOUT_CAP_MS = 15_000;

/** 말 없이 `hang_up` 만 부른 응답에 돌려주는 도구 결과. LiveKit 은 이걸 받고 같은 턴에서 한 번 더 응답한다. */
export const HANG_UP_FAREWELL_PROMPT =
  '통화 종료가 예약되었습니다. 지금 상대에게 짧은 작별 인사 한 문장만 말하세요. ' +
  '질문하거나 새 이야기를 꺼내지 말고 도구도 부르지 마세요. 그 말이 끝나면 통화가 끊깁니다.';

/** `promise` 와 상한 중 먼저 끝나는 쪽을 기다린다. 대기가 실패해도 끊기는 해야 하니 던지지 않는다. */
async function waitCapped(promise: Promise<unknown>, capMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, capMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 이 턴(SpeechHandle)에서 에이전트가 실제로 말한 문장이 있었나. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function spokeThisTurn(speech: any): boolean {
  for (const item of speech?.chatItems ?? []) {
    if (item?.type === 'message' && item?.role === 'assistant' && (item.textContent ?? '').trim()) {
      return true;
    }
  }
  return false;
}

/**
 * 턴 전체(도구 뒤 후속 응답 포함)의 재생이 끝날 때까지 기다린다.
 *
 * ⚠️ `speech.waitForPlayout()` 은 쓰지 않는다 — 도구 안에서 띄운 비동기 작업도 AsyncLocalStorage 로
 * 「그 도구 안」으로 취급돼 순환 대기 오류를 던진다. `addDoneCallback` 은 그 검사가 없다.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function turnDone(speech: any): Promise<void> {
  return new Promise<void>((resolve) => speech.addDoneCallback(() => resolve()));
}

/**
 * 결과를 기다리는 전환 중 끼어들기가 일어나면 이어받을 때 할 말이 사라진다. 도구가 끝나면
 * 되돌린다 — 이어받는 발화는 끊을 수 있어야 한다.
 */
async function transferAndWait(
  args: Record<string, unknown>,
  call: CallSession,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx?: any,
): Promise<string> {
  const speech = ctx?.speechHandle;
  const allowedBefore = speech?.allowInterruptions;
  if (speech) ctx.disallowInterruptions?.();
  try {
    const transfer = call.transfer(args['to'] as string, transferOptionsFromArgs(args));
    const lost = call._transferConnectionLost?.();
    try {
      return await waitForTransferResult(transfer, lost?.promise);
    } finally {
      lost?.cancel();
    }
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    if (allowedBefore) speech.allowInterruptions = true;
  }
}

export interface ClawOpsPhoneTools {
  /** LiveKit Toolset 인스턴스 — `agent.updateTools([...])` 에 넣는 ToolContextEntry. */
  toolset: unknown;
  /** prewarm -> attach 시 실제 통화로 교체한다. */
  setCall(call: CallSession): void;
}

/**
 * ClawOps 통화 제어 도구 묶음을 만든다.
 *
 * @param llm  동적 로드한 `@livekit/agents` 의 `llm` 네임스페이스 (`tool`/`Toolset`/`ToolFlag`).
 * @param options.enabled       활성화할 내장 도구 (`ClawOpsAgent(builtinTools=...)` 와 동일).
 * @param options.excludeNames  유저/registry 도구와 이름이 겹쳐 제외할 내장 도구 이름.
 * @param options.StopResponse  `@livekit/agents` 의 `voice.StopResponse`. 끝난 통화에 응답을 안 만들 때 쓴다.
 */
export function createClawOpsPhoneTools(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  llm: any,
  options: { enabled: Set<BuiltinTool>; excludeNames?: Set<string>; StopResponse?: unknown },
): ClawOpsPhoneTools {
  const state: { call: CallSession | null; hungUp: boolean; deferred: Promise<void> | null } = {
    call: null,
    hungUp: false,
    deferred: null,
  };
  const requireCall = (): CallSession => {
    if (!state.call) {
      throw new Error('통화가 아직 연결되지 않았습니다');
    }
    return state.call;
  };

  const hangUpOnce = async (call: CallSession): Promise<void> => {
    if (state.hungUp) return;
    state.hungUp = true;
    await call.hangup();
  };

  /**
   * 작별 인사가 **다 재생된 뒤에** 끊는다. LiveKit 은 도구를 문장 음성 합성·재생과 동시에 돌리므로,
   * 바로 끊으면 인사가 합성 도중 잘린다.
   *
   * 1. 끼어들기를 막는다 — 맞장구가 인사를 끊으면 LiveKit 이 이 도구를 취소해 통화가 안 끝난다.
   *    이미 끼어들기가 일어났으면 끊지 않는다(발신자가 말을 이었다).
   * 2. `ctx.waitForPlayout()` 을 {@link HANG_UP_PLAYOUT_CAP_MS} 상한으로 기다린다 — 같은 응답에서 먼저 말한 인사.
   * 3. 이 턴에 말한 것이 있으면 끊고 결과 없이(`undefined`) 끝낸다 — 문자열을 돌려주면 닫히는 회선에 대고
   *    응답을 또 만든다.
   * 4. 말 없이 `hang_up` 만 부른 응답이면 끊지 않고 {@link HANG_UP_FAREWELL_PROMPT} 를 돌려준다. LiveKit 이
   *    같은 턴에서 만든 그 인사의 재생이 끝나면 뒤에서 끊는다(같은 상한).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hangUp = async (call: CallSession, ctx?: any): Promise<string | undefined> => {
    if (ctx) {
      try {
        ctx.disallowInterruptions?.();
      } catch {
        return '통화를 끊지 않았습니다. 발신자가 말을 이었습니다.';
      }
      if (typeof ctx.waitForPlayout === 'function') {
        await waitCapped(Promise.resolve().then(() => ctx.waitForPlayout()), HANG_UP_PLAYOUT_CAP_MS);
      }
      const speech = ctx.speechHandle;
      if (
        state.deferred === null &&
        typeof speech?.addDoneCallback === 'function' &&
        !spokeThisTurn(speech)
      ) {
        state.deferred = waitCapped(turnDone(speech), HANG_UP_PLAYOUT_CAP_MS)
          .then(() => hangUpOnce(call))
          .catch(() => undefined);
        return HANG_UP_FAREWELL_PROMPT;
      }
    }
    await hangUpOnce(call);
    // 결과 없음(undefined) = LiveKit 이 응답을 만들지 않는다(`replyRequired: toolOutput !== undefined`).
    // StopResponse 를 던져도 같지만 agents-js 는 그걸 「도구 실행 중 예외」 error 로그로 남긴다.
    return undefined;
  };

  const exclude = options.excludeNames ?? new Set<string>();
  const ignoreFlag = llm.ToolFlag?.IGNORE_ON_ENTER;

  // 활성화된 내장 도구의 정규 스키마(name/description/parameters)를 가져온다.
  const schemas = getBuiltinToolSchemas(options.enabled, 'chat') as Array<{
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;

  const tools: unknown[] = [];
  for (const schema of schemas) {
    const { name, description, parameters } = schema.function;
    if (exclude.has(name)) continue; // 유저/registry 도구와 충돌 — 내장 쪽을 뺀다.
    tools.push(
      llm.tool({
        name,
        description,
        parameters, // raw JSON schema (agents-js 가 JSONSchema7 을 그대로 받는다).
        flags: IGNORE_ON_ENTER_TOOLS.has(name) ? ignoreFlag : undefined,
        // raw schema tool 의 execute 는 파싱된 args 를 그대로 받는다.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (args: Record<string, unknown>, opts?: { ctx?: any }) => {
          if (name === 'transfer_call' && args?.['after_transfer'] === 'return') {
            const result = await transferAndWait(args, requireCall(), opts?.ctx);
            // 고객이 끊었다 — 들을 사람이 없으니 모델 응답을 만들지 않는다.
            if (result === CALL_OVER && typeof options.StopResponse === 'function') {
              throw new (options.StopResponse as new () => Error)();
            }
            return result;
          }
          if (name === 'hang_up') {
            return hangUp(requireCall(), opts?.ctx);
          }
          return (await executeBuiltinTool(name, args ?? {}, requireCall())) ?? '';
        },
      }),
    );
  }

  const toolset = llm.Toolset.create({ id: 'clawops_phone', tools });

  return {
    toolset,
    setCall: (call: CallSession) => {
      if (state.call !== call) {
        state.hungUp = false;
        state.deferred = null;
      }
      state.call = call;
    },
  };
}
