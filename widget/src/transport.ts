import type { AgentChatTransport, ChatSnapshot, VoiceStart, VoiceToolResult, VoiceTurn } from './types';

/** Returns the visitor's identity token (a JWT your server signs), or null for a guest. */
export type IdentityProvider = () => string | null | undefined | Promise<string | null | undefined>;

/** The widget's settings from the server (`web.widget` in the config). */
export interface ServerWidgetConfig {
  title: string;
  subtitle?: string;
  avatarUrl?: string;
  greeting: string;
  voiceHint: string;
  placeholder: string;
  launcherLabel?: string;
  teamLabel: string;
  currency: string;
  chips: Array<{ id: string; label: string; text: string }>;
  headerLinks: Array<{ label: string; url: string; icon: 'whatsapp' | 'phone' | 'mail' | 'link' }>;
  theme: Record<string, string>;
  login: boolean;
  voiceAvailable: boolean;
}

async function request<T>(url: string, init: RequestInit, identity?: IdentityProvider): Promise<T> {
  const token = identity ? await identity() : null;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || 'Something went wrong. Please try again.');
  return body;
}

export function fetchWidgetConfig(server: string): Promise<ServerWidgetConfig> {
  return request(`${server}/v1/web/config`, { method: 'GET' });
}

/** Talks to the agentdesk server for one conversation. */
export function createTransport(
  server: string,
  conversationId: string,
  identity?: IdentityProvider,
): AgentChatTransport {
  const base = `${server}/v1/web/conversations/${conversationId}`;
  const post = <T>(path: string, body: unknown) =>
    request<T>(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) }, identity);

  return {
    load: () => request<ChatSnapshot>(base, { method: 'GET' }, identity),
    send: async (text) => {
      // The page path (no query or hash), so the agent knows what the visitor is looking at.
      await post('/messages', { text, page: location.pathname });
    },
    voice: {
      start: () => post<VoiceStart>('/voice', {}),
      runTool: (sessionId, name, args) => post<VoiceToolResult>(`/voice/${sessionId}/tools`, { name, args }),
      saveTranscript: async (sessionId, turns: VoiceTurn[]) => {
        await post(`/voice/${sessionId}/transcript`, { turns });
      },
    },
  };
}

/** The visitor's conversation id, kept in localStorage per server. `fresh` starts a new conversation. */
export function conversationId(server: string, fresh = false): string {
  const key = `agentdesk:conversation:${server}`;
  try {
    const saved = localStorage.getItem(key);
    if (saved && !fresh) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem(key, id);
    return id;
  } catch {
    // Storage blocked: the chat still works, but a reload starts a new one.
    return crypto.randomUUID();
  }
}
