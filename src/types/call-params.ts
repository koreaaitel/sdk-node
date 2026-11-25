// ── Call API 파라미터 ────────────────────────────────────────────────────────

/**
 * `agentId` 에이전트의 **이번 통화에만** 적용되는 컨텍스트.
 *
 * 에이전트 자체의 설정은 그대로 두고 이 통화만 다르게 행동시킬 때 사용한다.
 * 같은 에이전트로 동시에 거는 다른 통화에는 영향이 없다.
 */
export interface CallContextParam {
  /** 이번 통화에서 수행할 실행 요구사항 (최대 4000자). */
  instruction: string;
  /** 요구사항에서 참조할 통화별 구조화 데이터 (최대 50개). */
  variables?: Record<string, string | number | boolean>;
}

/** 최초 발신에서 사용할 발신번호 선택 방식. */
export type OutboundCallerIdMode = 'shared-010';

interface CallCreateCommonParams {
  to: string;
  statusCallback?: string;
  statusCallbackEvent?: string;
  /** 발신 타임아웃 (초). 기본값: 60. */
  timeout?: number;
  /**
   * 자동응답기/음성사서함 감지(AMD). `'Enable'`=감지 후 `AnsweredBy` 통보(통화 계속),
   * `'Hangup'`=음성사서함 감지 시 자동 종료. 미설정 시 비활성.
   */
  machineDetection?: 'Enable' | 'Hangup';
}

/**
 * 일반 발신 전화 생성 요청 파라미터.
 *
 * **4가지 모드** — `url`, `agentId`, `callFlowId` 는 서로 배타적이다.
 *
 * - **VoiceML 모드**: `url` 을 지정하면 VoiceML 로 통화를 제어한다.
 * - **매니지드 에이전트 모드**: `agentId` 를 지정하면 콘솔에서 만든 AI 에이전트가
 *   통화를 처리한다. `callContext` 로 이번 통화만의 지시를 덧붙일 수 있다.
 * - **콜 플로우 모드**: `callFlowId` 를 지정하면 결정적 ARS 플로우가 진행한다.
 *   `variables` 로 시작 변수를 넘긴다.
 * - **Agent SDK 모드**: 셋 다 생략하면 From 번호에 연결된 Agent SDK 로 연결된다.
 */
export interface CallCreateParams extends CallCreateCommonParams {
  from: string;
  callerIdMode?: undefined;
  sdkAgentId?: never;
  /** VoiceML 명령을 반환할 URL. `agentId`·`callFlowId` 와 배타. */
  url?: string;
  /** 콘솔에서 만든 매니지드 에이전트 ID. `url`·`callFlowId` 와 배타. */
  agentId?: string;
  /** `agentId` 에이전트의 이번 통화에만 적용되는 컨텍스트. */
  callContext?: CallContextParam;
  /** 콜 플로우(결정적 ARS) ID. `url`·`agentId` 와 배타. */
  callFlowId?: string;
  /**
   * 콜 플로우 시작 변수. 멘트·URL·본문의 `{{이름}}` 이 이 값으로 치환된다.
   * `callFlowId` 와 함께일 때만 쓸 수 있다(단독 지정 시 400).
   * `caller`·`callee`·`recording_url`·`recording_duration`·`http_status` 는
   * 통화 중 자동으로 채워지는 예약 변수라 지정할 수 없다.
   */
  variables?: Record<string, string | number | boolean>;
}

type ExplicitCallTarget =
  | {
      url: string;
      agentId?: never;
      callFlowId?: never;
      sdkAgentId?: never;
      callContext?: never;
      variables?: never;
    }
  | {
      url?: never;
      agentId: string;
      callFlowId?: never;
      sdkAgentId?: never;
      /** 지정한 매니지드 에이전트의 이번 통화에만 적용합니다. */
      callContext?: CallContextParam;
      variables?: never;
    }
  | {
      url?: never;
      agentId?: never;
      callFlowId: string;
      sdkAgentId?: never;
      callContext?: never;
      /** 지정한 콜 플로우의 시작 변수입니다. */
      variables?: CallCreateParams['variables'];
    };

type SdkCallTarget = {
  url?: never;
  agentId?: never;
  callFlowId?: never;
  callContext?: never;
  variables?: never;
};

type NumberLinkedCallTarget = ExplicitCallTarget | (SdkCallTarget & { sdkAgentId?: never });

type Shared010CallBase = CallCreateCommonParams & {
  /** 서버가 이번 통화에 사용할 공용 010 회선을 선택합니다. */
  callerIdMode: OutboundCallerIdMode;
};

/**
 * 보유 번호 없이 공용 010으로 발신합니다. 통화를 처리할 대상 하나를 지정합니다.
 * `sdkAgentId` 는 같은 계정에서 번호 없이 연결된 SDK 에이전트의 ID입니다.
 */
export type NumberlessCallCreateParams = Shared010CallBase & {
  from?: never;
} & (ExplicitCallTarget | (SdkCallTarget & { sdkAgentId: string }));

/**
 * 공용 010 발신. 보유 번호를 지정한 요청은 그 번호에 연결된 SDK로 통화를 처리할 수 있습니다.
 */
export type Shared010CallCreateParams =
  | NumberlessCallCreateParams
  | (Shared010CallBase & { from: string } & NumberLinkedCallTarget);

/**
 * `client.calls.create()` 요청입니다. `from`을 지정한 경우 발신 방식을 런타임에 선택할 수 있습니다.
 */
export type CallCreateRequest =
  | CallCreateParams
  | NumberlessCallCreateParams
  | (CallCreateCommonParams & {
      from: string;
      callerIdMode?: OutboundCallerIdMode | undefined;
    } & NumberLinkedCallTarget);

export interface CallListParams {
  status?: 'queued' | 'ringing' | 'in-progress' | 'completed' | 'failed';
  /** 발신번호로 필터링. 배열 시 IN 조건. */
  from?: string | string[];
  /** 수신번호로 필터링. 배열 시 IN 조건. */
  to?: string | string[];
  /** 관여 번호로 필터링 (from OR to 매칭). 배열 시 IN 조건. */
  number?: string | string[];
  page?: number;
  pageSize?: number;
}

export interface CallUpdateParams {
  status?: 'completed';
}
