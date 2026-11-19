import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TypecastTTS,
  PipelineSession,
  type CallSession,
  type SpeechEvent,
} from '../../src/agent/index.js';
import { pcm16ToUlaw, resamplePcm16 } from '../../src/agent/audio.js';

const VOICE = 'tc_60e5426de8b95f1d3000d7b5';
const SAMPLE_RATE = 32_000;

function generatePcm(samples: number): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let offset = 0; offset < pcm.length; offset += 2) {
    pcm.writeInt16LE((offset % 500) * 50 - 15000, offset);
  }
  return pcm;
}

function wav(pcm: Buffer, rate = SAMPLE_RATE, dataSize = 0xffffffff): Buffer {
  // Include a padded non-audio chunk to exercise chunk parsing, not a fixed 44-byte skip.
  const header = Buffer.alloc(54);
  header.write('RIFF', 0);
  header.writeUInt32LE(0xffffffff, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('JUNK', 36);
  header.writeUInt32LE(1, 40);
  header[44] = 42;
  header.write('data', 46);
  header.writeUInt32LE(dataSize, 50);
  return Buffer.concat([header, pcm]);
}

function wavResponse(bytes: Buffer, chunkSize = bytes.length): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          controller.enqueue(bytes.subarray(offset, offset + chunkSize));
        }
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'audio/wav' } },
  );
}

async function collect(audio: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of audio) chunks.push(chunk);
  return chunks;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('TypecastTTS', () => {
  it('uses an env key and defaults to SSFM 3.1 Korean, trimming the voice ID', async () => {
    vi.stubEnv('TYPECAST_API_KEY', 'test-env-key');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(wavResponse(wav(generatePcm(100))));
    vi.stubGlobal('fetch', fetchMock);
    const tts = new TypecastTTS({ voice: ` ${VOICE} ` });
    await collect(tts.synthesize('안녕하세요'));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.typecast.ai/v1/text-to-speech/stream');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'X-API-KEY': 'test-env-key', 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      text: '안녕하세요',
      model: 'ssfm-v31',
      voice_id: VOICE,
      language: 'kor',
      output: { audio_format: 'wav' },
    });
  });

  it('fails at construction without a key and reports provider error status', async () => {
    vi.stubEnv('TYPECAST_API_KEY', undefined);
    expect(() => new TypecastTTS({ voice: VOICE })).toThrow('TYPECAST_API_KEY');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 402 }));
    vi.stubGlobal('fetch', fetchMock);
    const tts = new TypecastTTS({ voice: VOICE, apiKey: 'test-key' });
    await expect(tts.synthesize('안녕하세요').next()).rejects.toThrow('HTTP 402');
  });

  it.each([8000, 16000, 24000, 44_100, 11025])(
    'yields aligned %i Hz PCM with a single tail across fragmented WAV and text',
    async (sampleRate) => {
      const pcm = generatePcm(1097);
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => wavResponse(wav(pcm), 17));
      vi.stubGlobal('fetch', fetchMock);
      const tts = new TypecastTTS({
        voice: VOICE,
        apiKey: 'test-key',
        language: ' JPN ',
        speed: 1.15,
      });
      async function* text() {
        yield '첫 통화입니다. ';
        yield '이어서 안내해 드릴게요.';
      }
      const chunks = await collect(tts.synthesize(text(), { sampleRate }));
      expect(Buffer.concat(chunks)).toEqual(
        resamplePcm16(Buffer.concat([pcm, pcm]), SAMPLE_RATE, sampleRate),
      );
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks.slice(0, -1)) {
        expect((chunk.length * 25) % sampleRate).toBe(0);
      }
      expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toMatchObject({
        language: 'jpn',
        output: { audio_format: 'wav', audio_tempo: 1.15 },
      });
    },
  );

  it('splits text at the Typecast limit without splitting a Unicode code point', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => wavResponse(wav(generatePcm(80))));
    vi.stubGlobal('fetch', fetchMock);
    const tts = new TypecastTTS({ voice: VOICE, apiKey: 'test-key' });
    const text = '🎙'.repeat(2001);
    await collect(tts.synthesize(text));

    const segments = fetchMock.mock.calls.map(([, init]) => JSON.parse(init?.body as string).text);
    expect(segments).toEqual(['🎙'.repeat(2000), '🎙']);
  });

  it.each([
    wav(generatePcm(200), 24_000),
    wav(generatePcm(200), SAMPLE_RATE, 420),
    wav(Buffer.alloc(13)),
    wav(Buffer.alloc(0)),
    Buffer.from('not a wav response'),
  ])('rejects an invalid, empty, or truncated audio response', async (badWav) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(wavResponse(badWav, 17)));
    const tts = new TypecastTTS({ voice: VOICE, apiKey: 'test-key' });
    await expect(collect(tts.synthesize('안녕하세요'))).rejects.toThrow(/Typecast/);
  });

  it('stops at the advertised PCM data end even if WAV metadata follows it', async () => {
    const pcm = generatePcm(777);
    const stream = wav(Buffer.concat([pcm, Buffer.from('footer')]), SAMPLE_RATE, pcm.length);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(wavResponse(stream, 19)));
    const tts = new TypecastTTS({ voice: VOICE, apiKey: 'test-key' });
    expect(Buffer.concat(await collect(tts.synthesize('안녕하세요')))).toEqual(pcm);
  });

  it('allows a progressing long response and cancels a stalled body read', async () => {
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              stream = controller;
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
            },
          }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const tts = new TypecastTTS({ voice: VOICE, apiKey: 'test-key' });
    const audio = tts.synthesize('안녕하세요');
    const first = audio.next();
    await vi.advanceTimersByTimeAsync(20_000);
    stream.enqueue(wav(generatePcm(640)));
    expect((await first).value).toHaveLength(1280);

    const stalled = expect(audio.next()).rejects.toThrow('Typecast TTS response timed out');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await stalled;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('cancels its response body when the audio consumer returns early', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(wav(generatePcm(640)));
        },
        cancel,
      }),
    );
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response));
    const tts = new TypecastTTS({ voice: VOICE, apiKey: 'test-key' });
    const audio = tts.synthesize('안녕하세요', { sampleRate: 8000 });

    expect((await audio.next()).value).toHaveLength(320);
    await audio.return(undefined);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it('aborts a pending read when the caller interrupts a normal pipeline reply', async () => {
    let audioStarted!: () => void;
    const firstFrameSent = new Promise<void>((resolve) => {
      audioStarted = resolve;
    });
    const pcm = generatePcm(640);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
              controller.enqueue(wav(pcm));
            },
          }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const clearAudio = vi.fn();
    const sendAudio = vi.fn((_audio: Buffer) => audioStarted());
    const session = new PipelineSession({
      stt: {
        async *transcribe(): AsyncGenerator<SpeechEvent> {
          yield { type: 'final', transcript: '안녕하세요' };
          await firstFrameSent;
          yield { type: 'interim', transcript: '잠시만요' };
        },
      },
      llm: {
        async *generate() {
          yield { type: 'text', text: '무엇을 도와드릴까요?' };
        },
      },
      tts: new TypecastTTS({ voice: VOICE, apiKey: 'test-key' }),
      greeting: false,
    });

    await session.start({ clearAudio, sendAudio } as unknown as CallSession);
    try {
      await vi.waitFor(() => expect(clearAudio).toHaveBeenCalledOnce());
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(sendAudio).toHaveBeenCalledExactlyOnceWith(
        pcm16ToUlaw(resamplePcm16(pcm, 32_000, 8000)),
      );
    } finally {
      await session.stop();
    }
  });
});
