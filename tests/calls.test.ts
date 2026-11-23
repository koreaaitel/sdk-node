import { describe, it, expect, vi } from 'vitest';
import { ClawOps } from '../src/client.js';

function createClient(mockFetch: typeof fetch, maxRetries = 0) {
  return new ClawOps({
    apiKey: 'sk_test',
    accountId: 'AC_test',
    fetch: mockFetch,
    baseURL: 'http://localhost:3000',
    maxRetries,
  });
}

function mockResponse(body: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

const sampleCall = {
  callId: 'CA_123',
  status: 'queued',
  to: '+15551234567',
  from: '+15559876543',
  direction: 'outbound',
  duration: null,
  accountId: 'AC_test',
  dateCreated: '2024-01-01T00:00:00Z',
  dateUpdated: null,
};

describe('Calls resource', () => {
  describe('create', () => {
    it('sends POST with PascalCase body', async () => {
      const fetchFn = mockResponse(sampleCall);
      const client = createClient(fetchFn);

      const result = await client.calls.create({
        to: '+15551234567',
        from: '+15559876543',
        url: 'https://example.com/twiml',
      });

      expect(fetchFn).toHaveBeenCalledOnce();
      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('POST');
      expect(url).toContain('/v1/accounts/AC_test/calls');

      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({
        To: '+15551234567',
        From: '+15559876543',
        Url: 'https://example.com/twiml',
      });

      expect(result.callId).toBe('CA_123');
    });

    it('sends AgentId and omits mutually exclusive routing fields', async () => {
      const fetchFn = mockResponse(sampleCall);
      const client = createClient(fetchFn);

      await client.calls.create({
        to: '+15551234567',
        from: '+15559876543',
        agentId: 'cmagent123',
      });

      const [, init] = fetchFn.mock.calls[0];
      const body = JSON.parse(init!.body as string);
      // 배타 필드는 보내지 않은 채로 남아야 한다 — 빈 값이라도 실리면 서버가 400 으로 막는다.
      expect(body).toEqual({
        To: '+15551234567',
        From: '+15559876543',
        AgentId: 'cmagent123',
      });
    });

    it('uses shared 010 and an SDK agent ID without sending From', async () => {
      const from = '01055551234';
      const fetchFn = mockResponse({ ...sampleCall, from, presentedFrom: from }, 201);
      const client = createClient(fetchFn);

      const call = await client.calls.create({
        to: '01099998888',
        sdkAgentId: 'outbound-agent',
        callerIdMode: 'shared-010',
      });

      const [, init] = fetchFn.mock.calls[0];
      expect(JSON.parse(init!.body as string)).toEqual({
        To: '01099998888',
        SdkAgentId: 'outbound-agent',
        CallerIdMode: 'shared-010',
      });
      expect(call.from).toBe(from);
      expect(call.presentedFrom).toBe(from);
    });

    it('does not retry shared-010 creation if the network drops the response', async () => {
      const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network error'));
      const client = createClient(fetchFn, 2);

      await expect(client.calls.create({
        to: '01099998888',
        sdkAgentId: 'outbound-agent',
        callerIdMode: 'shared-010',
      })).rejects.toThrow();

      expect(fetchFn).toHaveBeenCalledOnce();
    });

    it('does not retry a shared-010 service error and retains retries for ordinary calls', async () => {
      const fetchFn = mockResponse({ error: 'originate outcome uncertain' }, 503);
      const client = createClient(fetchFn, 2);

      await expect(client.calls.create({
        to: '01099998888',
        from: '07012341234',
        callerIdMode: 'shared-010',
      })).rejects.toMatchObject({ status: 503 });
      expect(fetchFn).toHaveBeenCalledOnce();

      fetchFn.mockReset();
      fetchFn.mockResolvedValueOnce(new Response('Service unavailable', { status: 503 }));
      fetchFn.mockResolvedValueOnce(new Response(JSON.stringify(sampleCall), { status: 201 }));
      await expect(client.calls.create({
        to: '01099998888',
        from: '07012341234',
      })).resolves.toMatchObject({ callId: sampleCall.callId });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('converts callContext to PascalCase', async () => {
      // 서버 스펙이 CallContext 에 additionalProperties:false 라, camelCase 를 그대로
      // 흘려보내면 400 이 난다. 변환이 빠지면 이 테스트가 먼저 깨진다.
      const fetchFn = mockResponse(sampleCall);
      const client = createClient(fetchFn);

      await client.calls.create({
        to: '+15551234567',
        from: '+15559876543',
        agentId: 'cmagent123',
        callContext: {
          instruction: '예약 확인만 하고 끊어라',
          variables: { orderId: 'A-1234' },
        },
      });

      const [, init] = fetchFn.mock.calls[0];
      const body = JSON.parse(init!.body as string);
      expect(body.CallContext).toEqual({
        Instruction: '예약 확인만 하고 끊어라',
        Variables: { orderId: 'A-1234' },
      });
    });

    it('omits Variables when callContext has none', async () => {
      const fetchFn = mockResponse(sampleCall);
      const client = createClient(fetchFn);

      await client.calls.create({
        to: '+15551234567',
        from: '+15559876543',
        agentId: 'cmagent123',
        callContext: { instruction: '본인확인만 하라' },
      });

      const [, init] = fetchFn.mock.calls[0];
      const body = JSON.parse(init!.body as string);
      expect(body.CallContext).toEqual({ Instruction: '본인확인만 하라' });
    });

    it('sends CallFlowId with start Variables', async () => {
      const fetchFn = mockResponse(sampleCall);
      const client = createClient(fetchFn);

      await client.calls.create({
        to: '+15551234567',
        from: '+15559876543',
        callFlowId: 'cmryw3ycm000001s6on0kp9a8',
        variables: { name: '홍길동', orderId: 'A-1234' },
      });

      const [, init] = fetchFn.mock.calls[0];
      const body = JSON.parse(init!.body as string);
      expect(body.CallFlowId).toBe('cmryw3ycm000001s6on0kp9a8');
      expect(body.Variables).toEqual({ name: '홍길동', orderId: 'A-1234' });
    });

    it('sends no routing field in Agent SDK mode', async () => {
      const fetchFn = mockResponse(sampleCall);
      const client = createClient(fetchFn);

      await client.calls.create({ to: '+15551234567', from: '+15559876543' });

      const [, init] = fetchFn.mock.calls[0];
      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({ To: '+15551234567', From: '+15559876543' });
    });

    it('includes optional StatusCallback and StatusCallbackEvent', async () => {
      const fetchFn = mockResponse(sampleCall);
      const client = createClient(fetchFn);

      await client.calls.create({
        to: '+15551234567',
        from: '+15559876543',
        url: 'https://example.com/twiml',
        statusCallback: 'https://example.com/status',
        statusCallbackEvent: 'completed',
      });

      const [, init] = fetchFn.mock.calls[0];
      const body = JSON.parse(init!.body as string);
      expect(body.StatusCallback).toBe('https://example.com/status');
      expect(body.StatusCallbackEvent).toBe('completed');
    });

    it('strips undefined optional fields', async () => {
      const fetchFn = mockResponse(sampleCall);
      const client = createClient(fetchFn);

      await client.calls.create({
        to: '+15551234567',
        from: '+15559876543',
        url: 'https://example.com/twiml',
        statusCallback: undefined,
      });

      const [, init] = fetchFn.mock.calls[0];
      const body = JSON.parse(init!.body as string);
      expect(body).not.toHaveProperty('StatusCallback');
    });
  });

  describe('list', () => {
    it('sends GET with query params', async () => {
      const listResponse = {
        data: [sampleCall],
        meta: { total: 1, page: 0, pageSize: 20 },
      };
      const fetchFn = mockResponse(listResponse);
      const client = createClient(fetchFn);

      const page = await client.calls.list({ status: 'queued', page: 0, pageSize: 20 });

      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('GET');
      expect(url).toContain('/v1/accounts/AC_test/calls');
      expect(url).toContain('status=queued');
      expect(url).toContain('page=0');
      expect(url).toContain('pageSize=20');

      expect(page.data).toHaveLength(1);
      expect(page.data[0].callId).toBe('CA_123');
    });

    it('sends GET without query params when none provided', async () => {
      const listResponse = {
        data: [sampleCall],
        meta: { total: 1, page: 0, pageSize: 20 },
      };
      const fetchFn = mockResponse(listResponse);
      const client = createClient(fetchFn);

      const page = await client.calls.list();

      const [url] = fetchFn.mock.calls[0];
      expect(url).toBe('http://localhost:3000/v1/accounts/AC_test/calls');
    });

    it('returns a Page with pagination metadata', async () => {
      const listResponse = {
        data: [sampleCall],
        meta: { total: 50, page: 0, pageSize: 20 },
      };
      const fetchFn = mockResponse(listResponse);
      const client = createClient(fetchFn);

      const page = await client.calls.list();
      expect(page.meta.total).toBe(50);
      expect(page.meta.page).toBe(0);
      expect(page.meta.pageSize).toBe(20);
      expect(page.hasNextPage()).toBe(true);
    });
  });

  describe('get', () => {
    it('sends GET to correct path with callId', async () => {
      const fetchFn = mockResponse(sampleCall);
      const client = createClient(fetchFn);

      const result = await client.calls.get('CA_123');

      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('GET');
      expect(url).toBe('http://localhost:3000/v1/accounts/AC_test/calls/CA_123');
      expect(result.callId).toBe('CA_123');
      expect(result.to).toBe('+15551234567');
    });
  });

  describe('update', () => {
    it('sends POST with Status: completed', async () => {
      const updateResponse = { callId: 'CA_123', status: 'completed' };
      const fetchFn = mockResponse(updateResponse);
      const client = createClient(fetchFn);

      const result = await client.calls.update('CA_123', { status: 'completed' });

      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('POST');
      expect(url).toContain('/v1/accounts/AC_test/calls/CA_123');

      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({ Status: 'completed' });
      expect(result.callId).toBe('CA_123');
      expect(result.status).toBe('completed');
    });

    it('defaults to status completed when no params given', async () => {
      const updateResponse = { callId: 'CA_123', status: 'completed' };
      const fetchFn = mockResponse(updateResponse);
      const client = createClient(fetchFn);

      await client.calls.update('CA_123');

      const [, init] = fetchFn.mock.calls[0];
      const body = JSON.parse(init!.body as string);
      expect(body.Status).toBe('completed');
    });
  });

  describe('getTranscript', () => {
    it('returns completed with segments', async () => {
      const body = {
        status: 'completed',
        callId: 'CA_123',
        segmentCount: 2,
        segments: [
          { speaker: 'AGENT', start: 0, end: 1.2, text: '안녕하세요.' },
          { speaker: 'CUSTOMER', start: 1.5, end: 2.8, text: '네.' },
        ],
      };
      const fetchFn = mockResponse(body);
      const client = createClient(fetchFn);

      const r = await client.calls.getTranscript('CA_123');

      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('GET');
      expect(url).toBe('http://localhost:3000/v1/accounts/AC_test/calls/CA_123/transcript');
      expect(r.status).toBe('completed');
      expect(r.segmentCount).toBe(2);
      expect(r.segments?.[0].speaker).toBe('AGENT');
    });

    // 회귀: 2026-08 이후 전사는 `speaker_0`·`speaker_1`… 을 보내는데 speaker 가 닫힌 enum 이라
    // **최근 전사가 전부** 던지고 있었다. segments 는 배열이라 한 조각이 응답 전체를 죽인다.
    it('speaker_N 형식과 옛 AGENT/CUSTOMER 가 한 응답에 섞여도 파싱한다', async () => {
      const body = {
        status: 'completed',
        callId: 'CA_123',
        segmentCount: 3,
        segments: [
          { speaker: 'speaker_0', start: 0, end: 1.2, text: '안녕하세요.' },
          { speaker: 'speaker_1', start: 1.5, end: 2.8, text: '네.' },
          { speaker: 'AGENT', start: 3, end: 4, text: '옛 전사입니다.' },
        ],
      };
      const client = createClient(mockResponse(body));

      const r = await client.calls.getTranscript('CA_123');

      expect(r.segments?.map((s) => s.speaker)).toEqual(['speaker_0', 'speaker_1', 'AGENT']);
    });

    it('returns pending with startedAt', async () => {
      const body = { status: 'pending', startedAt: '2026-04-23T08:33:00Z' };
      const fetchFn = mockResponse(body);
      const client = createClient(fetchFn);

      const r = await client.calls.getTranscript('CA_123');
      expect(r.status).toBe('pending');
      expect(r.startedAt).toBe('2026-04-23T08:33:00Z');
    });

    // 회귀: 전사 파이프라인은 `transcription`·`recover` 도 내보내고, 영구 실패는 예외 객체의
    // 속성을 그대로 싣는다. 닫힌 enum 이던 시절 **실패 이유를 물으면 던졌다.**
    it('아는 단계 밖의 stage 도 파싱한다', async () => {
      const client = createClient(
        mockResponse({ status: 'failed', stage: 'transcription', error: 'transcription_failed' }),
      );
      expect((await client.calls.getTranscript('CA_123')).stage).toBe('transcription');
    });

    it('returns failed with stage and error', async () => {
      const body = { status: 'failed', stage: 'runtime', error: 'boom' };
      const fetchFn = mockResponse(body);
      const client = createClient(fetchFn);

      const r = await client.calls.getTranscript('CA_123');
      expect(r.status).toBe('failed');
      expect(r.stage).toBe('runtime');
      expect(r.error).toBe('boom');
    });

    it('returns not_requested', async () => {
      const body = { status: 'not_requested' };
      const fetchFn = mockResponse(body);
      const client = createClient(fetchFn);

      const r = await client.calls.getTranscript('CA_123');
      expect(r.status).toBe('not_requested');
    });
  });

  describe('requestTranscript', () => {
    it('sends POST with no body and returns 202 shape', async () => {
      const body = { status: 'pending', callId: 'CA_123' };
      const fetchFn = mockResponse(body, 202);
      const client = createClient(fetchFn);

      const r = await client.calls.requestTranscript('CA_123');

      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('POST');
      expect(url).toBe('http://localhost:3000/v1/accounts/AC_test/calls/CA_123/transcript');
      expect(r.status).toBe('pending');
      expect(r.callId).toBe('CA_123');
    });
  });
});
