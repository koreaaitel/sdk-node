import { ClawOps } from '../../src/index.js';
import type {
  Call,
  CallCreateParams,
  CallCreateRequest,
  NumberlessCallCreateParams,
  OutboundCallerIdMode,
  Shared010CallCreateParams,
} from '../../src/index.js';
import { ClawOpsAgent } from '../../src/agent/index.js';
import type { ClawOpsAgentOptions, NumberlessClawOpsAgentOptions } from '../../src/agent/index.js';

declare const client: ClawOps;
declare const session: ClawOpsAgentOptions['session'];
declare const optionalMode: OutboundCallerIdMode | undefined;
declare const originalParams: CallCreateParams;
declare const callParams: CallCreateParams | Shared010CallCreateParams;
declare const createRequest: CallCreateRequest;
declare const agentOptions: ClawOpsAgentOptions | NumberlessClawOpsAgentOptions;

const to = '01099998888';
const from = '07012341234';
const sdkAgentId = 'reservation-outbound';
const agentId = 'AG123';
const callFlowId = 'FLOW123';
const url = 'https://example.com/voice';
const callerIdMode = 'shared-010';
const callContext = { instruction: '예약을 확인합니다.' };
const variables = { bookingId: 'B-123' };
const legacyCreate: Promise<Call> = client.calls.create(originalParams);
void legacyCreate;
void client.calls.create(callParams);
void client.calls.create(createRequest);

// The legacy interface remains usable by applications that add their own fields.
interface AppCall extends CallCreateParams {
  bookingId: string;
}
declare const appCall: AppCall;
void client.calls.create(appCall);

void client.calls.create({ to, from });
void client.calls.create({ to, from, callerIdMode: optionalMode });
void client.calls.create({ to, from, agentId, callerIdMode: optionalMode, callContext });
void client.calls.create({ to, from, url, callerIdMode: optionalMode });
void client.calls.create({ to, from, callFlowId, callerIdMode: optionalMode, variables });
void client.calls.create({ to, from, callFlowId, variables });
void client.calls.create({ to, from, callerIdMode });
void client.calls.create({ to, from, callerIdMode, url });
void client.calls.create({ to, from, callerIdMode, agentId, callContext });
void client.calls.create({ to, from, callerIdMode, callFlowId, variables });

const numberlessManaged = { to, callerIdMode, agentId, callContext } satisfies NumberlessCallCreateParams;
void client.calls.create(numberlessManaged);
void client.calls.create({ to, callerIdMode, sdkAgentId });
void client.calls.create({ to, callerIdMode, url });
void client.calls.create({ to, callerIdMode, callFlowId, variables });
declare const target: { sdkAgentId: string } | { callFlowId: string; variables: typeof variables };
void client.calls.create({ to, callerIdMode, ...target });

// @ts-expect-error Ordinary calls require a From number.
void client.calls.create({ to, agentId });
// @ts-expect-error SDK agent IDs are supported only in shared 010 mode.
void client.calls.create({ to, sdkAgentId });
// @ts-expect-error Numberless shared 010 requests require a routing target.
void client.calls.create({ to, callerIdMode });
// @ts-expect-error Undefined route fields do not specify a target.
void client.calls.create({ to, callerIdMode, sdkAgentId: undefined, url: undefined });
// @ts-expect-error SdkAgentId and From identify mutually exclusive SDK connections.
void client.calls.create({ to, from, callerIdMode, sdkAgentId });
const duplicateTargets = { to, callerIdMode, sdkAgentId, agentId };
// @ts-expect-error A named request value also rejects multiple targets.
void client.calls.create(duplicateTargets);
// @ts-expect-error A request with From still permits only one shared 010 target.
void client.calls.create({ to, from, callerIdMode, url, callFlowId });
// @ts-expect-error A runtime mode switch requires a target valid in either mode.
void client.calls.create({ to, from, callerIdMode: optionalMode, url, callFlowId });
// @ts-expect-error CallContext requires a managed agent.
void client.calls.create({ to, callerIdMode, sdkAgentId, callContext });
// @ts-expect-error CallContext requires a managed agent, including when From is present.
void client.calls.create({ to, from, callerIdMode, callFlowId, callContext });
// @ts-expect-error Start variables require a call flow.
void client.calls.create({ to, callerIdMode, agentId, variables });
// @ts-expect-error Start variables require a call flow, including when From is present.
void client.calls.create({ to, from, callerIdMode, url, variables });

const numberLinkedAgent = new ClawOpsAgent({ session, from });
const numberlessAgent = new ClawOpsAgent({ session, sdkAgentId });
new ClawOpsAgent(agentOptions);
void numberLinkedAgent.call(to);
void numberLinkedAgent.call(to, { callerIdMode });
void numberlessAgent.call(to);
// @ts-expect-error First-leg caller ID mode is distinct from a transfer's caller ID mode.
void numberLinkedAgent.call(to, { callerIdMode: 'original' });
// @ts-expect-error An agent constructor requires a connection identity.
new ClawOpsAgent({ session });
const mixedAgentOptions = { session, from, sdkAgentId };
// @ts-expect-error From and sdkAgentId identify mutually exclusive connection types.
new ClawOpsAgent(mixedAgentOptions);
