// The inbox's calls to agentdesk's admin API (/v1/admin), with your token.

export interface InboxConversation {
  conversationId: string;
  channel: string;
  lastMessage: string;
  lastRole: 'user' | 'assistant' | 'tool';
  lastAt: string;
  messages: number;
  unread: number;
  starred: boolean;
  pausedUntil: string | null;
  name: string | null;
  lastCustomerAt: string | null;
}

export interface InboxMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  createdAt: string;
  data: {
    cards?: Array<{
      id: string;
      title: string;
      subtitle?: string;
      price?: number | string;
      image?: string;
      url: string;
    }>;
    login?: boolean;
    links?: string[];
    voice?: boolean;
    team?: boolean;
    context?: boolean;
    pausedUntil?: string | null;
    tool?: { name: string; input: Record<string, unknown>; result: string; isError: boolean };
    whatsapp?: {
      type?: string;
      name?: string;
      media?: { id: string; mimeType: string; caption?: string; filename?: string };
      error?: string;
    };
  } | null;
}

export interface InboxConfig {
  title: string;
  teamLabel: string;
  currency: string;
  quickReplies: Array<{ label: string; text: string }>;
  channels: string[];
}

export interface ListQuery {
  search?: string;
  starred?: boolean;
  channel?: string;
  before?: string;
}

export class InboxApi {
  constructor(
    private readonly server: string,
    private readonly token: () => string | Promise<string>,
  ) {}

  config(): Promise<InboxConfig> {
    return this.call('/inbox-config');
  }

  async list(query: ListQuery, limit = 40): Promise<InboxConversation[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (query.search) params.set('search', query.search);
    if (query.starred) params.set('starred', 'true');
    if (query.channel) params.set('channel', query.channel);
    if (query.before) params.set('before', query.before);
    return (await this.call<{ conversations: InboxConversation[] }>(`/conversations?${params}`))
      .conversations;
  }

  conversation(key: string): Promise<{ messages: InboxMessage[]; pausedUntil: string | null }> {
    return this.call(`/conversations/${encodeURIComponent(key)}?limit=300`);
  }

  async send(key: string, text: string): Promise<void> {
    await this.call(`/conversations/${encodeURIComponent(key)}/messages`, { method: 'POST', body: { text } });
  }

  async markRead(key: string): Promise<void> {
    await this.call(`/conversations/${encodeURIComponent(key)}/read`, { method: 'POST', body: {} });
  }

  async star(key: string, starred: boolean): Promise<void> {
    await this.call(`/conversations/${encodeURIComponent(key)}/star`, { method: 'POST', body: { starred } });
  }

  async pause(key: string, hours: number | null): Promise<void> {
    const path = `/conversations/${encodeURIComponent(key)}/pause`;
    await (hours === null
      ? this.call(path, { method: 'DELETE' })
      : this.call(path, { method: 'POST', body: { hours } }));
  }

  /** A media file as an object URL (images and audio need the token, so no plain <img src>). */
  async mediaUrl(id: string): Promise<string> {
    const res = await fetch(`${this.server}/v1/admin/media/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${await this.token()}` },
    });
    if (!res.ok) throw new Error(`Media ${res.status}`);
    return URL.createObjectURL(await res.blob());
  }

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await fetch(`${this.server}/v1/admin${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${await this.token()}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
    return body;
  }
}
