import { useCallback, useEffect, useRef, useState } from 'react';
import { GeminiLiveSession, type LiveState } from './gemini-live';
import type {
  AgentChatEvent,
  AgentChatMessage,
  AgentChatTransport,
  VoiceToolResult,
  VoiceTurn,
} from './types';

export type VoiceStatus = 'idle' | 'starting' | LiveState | 'saving';

type Attach = Pick<VoiceToolResult, 'cards' | 'login' | 'links'>;

function merge(a: Attach, b: Attach): Attach {
  return {
    cards: [...(a.cards ?? []), ...(b.cards ?? [])],
    login: a.login || b.login,
    links: [...new Set([...(a.links ?? []), ...(b.links ?? [])])],
  };
}

function micError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Microphone is blocked. Allow it in your browser settings, or type your question.';
  if (name === 'NotFoundError') return 'No microphone found. Please type your question.';
  return err instanceof Error && err.message
    ? err.message
    : 'Voice chat could not start. Please type your question.';
}

/**
 * A voice call inside the chat. The live transcript shows as chat messages; when the
 * call ends it is saved through `transport.voice.saveTranscript` and `onSaved` runs.
 */
export function useVoiceCall(
  transport: AgentChatTransport,
  opts: { onSaved: () => void; onEvent?: (e: AgentChatEvent) => void },
) {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [turns, setTurns] = useState<AgentChatMessage[]>([]);
  const [level, setLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [maxSeconds, setMaxSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const session = useRef<GeminiLiveSession | null>(null);
  const sessionId = useRef('');
  const turnsRef = useRef<AgentChatMessage[]>([]);
  const nextAttach = useRef<Attach>({});
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const publish = (list: AgentChatMessage[]) => {
    turnsRef.current = list;
    setTurns(list);
  };

  const addTranscript = useCallback((role: 'user' | 'assistant', text: string) => {
    const list = [...turnsRef.current];
    const last = list.at(-1);
    if (last && last.role === role) {
      list[list.length - 1] = { ...last, text: last.text + text };
    } else {
      const attach = role === 'assistant' ? nextAttach.current : {};
      if (role === 'assistant') nextAttach.current = {};
      list.push({
        id: `voice-${list.length}`,
        role,
        text,
        createdAt: new Date().toISOString(),
        voice: true,
        ...attach,
      });
    }
    publish(list);
  }, []);

  const save = useCallback(async () => {
    const voice = transport.voice;
    const id = sessionId.current;
    const toSave: VoiceTurn[] = turnsRef.current
      .map((t) => ({
        role: t.role,
        text: t.text.trim(),
        links: [...(t.links ?? []), ...(t.cards ?? []).map((c) => c.url)],
      }))
      .filter((t) => t.text);
    if (!voice || !id || toSave.length === 0) {
      publish([]);
      setStatus('idle');
      return;
    }
    setStatus('saving');
    try {
      await voice.saveTranscript(id, toSave);
      optsRef.current.onSaved();
    } catch {
      // The live transcript stays on screen; only a reload loses it.
      setError('Could not save the call transcript.');
      setStatus('idle');
      return;
    }
    publish([]);
    setStatus('idle');
  }, [transport]);

  const end = useCallback(() => {
    session.current?.stop();
  }, []);

  const start = useCallback(async () => {
    const voice = transport.voice;
    if (!voice || session.current) return;
    setError(null);
    setStatus('starting');
    setElapsed(0);
    publish([]);
    nextAttach.current = {};
    const live = new GeminiLiveSession();
    session.current = live;
    try {
      // First, while the click still counts as a user gesture.
      await live.prepareAudio();
      const started = await voice.start();
      sessionId.current = started.sessionId;
      setMaxSeconds(started.maxSeconds);
      await live.connect(started.wsUrl, started.token, started.setup, {
        onState: (s) => {
          if (s !== 'closed') setStatus(s);
        },
        onTranscript: addTranscript,
        onLevel: setLevel,
        onToolCalls: (calls) =>
          Promise.all(
            calls.map(async (call) => {
              const result = await voice.runTool(started.sessionId, call.name, call.args);
              nextAttach.current = merge(nextAttach.current, result);
              return result.response;
            }),
          ),
        onClose: (reason) => {
          session.current = null;
          setLevel(0);
          setMuted(false);
          if (reason) setError('The voice call dropped. You can start it again or type.');
          optsRef.current.onEvent?.(reason ? 'voice_failed' : 'voice_ended');
          void save();
        },
      });
      optsRef.current.onEvent?.('voice_started');
    } catch (err) {
      session.current = null;
      live.stop();
      setError(micError(err));
      setStatus('idle');
      optsRef.current.onEvent?.('voice_failed');
    }
  }, [transport, addTranscript, save]);

  // Call timer, and the hard stop at maxSeconds.
  const inCall =
    status === 'connecting' || status === 'listening' || status === 'speaking' || status === 'reconnecting';
  useEffect(() => {
    if (!inCall) return;
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [inCall]);
  useEffect(() => {
    if (maxSeconds && elapsed >= maxSeconds) end();
  }, [elapsed, maxSeconds, end]);

  // Never leave the microphone on after the chat goes away.
  useEffect(() => () => session.current?.stop(), []);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      session.current?.setMuted(!m);
      return !m;
    });
  }, []);

  return {
    status,
    inCall,
    turns,
    level,
    muted,
    elapsed,
    maxSeconds,
    error,
    setError,
    start,
    end,
    toggleMute,
  };
}
