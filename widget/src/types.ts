import type { ReactNode } from 'react';

/** A card under a reply, e.g. a product: photo, title, price, link. */
export interface Card {
  id: string;
  title: string;
  subtitle?: string;
  /** A number is shown with the currency; a string as is. */
  price?: number | string;
  originalPrice?: number | string;
  image?: string;
  url: string;
}

export interface AgentChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  cards?: Card[];
  /** Show the "Log in" button under the reply. */
  login?: boolean;
  /** Links shown under a voice reply (the voice never reads URLs out). */
  links?: string[];
  /** Said on a voice call. */
  voice?: boolean;
  /** Written by a person from your team. */
  team?: boolean;
  /** Sent from this browser, not yet confirmed by the server. */
  pending?: boolean;
}

export interface ChatSnapshot {
  messages: AgentChatMessage[];
  /** The agent is writing a reply: show "typing…" and keep polling. */
  busy: boolean;
  /** The server can start voice calls. */
  voiceAvailable: boolean;
}

/** What starting a voice call returns: a Gemini Live session the browser opens itself. */
export interface VoiceStart {
  sessionId: string;
  wsUrl: string;
  /** Short-lived Gemini token, minted by the server. */
  token: string;
  /** The BidiGenerateContentSetup message, `{ setup: {...} }`. */
  setup: { setup: Record<string, unknown> };
  /** The call ends by itself after this. */
  maxSeconds: number;
}

export interface VoiceToolResult {
  /** Sent back to Gemini as the function response. */
  response: Record<string, unknown>;
  cards?: Card[];
  login?: boolean;
  links?: string[];
}

export interface VoiceTurn {
  role: 'user' | 'assistant';
  text: string;
  links?: string[];
}

/** How the widget talks to the agentdesk server. The widget never holds API keys. */
export interface AgentChatTransport {
  load(): Promise<ChatSnapshot>;
  /** Store the message and start the agent; the reply arrives through `load()`. */
  send(text: string): Promise<void>;
  voice?: {
    start(): Promise<VoiceStart>;
    runTool(sessionId: string, name: string, args: Record<string, unknown>): Promise<VoiceToolResult>;
    saveTranscript(sessionId: string, turns: VoiceTurn[]): Promise<void>;
  };
}

export interface AgentChatChip {
  id: string;
  label: string;
  /** Sent as the visitor's message when tapped. */
  text: string;
  icon?: ReactNode;
}

export type AgentChatEvent =
  | 'open'
  | 'close'
  | 'message_sent'
  | 'chip_clicked'
  | 'login_clicked'
  | 'voice_started'
  | 'voice_ended'
  | 'voice_failed';
