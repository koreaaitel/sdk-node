/**
 * PipelineSession orchestrates STT -> LLM -> TTS for a voice call.
 */

import { pcm16ToUlaw, resamplePcm16, ulawToPcm16 } from '../audio.js';
import { BuiltinTool } from '../builtin-tool.js';
import type { AudioRecorder } from '../recorder.js';
import type { CallSession } from '../session.js';
import { ToolRegistry } from '../tool.js';
import type {
  ConversationMessage,
  LLM,
  LLMChunk,
  Session,
  STT,
  TTS,
} from './base.js';
import type { SessionTelemetry } from '../telemetry.js';
import type { Logger } from 'pino';
import { NOOP_LOGGER } from '../logger.js';
import { HoldAudioPlayer } from '../hold-audio.js';
import {
  BUILTIN_TOOL_NAMES,
  CALL_NOT_READY_RESULT,
  executeBuiltinTool,
  getBuiltinToolSchemas,
} from './builtin-tool-schemas.js';
import { BufferingCall, attachBuffered } from './buffering-call.js';

export interface PipelineSessionOptions {
  stt: STT;
  llm: LLM;
  tts: TTS;
  /** System prompt for the LLM. */
  systemPrompt?: string;
  /** Send initial greeting. Default: true */
  greeting?: boolean;
  /** Language code. Default: 'ko' */
  language?: string;
  /** Tool registry for function calling. */
  toolRegistry?: ToolRegistry;
  /** Audio recorder for the session. */
  recorder?: AudioRecorder;
  /** LLM temperature. */
  temperature?: number;
  /** Max tokens for LLM generation. */
  maxTokens?: number;
  /** Sample rate for audio. Default: 8000 */
  sampleRate?: number;
  /** Whether to interrupt TTS when user starts speaking. Default: true */
  interruptOnSpeech?: boolean;
}

export class PipelineSession implements Session {
  private _stt: STT;
  private _llm: LLM;
  private _tts: TTS;
  private _systemPrompt: string | undefined;
  private _greeting: boolean;
  private _language: string;
  private _temperature: number | undefined;
  private _maxTokens: number | undefined;
  private _sampleRate: number;
  private _interruptOnSpeech: boolean;

  private _callSession: CallSession | BufferingCall | null = null;
  private _tools: ToolRegistry | null = null;
  private _recorder: AudioRecorder | null = null;
  private _conversation: ConversationMessage[] = [];
  private _audioBuffer: Buffer[] = [];
  private _callRun: AbortController | null = null;
  private _activeSynthesis: AbortController | null = null;
  private _builtinTools: Set<BuiltinTool> | null = null;
  private _holdAudioChunks: Buffer[] | null = null;
  private _log: Logger = NOOP_LOGGER;

  constructor(options: PipelineSessionOptions) {
    this._stt = options.stt;
    this._llm = options.llm;
    this._tts = options.tts;
    this._systemPrompt = options.systemPrompt;
    this._greeting = options.greeting ?? true;
    this._language = options.language ?? 'ko';
    this._temperature = options.temperature;
    this._maxTokens = options.maxTokens;
    this._sampleRate = options.sampleRate ?? 8000;
    this._interruptOnSpeech = options.interruptOnSpeech ?? true;
    if (options.toolRegistry) this._tools = options.toolRegistry;
    if (options.recorder) this._recorder = options.recorder;
  }

  setToolRegistry(registry: ToolRegistry): void {
    this._tools = registry;
  }

  setRecorder(recorder: AudioRecorder): void {
    this._recorder = recorder;
  }

  setBuiltinTools(tools: Set<BuiltinTool>): void {
    this._builtinTools = tools;
  }

  /** Tool 실행 중 재생할 hold audio 청크를 설정한다. */
  setHoldAudio(chunks: Buffer[]): void {
    this._holdAudioChunks = chunks;
  }

  getTelemetry(): SessionTelemetry {
    const llm = this._llm as any;
    const stt = this._stt as any;
    const tts = this._tts as any;
    return {
      sessionType: 'pipeline',
      llm: llm.provider && llm.model ? { provider: llm.provider, model: llm.model } : null,
      stt: stt.provider && stt.model ? { provider: stt.provider, model: stt.model } : null,
      tts: tts.provider && tts.model ? { provider: tts.provider, model: tts.model } : null,
      voice: (tts as any).voiceId ?? null,
      language: this._language,
      greetingEnabled: this._greeting,
      recordingEnabled: !!this._recorder,
      toolCount: this._tools?.size ?? 0,
      mcpServerCount: 0,
      builtinTools: [],
    };
  }

  setLogger(logger: Logger): void {
    this._log = logger;
    if ('setLogger' in this._stt && typeof (this._stt as any).setLogger === 'function') {
      (this._stt as any).setLogger(logger);
    }
    if ('setLogger' in this._tts && typeof (this._tts as any).setLogger === 'function') {
      (this._tts as any).setLogger(logger);
    }
  }

  /**
   * Pre-bootstrap conversation state and (optionally) trigger greeting synthesis
   * before a real CallSession is attached. Audio chunks are buffered into a
   * BufferingCall until attach() flushes them.
   */
  async prewarm(tools?: ToolRegistry): Promise<void> {
    if (tools) this._tools = tools;
    this._callRun?.abort();
    this._activeSynthesis?.abort();
    const run = new AbortController();
    this._callRun = run;
    this._callSession = new BufferingCall();
    this._conversation = [];
    this._log.info('PipelineSession prewarmed');

    if (this._systemPrompt) {
      this._conversation.push({
        role: 'system',
        content: this._systemPrompt,
      });
    }

    if (this._greeting) {
      this._generateGreeting(run.signal).catch((err) => {
        this._log.error({ err }, 'Greeting error');
      });
    }

    this._runSttLoop(run.signal).catch((err) => {
      this._log.error({ err }, 'STT loop error');
    });
  }

  /** Attach a real CallSession to the prewarmed session and flush buffered audio. */
  async attach(callSession: CallSession): Promise<void> {
    const prev = this._callSession;
    this._callSession = callSession;
    attachBuffered(prev, callSession);
  }

  async start(callSession: CallSession, tools?: ToolRegistry): Promise<void> {
    this._tools = tools ?? null;
    await this.prewarm();
    await this.attach(callSession);
  }

  feedAudio(audio: Buffer): void {
    if (this._callRun) {
      this._audioBuffer.push(audio);
    }
  }

  async feedDtmf(digits: string): Promise<void> {
    const signal = this._callRun?.signal;
    if (!signal) return;
    this._conversation.push({
      role: 'user',
      content: `[DTMF 입력: ${digits}]`,
    });
    await this._respond(signal);
  }

  async stop(): Promise<void> {
    this._callRun?.abort();
    this._callRun = null;
    this._activeSynthesis?.abort();
    this._log.info('PipelineSession stopped');
    this._audioBuffer = [];
  }

  private async _runSttLoop(signal: AbortSignal): Promise<void> {
    const audioStream = this._createAudioStream(signal);
    let response = Promise.resolve();

    for await (const event of this._stt.transcribe(audioStream, {
      sampleRate: this._sampleRate,
    })) {
      if (signal.aborted) break;

      if (
        event.type === 'interim' &&
        this._activeSynthesis &&
        !this._activeSynthesis.signal.aborted &&
        this._interruptOnSpeech
      ) {
        this._activeSynthesis.abort();
        if (this._callSession) {
          this._callSession.clearAudio();
        }
        this._log.info('Barge-in: "%s"', event.transcript.substring(0, 30));
      }

      if (event.type === 'final' && event.transcript.trim()) {
        this._log.info('STT: %s', event.transcript);
        // Keep dialogue turns in order without blocking STT interim events during playback.
        const transcript = event.transcript;
        response = response
          .then(async () => {
            if (!signal.aborted) await this._handleUserSpeech(transcript, signal);
          })
          .catch((err) => {
            this._log.error({ err }, 'Response error');
          });
      }
    }
    await response;
  }

  private async *_createAudioStream(signal: AbortSignal): AsyncGenerator<Buffer> {
    while (!signal.aborted) {
      if (this._audioBuffer.length > 0) {
        const ulaw = this._audioBuffer.shift()!;
        // G.711 ulaw 8kHz → PCM16 8kHz → PCM16 16kHz
        const pcm8k = ulawToPcm16(ulaw);
        const pcm16k = resamplePcm16(pcm8k, 8000, 16000);
        yield pcm16k;
      } else {
        // Wait a bit before checking again
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }

  private async _generateGreeting(signal: AbortSignal): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await this._respond(signal);
  }

  private async _handleUserSpeech(transcript: string, signal: AbortSignal): Promise<void> {
    this._conversation.push({ role: 'user', content: transcript });
    await this._respond(signal);
  }

  private _buildEffectiveTools(): ToolRegistry | undefined {
    const builtinSchemas = getBuiltinToolSchemas(this._builtinTools, 'chat');
    // Filter to only DTMF tools (hang_up is handled at session level, not LLM tool)
    const dtmfSchemas = builtinSchemas.filter((s) => {
      const name = (s['function'] as Record<string, unknown>)?.['name'] as string;
      return name === 'collect_dtmf' || name === 'send_dtmf';
    });

    if (dtmfSchemas.length === 0) return this._tools ?? undefined;

    // Inject DTMF tool stubs into a forked registry so the LLM sees them
    const base = this._tools ? this._tools.fork() : new ToolRegistry();
    for (const schema of dtmfSchemas) {
      const fn = schema['function'] as Record<string, unknown>;
      const params = fn['parameters'] as Record<string, unknown>;
      base.register({
        name: fn['name'] as string,
        description: fn['description'] as string,
        parameters: (params['properties'] ?? {}) as Record<string, unknown>,
        required: (params['required'] ?? []) as string[],
        handler: async () => '',
      });
    }
    return base;
  }

  private async _respond(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    // Run LLM generation (may include tool calls)
    let fullResponse = '';
    const textChunks: string[] = [];

    const effectiveTools = this._buildEffectiveTools();
    const llmStream = this._llm.generate(this._conversation, {
      tools: effectiveTools,
      temperature: this._temperature,
      maxTokens: this._maxTokens,
    });

    for await (const chunk of llmStream) {
      if (signal.aborted) break;

      if (chunk.type === 'text' && chunk.text) {
        textChunks.push(chunk.text);
        fullResponse += chunk.text;
      } else if (chunk.type === 'tool_call' && chunk.toolCall) {
        await this._handleToolCall(chunk, signal);
      }
    }

    if (!signal.aborted && fullResponse.trim()) {
      this._log.info('Assistant: %s', fullResponse.substring(0, 100));
      this._conversation.push({ role: 'assistant', content: fullResponse });
      // Synthesize and send audio
      await this._synthesizeAndSend(fullResponse, signal);
    }
  }

  private async _handleToolCall(chunk: LLMChunk, signal: AbortSignal): Promise<void> {
    if (!chunk.toolCall) return;

    const { id, name, arguments: argsStr } = chunk.toolCall;

    try {
      const args = JSON.parse(argsStr) as Record<string, unknown>;

      // Built-in tools - intercept before registry lookup
      if (BUILTIN_TOOL_NAMES.has(name) && this._callSession && !(this._callSession instanceof BufferingCall)) {
        const result = await executeBuiltinTool(name, args, this._callSession);
        if (signal.aborted) return;
        if (result !== null) {
          if (name === 'hang_up') return;
          this._conversation.push({ role: 'tool', content: result, tool_call_id: id, name });
          await this._respond(signal);
          return;
        }
      }

      // prewarm 창(=상대가 받기 전)에는 통화 제어 도구를 수행할 대상이 없다.
      if (BUILTIN_TOOL_NAMES.has(name) && this._callSession instanceof BufferingCall) {
        this._log.warn('Builtin tool %s called before answer — deferring', name);
        this._conversation.push({
          role: 'tool',
          content: CALL_NOT_READY_RESULT,
          tool_call_id: id,
          name,
        });
        await this._respond(signal);
        return;
      }

      if (!this._tools) return;
      this._callSession?.recordToolCall();

      const player =
        this._holdAudioChunks && this._callSession && !(this._callSession instanceof BufferingCall)
          ? new HoldAudioPlayer(this._callSession, this._holdAudioChunks)
          : null;
      player?.start();

      let result: unknown;
      try {
        result = await this._tools.call(name, args);
      } finally {
        player?.stop();
      }

      if (signal.aborted) return;
      this._conversation.push({
        role: 'assistant',
        content: '',
        // Tool call info stored in the message flow
      });
      this._conversation.push({
        role: 'tool',
        content: typeof result === 'string' ? result : JSON.stringify(result),
        tool_call_id: id,
        name,
      });

      // Re-generate after tool result
      const effectiveTools = this._buildEffectiveTools();
      let followUpText = '';
      const followUpStream = this._llm.generate(this._conversation, {
        tools: effectiveTools,
        temperature: this._temperature,
        maxTokens: this._maxTokens,
      });

      for await (const followChunk of followUpStream) {
        if (signal.aborted) break;
        if (followChunk.type === 'text' && followChunk.text) {
          followUpText += followChunk.text;
        }
      }

      if (!signal.aborted && followUpText.trim()) {
        this._conversation.push({ role: 'assistant', content: followUpText });
        await this._synthesizeAndSend(followUpText, signal);
      }
    } catch (err) {
      this._log.error({ err }, 'Tool call failed: %s', name);
      if (err instanceof Error && !signal.aborted) {
        this._callSession?.recordToolError(err);
      }
    }
  }

  private async _synthesizeAndSend(text: string, signal: AbortSignal): Promise<void> {
    if (!this._callSession || signal.aborted) return;

    const synthesis = new AbortController();
    this._activeSynthesis?.abort();
    this._activeSynthesis = synthesis;

    try {
      for await (const audioChunk of this._tts.synthesize(text, {
        sampleRate: this._sampleRate,
        signal: synthesis.signal,
      })) {
        if (synthesis.signal.aborted) break;
        // Resample TTS output → 8kHz → ulaw, send in 160B frames
        const pcm8k = resamplePcm16(audioChunk, this._sampleRate, 8000);
        const ulaw = pcm16ToUlaw(pcm8k);
        for (let off = 0; off < ulaw.length; off += 160) {
          let chunk = ulaw.subarray(off, off + 160);
          if (chunk.length < 160) {
            chunk = Buffer.concat([chunk, Buffer.alloc(160 - chunk.length, 0xff)]);
          }
          this._callSession.sendAudio(chunk);
        }
      }
    } catch (err) {
      if (!synthesis.signal.aborted) this._log.error({ err }, 'TTS error');
    } finally {
      if (this._activeSynthesis === synthesis) this._activeSynthesis = null;
    }
  }
}
