import type { ConversationSummary, NewMessage, Store, StoredMessage } from './store.js';

/** Keeps chats in memory: for trying agentdesk out and for tests. Everything is lost on restart. */
export class MemoryStore implements Store {
  private rows: StoredMessage[] = [];
  private nextId = 1;

  async init(): Promise<void> {}

  async add(message: NewMessage): Promise<StoredMessage> {
    const row: StoredMessage = {
      id: String(this.nextId++),
      conversationId: message.conversationId,
      channel: message.channel,
      role: message.role,
      text: message.text,
      data: message.data ?? null,
      createdAt: message.createdAt ?? new Date().toISOString(),
    };
    this.rows.push(row);
    return row;
  }

  async recent(conversationId: string, limit: number, opts: { includeTools?: boolean } = {}) {
    const rows = this.rows.filter(
      (r) => r.conversationId === conversationId && (opts.includeTools || r.role !== 'tool'),
    );
    return rows.slice(-limit);
  }

  async conversations(limit: number): Promise<ConversationSummary[]> {
    const byId = new Map<string, ConversationSummary>();
    for (const row of this.rows) {
      if (row.role === 'tool') continue;
      const summary = byId.get(row.conversationId);
      byId.set(row.conversationId, {
        conversationId: row.conversationId,
        channel: row.channel,
        lastMessage: row.text,
        lastRole: row.role,
        lastAt: row.createdAt,
        messages: (summary?.messages ?? 0) + 1,
      });
    }
    return [...byId.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, limit);
  }

  async deleteBefore(cutoff: Date): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => new Date(r.createdAt) >= cutoff);
    return before - this.rows.length;
  }

  async close(): Promise<void> {}
}
