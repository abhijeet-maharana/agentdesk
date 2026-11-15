/**
 * Who wrote a stored message. `tool` rows record the agent's tool calls (never shown to the
 * visitor); `system` rows record events such as your team pausing the agent.
 */
export type Role = 'user' | 'assistant' | 'tool' | 'system';

/** A card shown in the chat, e.g. a product (photo, title, price, link). */
export interface Card {
  id: string;
  title: string;
  subtitle?: string;
  /** A number is shown with the widget's currency; a string as is. */
  price?: number | string;
  originalPrice?: number | string;
  image?: string;
  url: string;
}

/** Extra data on a stored message. */
export interface MessageData {
  /** Cards shown under a reply. */
  cards?: Card[];
  /** Show the "Log in" button under this reply. */
  login?: boolean;
  /** Links shown under a voice reply. */
  links?: string[];
  /** Said on a voice call (transcript). */
  voice?: boolean;
  /** Written by a person from your team (admin API). */
  team?: boolean;
  /** On a visitor's message: who was logged in when it was sent. */
  userId?: string;
  /** On a tool row: the call and its raw result. */
  tool?: { name: string; input: Record<string, unknown>; result: string; isError: boolean };
  /** Sent to the customer by your own app, not by the agent (admin API `context`). The agent reads it. */
  context?: boolean;
  /** Your own id for a `context` message. */
  ref?: string;
  /** On a `system` row: the agent stays quiet in this chat until then (null: resumed). */
  pausedUntil?: string | null;
  /** WhatsApp details: the customer's message id, type and media, or the ids of what was sent. */
  whatsapp?: {
    id?: string;
    type?: string;
    name?: string;
    media?: { id: string; mimeType: string; caption?: string; filename?: string };
    sent?: string[];
    error?: string;
  };
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  channel: string;
  role: Role;
  text: string;
  data: MessageData | null;
  createdAt: string;
}

export interface NewMessage {
  conversationId: string;
  channel: string;
  role: Role;
  text: string;
  data?: MessageData | null;
  /** Defaults to now. */
  createdAt?: string;
}

export interface ConversationSummary {
  conversationId: string;
  channel: string;
  lastMessage: string;
  lastRole: Role;
  lastAt: string;
  messages: number;
  /** The customer's messages since your team last opened the chat. */
  unread: number;
  starred: boolean;
  /** Set while your team has paused the agent here. */
  pausedUntil: string | null;
  /** The customer's name, e.g. their WhatsApp profile name. */
  name: string | null;
  /** The customer's latest message (WhatsApp's 24-hour reply window counts from it). */
  lastCustomerAt: string | null;
}

/** Which conversations to list, newest first. */
export interface ConversationQuery {
  limit: number;
  /** Only conversations whose latest message is older than this (paging). */
  before?: string;
  /** In the conversation id, the customer's name or any message text, case-insensitive. */
  search?: string;
  starredOnly?: boolean;
  channel?: string;
}

/**
 * The digits of a search that looks like a phone number, e.g. `+91 98765-43210` → `919876543210`,
 * so it matches the bare digits a WhatsApp chat is stored under. Null for any other search.
 */
export function phoneDigits(search: string): string | null {
  if (!/^[\d\s+\-().]+$/.test(search)) return null;
  const digits = search.replace(/\D/g, '');
  return digits || null;
}

/** Where chats are kept: Postgres in production, memory for a quick try. */
export interface Store {
  init(): Promise<void>;
  add(message: NewMessage): Promise<StoredMessage>;
  /** The latest `limit` messages, oldest first. */
  recent(conversationId: string, limit: number, opts?: { includeTools?: boolean }): Promise<StoredMessage[]>;
  conversations(query: ConversationQuery): Promise<ConversationSummary[]>;
  /** Your team has read the conversation up to now. */
  markRead(conversationId: string): Promise<void>;
  setStarred(conversationId: string, starred: boolean): Promise<void>;
  /** Deletes messages created before `cutoff`; returns how many. */
  deleteBefore(cutoff: Date): Promise<number>;
  /** Until when the agent stays quiet in this conversation (your team took over), or null. */
  pausedUntil(conversationId: string): Promise<Date | null>;
  setPausedUntil(conversationId: string, until: Date | null): Promise<void>;
  close(): Promise<void>;
}

/** The message is already stored (the same WhatsApp message id came twice). */
export class DuplicateMessageError extends Error {}
