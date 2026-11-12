import { randomUUID } from 'node:crypto';
import type { LanguageModel, ModelMessage } from 'ai';
import { answer, UNAVAILABLE_REPLY } from '../agent/answer.js';
import type { AgentLoopParams } from '../agent/loop.js';
import type { McpTools } from '../agent/mcp.js';
import { basePrompt, recentTurnsNote, voiceCallNote, webChatNote } from '../agent/prompt.js';
import { isOnHosts, type ToolRunner } from '../agent/tools.js';
import type { Config, Limit, Secrets } from '../config.js';
import { type Identity, identityNote } from '../identity.js';
import type { Alert, Logger } from '../logger.js';
import type { ChatState } from '../state.js';
import type { MessageData, Store, StoredMessage } from '../store/store.js';
import { buildLiveSetup, liveToolDeclarations, mintLiveToken } from '../voice/gemini-live.js';

export const CHANNEL = 'web';
// What the chat window shows; the agent reads `agent.historyLimit` itself.
const VISIBLE_MESSAGES = 80;
// Typed turns a voice call gets, so it continues the chat.
const VOICE_CONTEXT_TURNS = 10;

export { UNAVAILABLE_REPLY };

/** An error the visitor may see, with the HTTP status to answer with. */
export class ChatError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** A message as the widget shows it. */
export interface WidgetMessage extends Pick<MessageData, 'cards' | 'login' | 'links' | 'voice' | 'team'> {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}

export interface VoiceTurn {
  role: 'user' | 'assistant';
  text: string;
  links?: string[];
}

export interface WebChatDeps {
  config: Config;
  secrets: Secrets;
  ownPrompt: string;
  store: Store;
  state: ChatState;
  tools: ToolRunner;
  mcp?: McpTools;
  model: LanguageModel;
  providerOptions?: AgentLoopParams['providerOptions'];
  log: Logger;
  alert: Alert;
  fetchImpl?: typeof fetch;
}

/** Key of a website conversation in the store (the browser keeps the random id). */
export const conversationKey = (id: string) => `${CHANNEL}:${id}`;

/**
 * The website chat: stores messages, runs the agent in the background (the widget polls
 * for the reply) and starts voice calls the browser opens itself.
 */
export class WebChat {
  constructor(private readonly deps: WebChatDeps) {}

  get voiceAvailable(): boolean {
    return Boolean(this.deps.config.voice && this.deps.secrets.geminiApiKey);
  }

  /** The chat so far, whether the agent is writing, and whether voice is on. */
  async snapshot(id: string) {
    const key = conversationKey(id);
    const rows = await this.deps.store.recent(key, VISIBLE_MESSAGES);
    return {
      messages: rows.filter((r) => r.text).map(toWidgetMessage),
      busy: this.deps.state.isBusy(key),
      voiceAvailable: this.voiceAvailable,
    };
  }

  /** Stores the visitor's message and starts the agent; returns at once (a reply can take 10–40 s). */
  async send(id: string, text: string, identity: Identity | null, ip: string): Promise<void> {
    const { limits } = this.deps.config;
    const key = conversationKey(id);
    this.enforce(
      [
        [`msg:c:${key}`, limits.messagesPerConversation],
        [`msg:ip:${ip}`, limits.messagesPerIp],
      ],
      'You are sending messages too fast. Please wait a few minutes.',
    );

    const version = this.deps.state.nextVersion(key);
    await this.deps.store.add({
      conversationId: key,
      channel: CHANNEL,
      role: 'user',
      text,
      data: identity ? { userId: identity.sub } : null,
    });
    this.deps.state.setBusy(key, true);
    void this.reply(key, identity, version).catch((error: unknown) =>
      this.deps.log.error(`Reply crashed for ${key}: ${String(error)}`),
    );
  }

  /** A message from your team (admin API), shown in the chat. */
  async teamReply(conversationId: string, text: string): Promise<StoredMessage> {
    return this.deps.store.add({
      conversationId,
      channel: CHANNEL,
      role: 'assistant',
      text,
      data: { team: true },
    });
  }

  /** Starts a voice call: a Gemini Live session with the same prompt and tools, opened by the browser. */
  async startVoice(id: string, identity: Identity | null, ip: string) {
    const { config, secrets, state } = this.deps;
    const voice = config.voice;
    if (!voice || !secrets.geminiApiKey) {
      throw new ChatError(503, 'Voice chat is not available right now. Please type your question.');
    }
    const key = conversationKey(id);
    this.enforce(
      [
        [`voice:c:${key}`, config.limits.voiceCallsPerConversation],
        [`voice:ip:${ip}`, config.limits.voiceCallsPerIp],
        ['voice:day', config.limits.voiceCallsPerDay],
      ],
      'Voice chat is busy right now. Please type your question, or try again later.',
    );

    try {
      const [instructions, specs, recent] = await Promise.all([
        this.instructions(),
        this.deps.tools.specs(),
        this.deps.store.recent(key, VOICE_CONTEXT_TURNS),
      ]);
      const instruction = [
        instructions,
        voiceCallNote(config),
        identityNote(identity),
        recentTurnsNote(
          recent.filter((m) => m.text).map((m) => ({ role: m.role, text: m.text })),
          config.agent.name,
        ),
      ]
        .filter(Boolean)
        .join('\n');

      const setup = buildLiveSetup(voice, instruction, liveToolDeclarations(specs));
      const token = await mintLiveToken(secrets.geminiApiKey, voice, setup, this.deps.fetchImpl);
      const sessionId = randomUUID();
      // The token stops at maxMinutes + 1; the transcript is saved right after the call.
      state.registerVoiceCall(sessionId, key, (voice.maxMinutes + 5) * 60_000);
      return { sessionId, token, wsUrl: voice.wsUrl, setup, maxSeconds: voice.maxMinutes * 60 };
    } catch (error) {
      if (error instanceof ChatError) throw error;
      this.deps.alert('voice-start', `Voice call could not start: ${String(error)}`);
      throw new ChatError(500, 'Voice chat could not start. Please type your question.');
    }
  }

  /** Runs a tool Gemini asked for during a call (Gemini sends the call to the browser, which passes it here). */
  async voiceTool(
    id: string,
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
    identity: Identity | null,
  ) {
    const key = conversationKey(id);
    this.assertVoiceCall(sessionId, key);
    this.enforce(
      [[`voice-tool:${sessionId}`, this.deps.config.limits.voiceToolCallsPerCall]],
      'Too many requests in this call.',
    );
    const output = await this.deps.tools.run(name, args, { conversationId: key, channel: CHANNEL, identity });
    return {
      response: output.isError ? { error: output.content } : { result: output.content },
      ...output.attachments,
    };
  }

  /** Saves a call's transcript into the chat, so a reload shows it and the typed chat continues from it. */
  async saveVoiceTurns(id: string, sessionId: string, turns: VoiceTurn[]): Promise<number> {
    const key = conversationKey(id);
    this.assertVoiceCall(sessionId, key);
    const hosts = this.deps.config.web.linkHosts;
    // One at a time, so the rows keep their order.
    for (const turn of turns) {
      // Only links on your own hosts: the browser could send anything.
      const links = turn.links?.filter((url) => isOnHosts(url, hosts));
      await this.deps.store.add({
        conversationId: key,
        channel: CHANNEL,
        role: turn.role,
        text: turn.text,
        data: { voice: true, ...(links?.length ? { links } : {}) },
      });
    }
    return turns.length;
  }

  /** Writes the agent's reply to the latest message. A newer message cancels this run; the newer run answers both. */
  private async reply(key: string, identity: Identity | null, version: number): Promise<void> {
    const { state, store, config } = this.deps;
    const isCancelled = () => state.isStale(key, version);
    try {
      const [instructions, history] = await Promise.all([
        this.instructions(),
        store.recent(key, config.agent.historyLimit),
      ]);
      const messages = toModelMessages(history);
      const last = messages.at(-1);
      if (last?.role !== 'user') return; // nothing new to answer
      last.content = `${identityNote(identity)}\n${last.content as string}`;

      const reply = await answer(this.deps, {
        instructions,
        messages,
        context: { conversationId: key, channel: CHANNEL, identity },
        isCancelled,
      });
      if (!reply) return;
      // Links are only shown under voice replies; a typed reply already has them.
      const { links: _links, ...shown } = reply.attachments;
      await this.storeReply(key, reply.text, shown);
    } catch (error) {
      this.deps.alert('reply-failed', `Reply failed for ${key}: ${String(error)}`);
      if (!isCancelled()) await this.storeReply(key, UNAVAILABLE_REPLY, {}).catch(() => {});
    } finally {
      // A newer run owns the flag once it started.
      if (!isCancelled()) state.setBusy(key, false);
    }
  }

  private async storeReply(key: string, text: string, data: MessageData): Promise<void> {
    await this.deps.store.add({
      conversationId: key,
      channel: CHANNEL,
      role: 'assistant',
      text,
      data: Object.keys(data).length ? data : null,
    });
  }

  private async instructions(): Promise<string> {
    const fromMcp = this.deps.mcp ? await this.deps.mcp.prompt() : '';
    return `${basePrompt(this.deps.ownPrompt, fromMcp, this.deps.config.agent.name)}\n\n${webChatNote(this.deps.config)}`;
  }

  private assertVoiceCall(sessionId: string, key: string): void {
    if (!this.deps.state.voiceCallBelongsTo(sessionId, key)) {
      throw new ChatError(403, 'This voice call has ended.');
    }
  }

  private enforce(checks: Array<[string, Limit]>, message: string): void {
    for (const [key, limit] of checks) {
      if (!this.deps.state.take(key, limit)) throw new ChatError(429, message);
    }
  }
}

function toWidgetMessage(row: StoredMessage): WidgetMessage {
  const { cards, login, links, voice, team } = row.data ?? {};
  return {
    id: row.id,
    role: row.role === 'user' ? 'user' : 'assistant',
    text: row.text,
    createdAt: row.createdAt,
    ...(cards ? { cards } : {}),
    ...(login ? { login } : {}),
    ...(links ? { links } : {}),
    ...(voice ? { voice } : {}),
    ...(team ? { team } : {}),
  };
}

/** Stored text turns as model messages; the conversation must start with a user turn. */
export function toModelMessages(rows: StoredMessage[]): ModelMessage[] {
  const messages: ModelMessage[] = rows
    .filter((r) => r.role !== 'tool' && r.text.trim())
    .map((r) => ({ role: r.role === 'user' ? 'user' : 'assistant', content: r.text }));
  if (messages[0] && messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: '[System: earlier messages from the team]' });
  }
  return messages;
}
