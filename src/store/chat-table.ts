import type { MessageData, NewMessage, Role, StoredMessage } from './store.js';

/**
 * The chat table: one row per message, the same columns for every app.
 *
 *   id uuid · created_at timestamptz · phone_number text (the chat: a WhatsApp number, or
 *   web:<id>) · message text · role text (user | assistant | function | system) ·
 *   metadata jsonb · is_read boolean · is_starred boolean
 *
 * Your own app may write to it too (e.g. the notifications it sends), with the metadata keys
 * below; agentdesk reads them as part of the conversation. Rows with `metadata.context`,
 * `metadata.template_name` or text starting "[Automated System Message" count as sent by your app.
 */
export interface ChatRow {
  id: string;
  created_at: Date;
  phone_number: string;
  message: string;
  role: string;
  metadata: Record<string, unknown> | null;
  is_read: boolean | null;
  is_starred: boolean | null;
}

/** The chat a row belongs to: `web` for `web:<id>`, else WhatsApp. */
export function channelOf(key: string): string {
  const prefix = key.split(':')[0] ?? '';
  return key.includes(':') && prefix !== 'whatsapp' ? prefix : 'whatsapp';
}

/**
 * The key a chat is stored under: website chats keep `web:<id>`; WhatsApp chats are just the
 * number, as an app's own WhatsApp log has them.
 */
export function rowKey(conversationId: string): string {
  return conversationId.startsWith('whatsapp:') ? conversationId.slice('whatsapp:'.length) : conversationId;
}

/** agentdesk's conversation id for a row's key: `whatsapp:<number>` or `web:<id>`. */
export function conversationIdOf(key: string): string {
  return channelOf(key) === 'whatsapp' && !key.startsWith('whatsapp:') ? `whatsapp:${key}` : key;
}

const ROLE_TO_COLUMN: Record<Role, string> = {
  user: 'user',
  assistant: 'assistant',
  tool: 'function',
  system: 'system',
};

export function toColumns(message: NewMessage) {
  return {
    phone_number: rowKey(message.conversationId),
    message: message.role === 'tool' ? (message.data?.tool?.result ?? message.text) : message.text,
    role: ROLE_TO_COLUMN[message.role],
    metadata: toMetadata(message.data ?? null),
  };
}

export function fromRow(row: ChatRow): StoredMessage {
  const role: Role =
    row.role === 'function'
      ? 'tool'
      : row.role === 'system'
        ? 'system'
        : row.role === 'user'
          ? 'user'
          : 'assistant';
  return {
    id: String(row.id),
    conversationId: conversationIdOf(row.phone_number),
    channel: channelOf(row.phone_number),
    role,
    text: role === 'tool' ? '' : row.message,
    data: fromMetadata(role, row.message, row.metadata ?? {}),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** agentdesk's message data as metadata keys (the names an app's WhatsApp log already uses). */
export function toMetadata(data: MessageData | null): Record<string, unknown> | null {
  if (!data) return null;
  const { tool, whatsapp, userId, pausedUntil, ...plain } = data;
  const m: Record<string, unknown> = { ...plain };
  if (userId) m.user_id = userId;
  if (pausedUntil !== undefined) m.paused_until = pausedUntil;
  if (tool) Object.assign(m, { name: tool.name, args: tool.input, is_error: tool.isError });
  if (whatsapp) {
    if (whatsapp.id) m.whatsapp_message_id = whatsapp.id;
    if (whatsapp.type && whatsapp.type !== 'text') m.type = whatsapp.type;
    if (whatsapp.name) m.profile_name = whatsapp.name;
    if (whatsapp.sent?.length) m.wa_message_ids = whatsapp.sent;
    if (whatsapp.error) m.send_error = whatsapp.error;
    if (whatsapp.media) {
      m.whatsapp_media_id = whatsapp.media.id;
      m.mime_type = whatsapp.media.mimeType;
      if (whatsapp.media.caption) m.caption = whatsapp.media.caption;
      if (whatsapp.media.filename) m.filename = whatsapp.media.filename;
    }
  }
  return Object.keys(m).length ? m : null;
}

const MEDIA_MIME: Record<string, string> = {
  image: 'image/jpeg',
  sticker: 'image/webp',
  audio: 'audio/ogg',
  video: 'video/mp4',
  document: 'application/octet-stream',
};

export function fromMetadata(role: Role, message: string, m: Record<string, unknown>): MessageData | null {
  const str = (key: string) => (typeof m[key] === 'string' ? (m[key] as string) : undefined);
  const data: MessageData = {};
  if (Array.isArray(m.cards)) data.cards = m.cards as MessageData['cards'];
  if (m.login === true) data.login = true;
  if (Array.isArray(m.links)) data.links = m.links as string[];
  if (m.voice === true) data.voice = true;
  if (m.team === true) data.team = true;
  // Sent by your app rather than the agent: marked by agentdesk's admin API, or a template or
  // automated message your app logged itself.
  if (
    m.context === true ||
    typeof m.template_name === 'string' ||
    message.startsWith('[Automated System Message')
  )
    data.context = true;
  if (str('ref')) data.ref = str('ref');
  if (str('user_id')) data.userId = str('user_id');
  if ('paused_until' in m) data.pausedUntil = (m.paused_until as string | null) ?? null;
  if (role === 'tool') {
    data.tool = {
      name: str('name') ?? 'tool',
      input: (m.args as Record<string, unknown>) ?? {},
      result: message,
      // Rows written by other code may only carry the raw MCP result.
      isError: typeof m.is_error === 'boolean' ? m.is_error : /"isError"\s*:\s*true/.test(message),
    };
  }
  const mediaId = str('whatsapp_media_id');
  const whatsapp: NonNullable<MessageData['whatsapp']> = {
    ...(str('whatsapp_message_id') ? { id: str('whatsapp_message_id') } : {}),
    ...(str('type') ? { type: str('type') } : {}),
    ...(str('profile_name') ? { name: str('profile_name') } : {}),
    ...(Array.isArray(m.wa_message_ids) ? { sent: m.wa_message_ids as string[] } : {}),
    ...(str('send_error') ? { error: str('send_error') } : {}),
    ...(mediaId
      ? {
          media: {
            id: mediaId,
            mimeType: str('mime_type') ?? MEDIA_MIME[str('type') ?? ''] ?? 'application/octet-stream',
            ...(str('caption') ? { caption: str('caption') } : {}),
            ...(str('filename') ? { filename: str('filename') } : {}),
          },
        }
      : {}),
  };
  if (Object.keys(whatsapp).length) data.whatsapp = whatsapp;
  return Object.keys(data).length ? data : null;
}
