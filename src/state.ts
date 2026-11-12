import type { Limit } from './config.js';

/**
 * Short-lived state of running chats, kept in memory (agentdesk runs as one process):
 * which reply is current, whether the agent is writing, live voice calls, rate limits.
 * Losing it on a restart only means an in-flight reply is dropped.
 */
export class ChatState {
  private versions = new Map<string, number>();
  private busyUntil = new Map<string, number>();
  private voiceCalls = new Map<string, { conversationId: string; expiresAt: number }>();
  private windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A new visitor message: returns its version. Runs started for older versions are stale. */
  nextVersion(conversationId: string): number {
    const version = (this.versions.get(conversationId) ?? 0) + 1;
    this.versions.set(conversationId, version);
    return version;
  }

  isStale(conversationId: string, version: number): boolean {
    return (this.versions.get(conversationId) ?? 0) > version;
  }

  /** Marks that the agent is writing a reply. Expires by itself, so a crash can't leave "typing…" forever. */
  setBusy(conversationId: string, busy: boolean, ttlMs = 180_000): void {
    if (busy) this.busyUntil.set(conversationId, this.now() + ttlMs);
    else this.busyUntil.delete(conversationId);
  }

  isBusy(conversationId: string): boolean {
    const until = this.busyUntil.get(conversationId);
    return until !== undefined && until > this.now();
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

  /** Counts one request against `limit` for `key`. False once the limit is used up for this window. */
  take(key: string, limit: Limit): boolean {
    const now = this.now();
    if (this.windows.size > 10_000) {
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
