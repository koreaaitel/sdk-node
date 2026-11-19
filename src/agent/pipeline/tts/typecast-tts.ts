import { resamplePcm16 } from '../../audio.js';
import type { TTS } from '../base.js';

const TYPECAST_URL = 'https://api.typecast.ai/v1/text-to-speech/stream';
const SOURCE_SAMPLE_RATE = 32000;
const MAX_TEXT_LENGTH = 2000;
const MAX_WAV_HEADER_BYTES = 64 * 1024;
const NETWORK_TIMEOUT_MS = 30_000;
const STREAMING_WAV_SIZE = 0xffffffff;

const LANGUAGE_CODES: Record<string, string> = {
  ko: 'kor',
  en: 'eng',
  ja: 'jpn',
  zh: 'zho',
};

export interface TypecastTTSOptions {
  /** A Typecast voice ID. */
  voice: string;
  /** Compatible Typecast model ID. Defaults to 'ssfm-v31'. */
  model?: string;
  /** Two-letter Korean, English, Japanese or Chinese code, or an ISO 639-3 code. Defaults to 'ko'. */
  language?: string;
  /** Speaking speed from 0.5 to 2. Defaults to the provider's normal speed. */
  speed?: number;
  /** Typecast API key. Falls back to TYPECAST_API_KEY. */
  apiKey?: string;
}

export class TypecastTTS implements TTS {
  readonly provider = 'typecast';
  readonly model: string;
  readonly voiceId: string;
  private readonly language: string | undefined;
  private readonly speed: number | undefined;
  private readonly apiKey: string;

  constructor(options: TypecastTTSOptions) {
    const voice = options.voice.trim();
    if (!voice) throw new Error('A Typecast voice ID is required');
    const apiKey = (options.apiKey ?? process.env.TYPECAST_API_KEY)?.trim();
    if (!apiKey) throw new Error('TYPECAST_API_KEY is required for Typecast TTS');
    if (options.speed !== undefined && !(options.speed >= 0.5 && options.speed <= 2)) {
      throw new RangeError('Typecast speed must be between 0.5 and 2');
    }

    this.model = options.model ?? 'ssfm-v31';
    this.voiceId = voice;
    const language = (options.language ?? 'ko').trim().split('-')[0].toLowerCase();
    this.language =
      LANGUAGE_CODES[language] ?? (/^[a-z]{3}$/.test(language) ? language : undefined);
    this.speed = options.speed;
    this.apiKey = apiKey;
  }

  async *synthesize(
    text: string | AsyncIterable<string>,
    options?: { voice?: string; sampleRate?: number; signal?: AbortSignal },
  ): AsyncGenerator<Buffer> {
    const voice = options?.voice?.trim() ?? this.voiceId;
    if (!voice) throw new Error('A Typecast voice ID is required');

    const sampleRate = options?.sampleRate ?? SOURCE_SAMPLE_RATE;
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
      throw new RangeError('Typecast output sample rate must be a positive integer');
    }

    // The telephone pipeline expects whole 20 ms frames. Group frames when the
    // requested rate has a fractional number of samples in 20 ms (e.g. 11025 Hz).
    let frames = 1;
    while (((sampleRate % 50) * frames) % 50 !== 0) frames++;
    const blockBytes = (SOURCE_SAMPLE_RATE / 50) * frames * 2;
    const outputBytes = ((sampleRate * frames) / 50) * 2;
    const lookaheadBytes = sampleRate > SOURCE_SAMPLE_RATE ? 2 : 0;
    let pending: Buffer = Buffer.alloc(0);

    for await (const part of typeof text === 'string' ? [text] : text) {
      for (const segment of splitText(part)) {
        for await (const pcm of this.synthesizeSegment(segment, voice, options?.signal)) {
          pending = pending.length ? Buffer.concat([pending, pcm]) : pcm;
          while (pending.length >= blockBytes + lookaheadBytes) {
            options?.signal?.throwIfAborted();
            const input = pending.subarray(0, blockBytes + lookaheadBytes);
            yield resamplePcm16(input, SOURCE_SAMPLE_RATE, sampleRate).subarray(0, outputBytes);
            pending = pending.subarray(blockBytes);
          }
        }
      }
    }
    options?.signal?.throwIfAborted();
    if (pending.length) {
      const tail = resamplePcm16(pending, SOURCE_SAMPLE_RATE, sampleRate);
      if (tail.length) yield tail;
    }
  }

  private async *synthesizeSegment(
    text: string,
    voice: string,
    signal?: AbortSignal,
  ): AsyncGenerator<Buffer> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await waitForData(controller, () =>
        fetch(TYPECAST_URL, {
          method: 'POST',
          redirect: 'error',
          headers: { 'X-API-KEY': this.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            voice_id: voice,
            model: this.model,
            language: this.language,
            output: { audio_format: 'wav', audio_tempo: this.speed },
          }),
          signal: controller.signal,
        }),
      );
      if (response.status !== 200)
        throw new Error(`Typecast TTS API error: HTTP ${response.status}`);
      if (!response.body) throw new Error('Typecast TTS returned no response body');
      yield* readPcm(response.body.getReader(), controller);
    } catch (error) {
      controller.signal.throwIfAborted();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }
}

function* splitText(text: string): Generator<string> {
  const characters = Array.from(text);
  let start = 0;
  while (start < characters.length) {
    let end = Math.min(start + MAX_TEXT_LENGTH, characters.length);
    if (end < characters.length) {
      // Keep a word intact when a nearby whitespace boundary is available.
      for (let cut = end; cut > start + MAX_TEXT_LENGTH / 2; cut--) {
        if (/\s/.test(characters[cut - 1])) {
          end = cut;
          break;
        }
      }
    }
    const segment = characters.slice(start, end).join('');
    if (segment.trim()) yield segment;
    start = end;
  }
}

async function waitForData<T>(controller: AbortController, read: () => Promise<T>): Promise<T> {
  const timeout = setTimeout(
    () => controller.abort(new Error('Typecast TTS response timed out')),
    NETWORK_TIMEOUT_MS,
  );
  try {
    return await read();
  } finally {
    clearTimeout(timeout);
  }
}

async function* readPcm(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
): AsyncGenerator<Buffer> {
  let header: Buffer | undefined = Buffer.alloc(0);
  let remaining = Infinity;
  let receivedBytes = 0;
  let finished = false;
  try {
    while (remaining > 0) {
      const { done, value } = await waitForData(controller, () => reader.read());
      if (done) {
        finished = true;
        break;
      }
      let pcm = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (header) {
        header = Buffer.concat([header, pcm]);
        const data = wavData(header);
        if (!data) {
          if (header.length > MAX_WAV_HEADER_BYTES)
            throw new Error('Typecast WAV header is too large');
          continue;
        }
        if (data.offset > MAX_WAV_HEADER_BYTES) throw new Error('Typecast WAV header is too large');
        pcm = header.subarray(data.offset);
        remaining = data.size === STREAMING_WAV_SIZE ? Infinity : data.size;
        header = undefined;
      }

      pcm = pcm.subarray(0, remaining);
      receivedBytes += pcm.length;
      remaining -= pcm.length;
      if (pcm.length) yield pcm;
    }
    if (
      header ||
      receivedBytes === 0 ||
      receivedBytes % 2 !== 0 ||
      (remaining !== Infinity && remaining > 0)
    ) {
      throw new Error('Typecast TTS returned missing or truncated PCM audio');
    }
  } finally {
    try {
      if (!finished) await reader.cancel();
    } catch {
      // A failed or aborted fetch may have already closed the reader.
    } finally {
      reader.releaseLock();
    }
  }
}

function wavData(buffer: Buffer): { offset: number; size: number } | undefined {
  if (buffer.length < 12) return;
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('Typecast TTS returned an invalid WAV stream');
  }

  let formatFound = false;
  for (let offset = 12; offset + 8 <= buffer.length; ) {
    const id = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'data') {
      if (!formatFound) throw new Error('Typecast WAV stream is missing a format chunk');
      return { offset: start, size };
    }
    if (start + size > buffer.length) return;
    if (id === 'fmt ') {
      if (
        size < 16 ||
        buffer.readUInt16LE(start) !== 1 ||
        buffer.readUInt16LE(start + 2) !== 1 ||
        buffer.readUInt32LE(start + 4) !== SOURCE_SAMPLE_RATE ||
        buffer.readUInt16LE(start + 12) !== 2 ||
        buffer.readUInt16LE(start + 14) !== 16
      ) {
        throw new Error('Typecast WAV stream must contain 32 kHz mono PCM16 audio');
      }
      formatFound = true;
    }
    offset = start + size + (size % 2);
  }
}
