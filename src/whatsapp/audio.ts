import { spawn } from 'node:child_process';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { generateSpeech, generateText, transcribe } from 'ai';
import type { Config } from '../config.js';

type AudioConfig = NonNullable<NonNullable<Config['whatsapp']>['audio']>;

const TRANSCRIBE_PROMPT =
  'Transcribe this voice note word for word, in the language(s) spoken. Output only the transcript. If there is no speech, output nothing.';

/**
 * Voice notes through any OpenAI-compatible API: OpenAI itself, a gateway such as
 * OmniRoute or LiteLLM, or Gemini's OpenAI-compatible endpoint.
 */
export class Audio {
  private readonly provider: OpenAIProvider;

  constructor(
    private readonly config: AudioConfig,
    apiKey: string | undefined,
  ) {
    this.provider = createOpenAI({ name: 'audio', baseURL: config.baseUrl, apiKey: apiKey ?? '' });
  }

  get canSpeak(): boolean {
    return Boolean(this.config.speechModel);
  }

  /** The words in a voice note, or "" when there are none. */
  async transcribe(data: Uint8Array, mimeType: string): Promise<string> {
    if (this.config.transcriptionApi === 'transcriptions') {
      const { text } = await transcribe({
        model: this.provider.transcription(this.config.transcriptionModel),
        audio: data,
        abortSignal: AbortSignal.timeout(45_000),
      });
      return text.trim();
    }
    const { text } = await generateText({
      model: this.provider.chat(this.config.transcriptionModel),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: TRANSCRIBE_PROMPT },
            // The SDK only sends wav and mp3 as chat audio. Gemini reads the real container
            // from the bytes, so an OGG voice note works with this label.
            { type: 'file', data, mediaType: mimeType.includes('wav') ? 'audio/wav' : 'audio/mpeg' },
          ],
        },
      ],
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(45_000),
    });
    return text.trim();
  }

  /** A WhatsApp voice note (OGG Opus) saying `text`. */
  async speak(text: string): Promise<Buffer> {
    const model = this.config.speechModel;
    if (!model) throw new Error('whatsapp.audio.speechModel is not set');
    const input = speakable(text);
    if (!input) throw new Error('Nothing to say');
    const { audio } = await generateSpeech({
      model: this.provider.speech(model),
      text: input,
      voice: this.config.speechVoice,
      outputFormat: this.config.speechFormat,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(30_000),
    });
    if (this.config.speechFormat === 'opus') return Buffer.from(audio.uint8Array);
    const source =
      this.config.speechFormat === 'wav' ? unwrapWav(audio.uint8Array) : Buffer.from(audio.uint8Array);
    return toOggOpus(source, this.config.speechFormat);
  }
}

/** Drops what shouldn't be read aloud: links (they go out as text), markdown marks, blank lines. */
export function speakable(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#`~]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Some gateways return a WAV whose audio is itself a whole WAV file (header plus trailing
 * metadata), which plays as a click and a buzz. Returns the innermost audio as a plain WAV.
 */
export function unwrapWav(bytes: Uint8Array): Buffer {
  let wav: Buffer = Buffer.from(bytes);
  for (let depth = 0; depth < 4; depth++) {
    const { fmt, data } = wavChunks(wav);
    if (data.subarray(0, 4).toString('ascii') !== 'RIFF') return toWav(fmt, data);
    wav = data;
  }
  throw new Error('WAV nested too deep');
}

function wavChunks(wav: Buffer): { fmt: Buffer; data: Buffer } {
  if (wav.subarray(0, 4).toString('ascii') !== 'RIFF' || wav.subarray(8, 12).toString('ascii') !== 'WAVE') {
    throw new Error('Not a WAV file');
  }
  let fmt: Buffer | undefined;
  for (let at = 12; at + 8 <= wav.length; ) {
    const id = wav.subarray(at, at + 4).toString('ascii');
    const size = wav.readUInt32LE(at + 4);
    const body = wav.subarray(at + 8, Math.min(at + 8 + size, wav.length));
    if (id === 'fmt ') fmt = body;
    if (id === 'data') {
      if (!fmt) throw new Error('WAV data before fmt');
      return { fmt, data: body };
    }
    at += 8 + size + (size % 2); // chunks are padded to an even length
  }
  throw new Error('WAV has no data');
}

function toWav(fmt: Buffer, data: Buffer): Buffer {
  const header = Buffer.alloc(12 + 8 + fmt.length + 8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(header.length - 8 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(fmt.length, 16);
  fmt.copy(header, 20);
  header.write('data', 20 + fmt.length, 'ascii');
  header.writeUInt32LE(data.length, 24 + fmt.length);
  return Buffer.concat([header, data]);
}

/** WhatsApp plays OGG Opus as a voice note. Needs ffmpeg on the PATH (it is in the Docker image). */
function toOggOpus(audio: Buffer, format: 'wav' | 'mp3'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      ...['-loglevel', 'error', '-f', format, '-i', 'pipe:0'],
      ...['-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', '-application', 'voip', '-f', 'ogg', 'pipe:1'],
    ]);
    const timer = setTimeout(() => ffmpeg.kill('SIGKILL'), 15_000);
    const out: Buffer[] = [];
    let errors = '';
    ffmpeg.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    ffmpeg.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg could not start: ${error.message}`));
    });
    ffmpeg.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg failed (${code}): ${errors.trim()}`));
    });
    ffmpeg.stdin.on('error', () => {}); // ffmpeg exited early; 'close' reports it
    ffmpeg.stdin.end(audio);
  });
}
