import type { Limit } from './config.js';

// The agent loop can take 8 model calls of up to 45 s each; "typing…" must outlast that.
const BUSY_TTL_MS = 7 * 60_000;
// Versions of chats idle this long are forgotten (no run lasts anywhere near it).
const VERSION_TTL_MS = 60 * 60_000;
const MAX_ENTRIES = 10_000;

/**
 * Short-lived state of running chats, kept in memory (agentdesk runs as one process):
 * which reply is current, whether the agent is writing, live voice calls, rate limits.
 * Losing it on a restart only means an in-flight reply is dropped.
 */
export class ChatState {
  private versions = new Map<string, { version: number; at: number }>();
  private busyUntil = new Map<string, number>();
  private voiceCalls = new Map<string, { conversationId: string; expiresAt: number }>();
  private windows = new Map<string, { count: number; resetAt: number }>();
  private running = new Map<Promise<void>, string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A new visitor message: returns its version. Runs started for older versions are stale. */
  nextVersion(conversationId: string): number {
    const now = this.now();
    if (this.versions.size > MAX_ENTRIES) {
      for (const [key, v] of this.versions) if (v.at < now - VERSION_TTL_MS) this.versions.delete(key);
    }
    const version = (this.versions.get(conversationId)?.version ?? 0) + 1;
    this.versions.set(conversationId, { version, at: now });
    return version;
  }

  isStale(conversationId: string, version: number): boolean {
    return (this.versions.get(conversationId)?.version ?? 0) > version;
  }

  /** Stops the reply being written in this chat, e.g. because your team answered or paused the agent. */
  cancel(conversationId: string): void {
    this.nextVersion(conversationId);
    this.setBusy(conversationId, false);
  }

  /** Marks that the agent is writing a reply. Expires by itself, so a crash can't leave "typing…" forever. */
  setBusy(conversationId: string, busy: boolean, ttlMs = BUSY_TTL_MS): void {
    if (busy) this.busyUntil.set(conversationId, this.now() + ttlMs);
    else this.busyUntil.delete(conversationId);
  }

  isBusy(conversationId: string): boolean {
    const until = this.busyUntil.get(conversationId);
    return until !== undefined && until > this.now();
  }

  /** Remembers a running reply, so a shutdown can wait for it. `task` must not reject. */
  track(conversationId: string, task: Promise<void>): void {
    this.running.set(task, conversationId);
    const done = () => {
      this.running.delete(task);
    };
    task.then(done, done);
  }

  /** Waits for the running replies, at most `timeoutMs`. Returns the chats whose reply is still running. */
  async drain(timeoutMs: number): Promise<string[]> {
    if (this.running.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...this.running.keys()]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
    }
    return [...new Set(this.running.values())];
  }

  /** Remembers which chat a voice call belongs to, so its tool calls and transcript are accepted. */
  registerVoiceCall(sessionId: string, conversationId: string, ttlMs: number): void {
    this.prune(this.voiceCalls);
    this.voiceCalls.set(sessionId, { conversationId, expiresAt: this.now() + ttlMs });
  }

  voiceCallBelongsTo(sessionId: string, conversationId: string): boolean {
    const call = this.voiceCalls.get(sessionId);
    return call !== undefined && call.expiresAt > this.now() && call.conversationId === conversationId;
  }

  /** The call is over (its transcript is saved): its session id is no longer accepted. */
  endVoiceCall(sessionId: string): void {
    this.voiceCalls.delete(sessionId);
  }

  /** Counts one request against `limit` for `key`. False once the limit is used up for this window. */
  take(key: string, limit: Limit): boolean {
    const now = this.now();
    if (this.windows.size > MAX_ENTRIES) {
      for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    }
    const window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + limit.perMinutes * 60_000 });
      return true;
    }
    if (window.count >= limit.max) return false;
    window.count++;
    return true;
  }

  private prune(map: Map<string, { expiresAt: number }>): void {
    const now = this.now();
    for (const [key, value] of map) if (value.expiresAt <= now) map.delete(key);
  }
}
