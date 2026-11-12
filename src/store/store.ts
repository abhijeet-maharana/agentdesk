/** Who wrote a stored message. `tool` rows record the agent's tool calls (never shown to the visitor). */
export type Role = 'user' | 'assistant' | 'tool';

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
  /** Copied in from your own records (admin API `import`), not written in this chat. */
  imported?: boolean;
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
  /** Defaults to now; set for imported history. */
  createdAt?: string;
}

export interface ConversationSummary {
  conversationId: string;
  channel: string;
  lastMessage: string;
  lastRole: Role;
  lastAt: string;
  messages: number;
}

/** Where chats are kept: Postgres in production, memory for a quick try. */
export interface Store {
  init(): Promise<void>;
  add(message: NewMessage): Promise<StoredMessage>;
  /** The latest `limit` messages, oldest first. */
  recent(conversationId: string, limit: number, opts?: { includeTools?: boolean }): Promise<StoredMessage[]>;
  conversations(limit: number): Promise<ConversationSummary[]>;
  /** Deletes messages created before `cutoff`; returns how many. */
  deleteBefore(cutoff: Date): Promise<number>;
  /** Until when the agent stays quiet in this conversation (your team took over), or null. */
  pausedUntil(conversationId: string): Promise<Date | null>;
  setPausedUntil(conversationId: string, until: Date | null): Promise<void>;
  close(): Promise<void>;
}
