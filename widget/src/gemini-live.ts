// A Gemini Live voice session opened straight from the browser with a short-lived token from
// your server: microphone up (16 kHz PCM), the agent's voice down (24 kHz PCM), both through
// AudioWorklets. Tool calls are handed to the page, which runs them on the server.

export type LiveState = 'connecting' | 'listening' | 'speaking' | 'reconnecting' | 'closed';

export interface LiveCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LiveHandlers {
  onState(state: LiveState): void;
  /** A piece of what was said, as it is recognised. */
  onTranscript(who: 'user' | 'assistant', text: string): void;
  /** Runs the calls and returns one response object per call, in order. */
  onToolCalls(calls: LiveCall[]): Promise<Record<string, unknown>[]>;
  /** Microphone loudness 0..1, for the level meter. */
  onLevel(level: number): void;
  /** The session ended for good; `reason` is unset when we closed it. */
  onClose(reason?: string): void;
}

// Mic: resamples to 16 kHz Int16 and posts 100 ms chunks with their loudness.
const MIC_WORKLET =
  'class Mic extends AudioWorkletProcessor{constructor(){super();this.step=sampleRate/16000;this.t=0;this.prev=0;this.buf=new Int16Array(1600);this.n=0;this.sq=0}' +
  'process(inputs){const x=inputs[0][0];if(!x)return true;for(let k=0;k<x.length;k++){const s=x[k];while(this.t<=1){const v=Math.max(-1,Math.min(1,this.prev+(s-this.prev)*this.t));' +
  'this.buf[this.n++]=v*32767;this.sq+=v*v;if(this.n===this.buf.length){this.port.postMessage({pcm:this.buf.buffer,rms:Math.sqrt(this.sq/this.n)},[this.buf.buffer]);this.buf=new Int16Array(1600);this.n=0;this.sq=0}' +
  'this.t+=this.step}this.t-=1;this.prev=s}return true}}registerProcessor("mic",Mic)';
// Player: plays queued Int16 chunks; "flush" drops them; posts true/false when playback starts and stops.
const PLAYER_WORKLET =
  'class Player extends AudioWorkletProcessor{constructor(){super();this.q=[];this.off=0;this.on=false;this.port.onmessage=(e)=>{if(e.data==="flush"){this.q=[];this.off=0}else this.q.push(e.data)}}' +
  'process(_,outputs){const out=outputs[0][0];let i=0;while(i<out.length&&this.q.length){const b=this.q[0];const n=Math.min(out.length-i,b.length-this.off);' +
  'for(let k=0;k<n;k++)out[i+k]=b[this.off+k]/32768;i+=n;this.off+=n;if(this.off>=b.length){this.q.shift();this.off=0}}for(;i<out.length;i++)out[i]=0;' +
  'const on=this.q.length>0;if(on!==this.on){this.on=on;this.port.postMessage(on)}return true}}registerProcessor("player",Player)';
const moduleUrl = (code: string) => URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));

/** While the agent speaks, only clearly louder sound goes up, so its own voice in the mic doesn't cut it off. */
const BARGE_IN_RMS = 0.04;
const MAX_RESUMES = 3;
const SETUP_TIMEOUT_MS = 15_000;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(data: string): Int16Array {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}

// biome-ignore lint/suspicious/noExplicitAny: Gemini Live server messages are untyped JSON
function parse(data: unknown): any {
  try {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer);
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class GeminiLiveSession {
  private ws?: WebSocket;
  private handle?: string;
  private resumes = 0;
  private closed = false;
  private ready = false;
  private micStream?: MediaStream;
  private micCtx?: AudioContext;
  private micNode?: AudioWorkletNode;
  private outCtx?: AudioContext;
  private player?: AudioWorkletNode;
  private wsUrl = '';
  private token = '';
  private setup: { setup: Record<string, unknown> } = { setup: {} };
  private h?: LiveHandlers;
  playing = false;
  muted = false;

  /**
   * Step 1, first thing in the click handler: speaker and microphone. Browsers (Safari above all)
   * allow audio only while the click still counts, so this runs before any network call.
   */
  async prepareAudio(): Promise<void> {
    if (!window.isSecureContext || !navigator.mediaDevices)
      throw new Error('Voice needs a secure (https) page.');
    this.outCtx = new AudioContext({ sampleRate: 24000 });
    this.micCtx = new AudioContext();
    const resumed = Promise.all([this.outCtx.resume(), this.micCtx.resume()]);
    const stream = navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    await this.outCtx.audioWorklet.addModule(moduleUrl(PLAYER_WORKLET));
    this.player = new AudioWorkletNode(this.outCtx, 'player', { numberOfInputs: 0, outputChannelCount: [1] });
    this.player.port.onmessage = (e) => {
      this.playing = e.data;
      if (this.ready) this.h?.onState(this.playing ? 'speaking' : 'listening');
    };
    this.player.connect(this.outCtx.destination);
    try {
      this.micStream = await stream;
    } catch (err) {
      this.release();
      throw err;
    }
    await this.micCtx.audioWorklet.addModule(moduleUrl(MIC_WORKLET));
    await resumed;
    const source = this.micCtx.createMediaStreamSource(this.micStream);
    this.micNode = new AudioWorkletNode(this.micCtx, 'mic');
    this.micNode.port.onmessage = (e) => {
      this.h?.onLevel(e.data.rms);
      if (this.muted || !this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
      if (this.playing && e.data.rms < BARGE_IN_RMS) return;
      this.send({
        realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: toBase64(e.data.pcm) } },
      });
    };
    const sink = this.micCtx.createGain();
    sink.gain.value = 0;
    source.connect(this.micNode).connect(sink).connect(this.micCtx.destination);
  }

  /** Step 2, with the server's session: connect and let the agent speak first. */
  async connect(
    wsUrl: string,
    token: string,
    setup: { setup: Record<string, unknown> },
    handlers: LiveHandlers,
    kickoff = '(The customer started a voice call. Greet them now.)',
  ): Promise<void> {
    this.wsUrl = wsUrl;
    this.token = token;
    this.setup = setup;
    this.h = handlers;
    handlers.onState('connecting');
    await this.open();
    this.send({
      clientContent: { turns: [{ role: 'user', parts: [{ text: kickoff }] }], turnComplete: true },
    });
  }

  private open(): Promise<void> {
    this.ready = false;
    const sep = this.wsUrl.includes('?') ? '&' : '?';
    const ws = new WebSocket(`${this.wsUrl}${sep}access_token=${encodeURIComponent(this.token)}`);
    // Array buffers parse synchronously, so messages are handled in the order they arrive.
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.onclose = ws.onmessage = ws.onerror = null;
        ws.close();
        reject(new Error(reason));
      };
      const timer = setTimeout(() => fail('The voice service did not answer in time'), SETUP_TIMEOUT_MS);
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            setup: { ...this.setup.setup, sessionResumption: this.handle ? { handle: this.handle } : {} },
          }),
        );
      };
      ws.onerror = () => fail('Could not connect to the voice service');
      ws.onclose = (e) =>
        fail(`The voice service closed the connection (${e.code}${e.reason ? `: ${e.reason}` : ''})`);
      ws.onmessage = (e) => {
        if (!parse(e.data)?.setupComplete) return;
        settled = true;
        clearTimeout(timer);
        this.ready = true;
        this.h?.onState('listening');
        ws.onmessage = (ev) => this.receive(parse(ev.data));
        ws.onerror = null;
        ws.onclose = (ev) => void this.dropped(`closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`);
        resolve();
      };
    });
  }

  // biome-ignore lint/suspicious/noExplicitAny: Gemini Live server messages are untyped JSON
  private receive(msg: any): void {
    if (!msg) return;
    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle)
      this.handle = msg.sessionResumptionUpdate.newHandle;
    if (msg.goAway) {
      void this.dropped('go away', true);
      return;
    }
    const c = msg.serverContent;
    if (c) {
      if (c.inputTranscription?.text) this.h?.onTranscript('user', c.inputTranscription.text);
      if (c.outputTranscription?.text) this.h?.onTranscript('assistant', c.outputTranscription.text);
      // Play every inlineData part unless it is labelled as something other than audio.
      for (const part of c.modelTurn?.parts ?? []) {
        const mime = String(part.inlineData?.mimeType ?? '');
        if (part.inlineData?.data && (!mime || mime.startsWith('audio/'))) {
          const pcm = fromBase64(part.inlineData.data);
          this.player?.port.postMessage(pcm, [pcm.buffer]);
        }
      }
      if (c.interrupted) this.player?.port.postMessage('flush');
    }
    const calls = msg.toolCall?.functionCalls as
      | Array<{ id?: string; name: string; args?: Record<string, unknown> }>
      | undefined;
    if (calls?.length && this.h) {
      const list = calls.map((call, i) => ({
        id: call.id ?? `call-${i}`,
        name: call.name,
        args: call.args ?? {},
      }));
      void this.h
        .onToolCalls(list)
        .catch((err: Error) => list.map(() => ({ error: err.message })))
        .then((responses) => {
          this.send({
            toolResponse: {
              functionResponses: list.map((call, i) => ({
                id: call.id,
                name: call.name,
                response: responses[i] ?? { error: 'no result' },
              })),
            },
          });
        });
    }
  }

  private async dropped(reason: string, goAway = false): Promise<void> {
    if (this.closed) return;
    const old = this.ws;
    if (old) {
      old.onclose = old.onmessage = old.onerror = null;
      if (goAway) old.close();
    }
    if (!this.handle || this.resumes >= MAX_RESUMES) return this.finish(reason);
    this.resumes++;
    this.h?.onState('reconnecting');
    try {
      await this.open();
    } catch (err) {
      this.finish(`could not resume: ${(err as Error).message}`);
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.ready) this.ws.send(JSON.stringify(msg));
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.send({ realtimeInput: { audioStreamEnd: true } });
  }

  private release(): void {
    for (const track of this.micStream?.getTracks() ?? []) track.stop();
    this.micNode?.disconnect();
    void this.micCtx?.close().catch(() => {});
    void this.outCtx?.close().catch(() => {});
  }

  private finish(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    if (this.ws) {
      this.ws.onclose = this.ws.onmessage = this.ws.onerror = null;
      this.ws.close();
    }
    this.release();
    this.h?.onState('closed');
    this.h?.onClose(reason);
  }

  stop(): void {
    this.finish();
  }
}
