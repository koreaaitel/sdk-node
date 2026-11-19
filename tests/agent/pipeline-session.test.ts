import { describe, it, expect, vi } from 'vitest';
import { PipelineSession } from '../../src/agent/pipeline/pipeline-session.js';
import type { CallSession } from '../../src/agent/session.js';
import type { STT, LLM, TTS, SpeechEvent, LLMChunk, Session } from '../../src/agent/pipeline/base.js';

function createMockSTT(): STT {
  return {
    async *transcribe(): AsyncGenerator<SpeechEvent> {
      // no-op for unit tests
    },
  };
}

function createMockLLM(): LLM {
  return {
    async *generate(): AsyncGenerator<LLMChunk> {
      yield { type: 'done' };
    },
  };
}

function createMockTTS(): TTS {
  return {
    async *synthesize(): AsyncGenerator<Buffer> {
      // no-op
    },
  };
}

describe('PipelineSession', () => {
  it('constructor accepts STT, LLM, TTS', () => {
    const session = new PipelineSession({
      stt: createMockSTT(),
      llm: createMockLLM(),
      tts: createMockTTS(),
    });
    expect(session).toBeDefined();
  });

  it('implements Session interface', () => {
    const session: Session = new PipelineSession({
      stt: createMockSTT(),
      llm: createMockLLM(),
      tts: createMockTTS(),
    });
    expect(session.start).toBeInstanceOf(Function);
    expect(session.stop).toBeInstanceOf(Function);
    expect(session.feedAudio).toBeInstanceOf(Function);
  });

  it('has start method that accepts CallSession', () => {
    const session = new PipelineSession({
      stt: createMockSTT(),
      llm: createMockLLM(),
      tts: createMockTTS(),
    });
    expect(session.start).toBeInstanceOf(Function);
    // start signature: (callSession: CallSession, tools?: ToolRegistry) => Promise<void>
  });

  it('has stop method', () => {
    const session = new PipelineSession({
      stt: createMockSTT(),
      llm: createMockLLM(),
      tts: createMockTTS(),
    });
    expect(session.stop).toBeInstanceOf(Function);
  });

  it('has feedAudio method', () => {
    const session = new PipelineSession({
      stt: createMockSTT(),
      llm: createMockLLM(),
      tts: createMockTTS(),
    });
    expect(session.feedAudio).toBeInstanceOf(Function);
  });

  it('accepts optional configuration (systemPrompt, temperature, etc.)', () => {
    const session = new PipelineSession({
      stt: createMockSTT(),
      llm: createMockLLM(),
      tts: createMockTTS(),
      systemPrompt: 'You are a helpful assistant',
      temperature: 0.7,
      maxTokens: 256,
      sampleRate: 16000,
      interruptOnSpeech: false,
    });
    expect(session).toBeDefined();
  });

  it('discards queued and in-flight replies when reused for another call', async () => {
    let finishOldReply!: () => void;
    const oldReplyPending = new Promise<void>((resolve) => { finishOldReply = resolve; });
    let markOldTurnsQueued!: () => void;
    const oldTurnsQueued = new Promise<void>((resolve) => { markOldTurnsQueued = resolve; });
    let sttRuns = 0;
    const generate = vi.fn();
    const speak = vi.fn();
    const session = new PipelineSession({
      stt: {
        async *transcribe(): AsyncGenerator<SpeechEvent> {
          if (++sttRuns === 1) {
            yield { type: 'final', transcript: 'old first' };
            yield { type: 'final', transcript: 'old queued' };
            markOldTurnsQueued();
          } else {
            yield { type: 'final', transcript: 'new caller' };
          }
        },
      },
      llm: {
        async *generate(messages): AsyncGenerator<LLMChunk> {
          const input = messages.at(-1)?.content;
          generate(input);
          if (input === 'old first') await oldReplyPending;
          yield { type: 'text', text: `reply to ${input}` };
        },
      },
      tts: {
        async *synthesize(text) {
          speak(text);
          yield Buffer.alloc(320);
        },
      },
      greeting: false,
    });
    const oldCallAudio = vi.fn();
    const newCallAudio = vi.fn();
    await session.start({ sendAudio: oldCallAudio } as unknown as CallSession);

    try {
      await oldTurnsQueued;
      expect(generate.mock.calls).toEqual([['old first']]);
      await session.stop();
      await session.start({ sendAudio: newCallAudio } as unknown as CallSession);
      await vi.waitFor(() => expect(newCallAudio).toHaveBeenCalledOnce());
      finishOldReply();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(oldCallAudio).not.toHaveBeenCalled();
      expect(newCallAudio).toHaveBeenCalledOnce();
      expect(generate.mock.calls).toEqual([['old first'], ['new caller']]);
      expect(speak.mock.calls).toEqual([['reply to new caller']]);
    } finally {
      finishOldReply();
      await session.stop();
    }
  });

  it('stop resolves without error', async () => {
    const session = new PipelineSession({
      stt: createMockSTT(),
      llm: createMockLLM(),
      tts: createMockTTS(),
    });
    await expect(session.stop()).resolves.toBeUndefined();
  });
});
