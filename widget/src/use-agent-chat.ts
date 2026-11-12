import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentChatMessage, AgentChatTransport, ChatSnapshot } from './types';

// While a reply is on its way.
const FAST_POLL_MS = 1500;
// While the chat is open and idle: picks up replies from your team.
const IDLE_POLL_MS = 20_000;
const HIDDEN_POLL_MS = 60_000;
// Without a "busy" flag from the server (e.g. its cache is down), stop waiting after this.
const MAX_WAIT_MS = 90_000;

const EMPTY: ChatSnapshot = { messages: [], busy: false, voiceAvailable: false };

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Something went wrong. Please try again.';
}

/**
 * The chat's messages, kept fresh by polling `transport.load()` while `active`.
 * Polls fast while a reply is being written, slowly otherwise.
 */
export function useAgentChat(transport: AgentChatTransport, active: boolean) {
  const [snapshot, setSnapshot] = useState<ChatSnapshot>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<AgentChatMessage[]>([]);
  // A failed send stays until dismissed or the next send; a failed load clears on the next good poll.
  const [error, setErrorState] = useState<{ text: string; from: 'load' | 'send' } | null>(null);
  const setError = useCallback(
    (text: string | null) => setErrorState(text ? { text, from: 'send' } : null),
    [],
  );
  const [kick, setKick] = useState(0);
  const awaitingSince = useRef<number | null>(null);

  // A new transport is a new conversation (e.g. after sign-out).
  useEffect(() => {
    setSnapshot(EMPTY);
    setLoaded(false);
    setPending([]);
    awaitingSince.current = null;
  }, [transport]);

  const refresh = useCallback(async (): Promise<ChatSnapshot | null> => {
    try {
      const next = await transport.load();
      setSnapshot(next);
      setLoaded(true);
      setErrorState((e) => (e?.from === 'load' ? null : e));
      setPending((list) =>
        list.filter((p) => !next.messages.some((m) => m.role === 'user' && m.text === p.text)),
      );
      const last = next.messages.at(-1);
      const replied = last?.role === 'assistant' && !next.busy;
      if (awaitingSince.current && (replied || Date.now() - awaitingSince.current > MAX_WAIT_MS))
        awaitingSince.current = null;
      return next;
    } catch (err) {
      setErrorState({ text: errorText(err), from: 'load' });
      return null;
    }
  }, [transport]);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const next = await refresh();
      if (stopped) return;
      const waiting = Boolean(next?.busy) || awaitingSince.current !== null;
      const delay = waiting ? FAST_POLL_MS : document.hidden ? HIDDEN_POLL_MS : IDLE_POLL_MS;
      timer = setTimeout(tick, delay);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, refresh, kick]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const now = new Date().toISOString();
      setPending((list) => [
        ...list,
        { id: `pending-${now}`, role: 'user', text: trimmed, createdAt: now, pending: true },
      ]);
      awaitingSince.current = Date.now();
      setErrorState(null);
      try {
        await transport.send(trimmed);
      } catch (err) {
        awaitingSince.current = null;
        setPending((list) => list.filter((p) => p.text !== trimmed));
        setErrorState({ text: errorText(err), from: 'send' });
      } finally {
        setKick((k) => k + 1);
      }
    },
    [transport],
  );

  return {
    messages: [...snapshot.messages, ...pending],
    typing: snapshot.busy || awaitingSince.current !== null,
    voiceAvailable: snapshot.voiceAvailable,
    loaded,
    error: error?.text ?? null,
    setError,
    send,
    refresh,
  };
}
