/**
 * LiveKit 내장 `transfer_call` 도구가 모델에게 돌려주는 값. Python SDK `_transfer_tool.py` 와 문구를 맞춘다.
 *
 * `afterTransfer: 'return'` 은 전환이 끝나면 AI 가 통화로 돌아온다. 그때 모델이 결과를 모르면 담당자가
 * 받지 않았는데도 사정을 모른 채 대화를 잇는다. `terminate` 는 서버가 미디어 세션을 닫으므로 기다릴 수 없다.
 * 자체 realtime 세션은 끼어들기가 도구를 버리므로 기다리지 않는다(`pipeline/builtin-tool-schemas.ts`).
 */

const RESUME = ' The caller is on the line with you again. Tell them and continue the conversation.';
const FAILED_MESSAGES: Record<string, string> = {
  'no-answer': `The transfer target did not answer.${RESUME}`,
  busy: `The transfer target was busy.${RESUME}`,
};
const RESULT_UNKNOWN = JSON.stringify({
  status: 'unknown',
  message: 'The transfer result is unavailable. If the caller speaks, continue the conversation.',
});

export function transferResultForModel(result: Record<string, unknown>): string {
  const status = (result['status'] as string | undefined) || 'failed';
  let message: string;
  if (status === 'completed') {
    message =
      'The transfer target finished the call and the caller is on the line with you again. Ask whether they need anything else.';
  } else if (status === 'canceled') {
    message = 'The caller hung up. The call is over.';
  } else {
    message = FAILED_MESSAGES[status] ?? `The transfer could not be connected.${RESUME}`;
  }
  return JSON.stringify({ status, message });
}

/** 고객이 끊어 통화가 끝났을 때의 도구 결과. */
export const CALL_OVER = transferResultForModel({ status: 'canceled' });

/**
 * 전환 결과를 기다려 도구 결과로 돌려준다.
 *
 * 결과 이벤트는 재전송되지 않아 control 연결이 끊긴 틈에 오면 사라진다. 그대로 기다리면 끼어들기가 막힌
 * 채 통화 끝까지 멈추므로, 연결이 끊기면 대기를 접고 모른다고 알린다.
 */
export async function waitForTransferResult(
  transfer: Promise<Record<string, unknown>>,
  connectionLost?: Promise<void>,
): Promise<string> {
  if (!connectionLost) return transferResultForModel(await transfer);
  // 한 박자 늦춘다. 끊긴 틈에 부르면 connectionLost 는 이미 풀려 있고 전환은 곧 거절되는데, 그 거절이
  // 모델에게 가야 한다 — 요청이 나가지 않았는데 「결과를 모른다」고 하면 틀린 말이다.
  const lost = connectionLost
    .then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    .then(() => null);
  const result = await Promise.race([transfer, lost]);
  return result === null ? RESULT_UNKNOWN : transferResultForModel(result);
}
