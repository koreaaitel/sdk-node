# OpenAI Realtime 발신 미디어 재현

한국에이아이통신 Node.js SDK의 `ClawOpsAgent.call()`을 실행해 070 발신 제어와 OpenAI Realtime 미디어 연결을 확인합니다. 모의 서버가 발신 접수와 통화 이벤트를 보내면 SDK가 양방향 PCMU 음성을 전달하고 같은 통화를 종료합니다. 서버는 `127.0.0.1`에서 실행되며 예제용 키와 번호만 사용합니다. 검증 범위는 설치한 SDK와 모의 서버 사이입니다.

## 실행

Node.js 22.15 이상인 22.x 또는 Node.js 24 이상이 필요합니다. 모의 WebSocket 연결에는 [Node.js 모듈 훅](https://nodejs.org/download/release/v22.15.0/docs/api/module.html#moduleregisterhooksoptions)을 사용합니다.

저장소 루트에서 아래 명령을 실행합니다. 네트워크는 npm 패키지를 설치할 때 필요합니다.

```sh
cd examples/openai-realtime-outbound-replay
npm ci --ignore-scripts --no-audit --no-fund
env -i PATH="$PATH" node outbound-replay.mjs
```

결과 JSON에서 발신 응답 `post_calls`가 `201`이고 `audio_format`은 `PCMU`입니다. 서로 다른 합성 음성이 각 방향으로 160바이트씩 전달됩니다. `same_call_completed`와 `media_and_model_sockets_closed`가 모두 `true`이면 같은 통화의 완료 이벤트와 양쪽 미디어 소켓 종료가 확인된 것입니다. 패키지는 `@koreaaitel/sdk@0.63.0`과 `ws@8.18.3`으로 고정합니다.

실제 번호와 API 인증을 설정하는 방법은 [한국에이아이통신 시작하기](https://platform.koreaaitel.com/docs/getting-started)에서 확인하세요.
