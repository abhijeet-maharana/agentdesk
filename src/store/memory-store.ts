import type { ConversationQuery, ConversationSummary, NewMessage, Store, StoredMessage } from './store.js';

/** Keeps chats in memory: for trying agentdesk out and for tests. Everything is lost on restart. */
export class MemoryStore implements Store {
  private rows: StoredMessage[] = [];
  private pauses = new Map<string, Date>();
  private settings = new Map<string, { readAt?: Date; starred?: boolean }>();
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
      (r) =>
        r.conversationId === conversationId &&
        (opts.includeTools || r.role === 'user' || r.role === 'assistant'),
    );
    return rows.slice(-limit);
  }

  async conversations(query: ConversationQuery): Promise<ConversationSummary[]> {
    const search = query.search?.toLowerCase();
    const byId = new Map<string, StoredMessage[]>();
    for (const row of this.rows) {
      if (row.role !== 'user' && row.role !== 'assistant') continue;
      byId.set(row.conversationId, [...(byId.get(row.conversationId) ?? []), row]);
    }
    const summaries: ConversationSummary[] = [];
    for (const [id, rows] of byId) {
      const last = rows.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a));
      const settings = this.settings.get(id);
      if (query.before && last.createdAt >= query.before) continue;
      if (query.channel && last.channel !== query.channel) continue;
      if (query.starredOnly && !settings?.starred) continue;
      if (
        search &&
        !id.toLowerCase().includes(search) &&
        !rows.some((r) => r.text.toLowerCase().includes(search))
      )
        continue;
      const customer = rows.filter((r) => r.role === 'user');
      const readAt = settings?.readAt?.toISOString() ?? '';
      summaries.push({
        conversationId: id,
        channel: last.channel,
        lastMessage: last.text,
        lastRole: last.role,
        lastAt: last.createdAt,
        messages: rows.length,
        unread: customer.filter((r) => r.createdAt > readAt).length,
        starred: settings?.starred ?? false,
        pausedUntil: (await this.pausedUntil(id))?.toISOString() ?? null,
        name: customer.findLast((r) => r.data?.whatsapp?.name)?.data?.whatsapp?.name ?? null,
        lastCustomerAt: customer.at(-1)?.createdAt ?? null,
      });
    }
    return summaries.sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, query.limit);
  }

  async markRead(conversationId: string): Promise<void> {
    this.settings.set(conversationId, { ...this.settings.get(conversationId), readAt: new Date() });
  }

  async setStarred(conversationId: string, starred: boolean): Promise<void> {
    this.settings.set(conversationId, { ...this.settings.get(conversationId), starred });
  }

  async deleteBefore(cutoff: Date): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => new Date(r.createdAt) >= cutoff);
    return before - this.rows.length;
  }

  async pausedUntil(conversationId: string): Promise<Date | null> {
    const until = this.pauses.get(conversationId);
    return until && until > new Date() ? until : null;
  }

  async setPausedUntil(conversationId: string, until: Date | null): Promise<void> {
    if (until) this.pauses.set(conversationId, until);
    else this.pauses.delete(conversationId);
  }

  async close(): Promise<void> {}
}
