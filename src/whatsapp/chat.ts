import type { ImagePart, LanguageModel, ModelMessage, TextPart } from 'ai';
import { type Answer, answer, UNAVAILABLE_REPLY } from '../agent/answer.js';
import type { AgentLoopParams } from '../agent/loop.js';
import type { McpTools } from '../agent/mcp.js';
import { basePrompt, whatsappNote } from '../agent/prompt.js';
import type { ToolRunner } from '../agent/tools.js';
import type { Config, Secrets } from '../config.js';
import { type Identity, verifyIdentity } from '../identity.js';
import type { Alert, Logger } from '../logger.js';
import type { ChatState } from '../state.js';
import {
  type Card,
  DuplicateMessageError,
  type MessageData,
  type Store,
  type StoredMessage,
} from '../store/store.js';
import type { Audio } from './audio.js';
import type { MetaClient } from './meta.js';
import { type InboundMessage, isUserId, parseWebhook } from './parse.js';

export const CHANNEL = 'whatsapp';
export const whatsappKey = (phone: string) => `${CHANNEL}:${phone}`;

// Meta retries a webhook for up to a day, but almost always within minutes.
const SEEN_TTL_MS = 60 * 60_000;
// The typing indicator lasts ~25 s; renew it while the agent works, but not forever.
const TYPING_EVERY_MS = 20_000;
const TYPING_MAX = 15;
const VOICE_NOTES_IN_CONTEXT = 2;
const IDENTITY_TTL_MS = 10 * 60_000;
const BUBBLE_GAP_MS = 500;
const MAX_CACHED = 500;

export interface WhatsAppChatDeps {
  config: Config;
  secrets: Secrets;
  ownPrompt: string;
  store: Store;
  state: ChatState;
  tools: ToolRunner;
  mcp?: McpTools;
  model: LanguageModel;
  providerOptions?: AgentLoopParams['providerOptions'];
  meta: MetaClient;
  audio?: Audio;
  log: Logger;
  alert: Alert;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The WhatsApp channel: takes Meta webhooks, stores each message, and answers the latest one
 * per customer. A newer message cancels the running reply, as on the website.
 */
export class WhatsAppChat {
  private readonly seen = new Map<string, number>();
  private readonly transcripts = new Map<string, string>();
  private readonly identities = new Map<string, { identity: Identity | null; until: number }>();

  constructor(private readonly deps: WhatsAppChatDeps) {}

  private get settings() {
    const settings = this.deps.config.whatsapp;
    if (!settings) throw new Error('WhatsApp is not configured');
    return settings;
  }

  /**
   * Handles one webhook body. Returns how many new customer messages it had.
   * - `reply: false`: store only (e.g. while your app has its AI switched off).
   * - `stored: true`: your app already wrote them to the shared chat table; just answer.
   */
  async receive(
    payload: unknown,
    { reply = true, stored = false }: { reply?: boolean; stored?: boolean } = {},
  ): Promise<number> {
    const latest = new Map<string, InboundMessage>();
    for (const message of parseWebhook(payload)) {
      if (this.isDuplicate(message.id)) continue;
      if (!stored) {
        const { id, type, name, media } = message;
        try {
          await this.deps.store.add({
            conversationId: whatsappKey(message.from),
            channel: CHANNEL,
            role: 'user',
            text: message.text,
            data: { whatsapp: { id, type, ...(name ? { name } : {}), ...(media ? { media } : {}) } },
          });
        } catch (error) {
          if (error instanceof DuplicateMessageError) continue; // Meta sent it again
          throw error;
        }
      }
      latest.set(message.from, message);
    }

    for (const [phone, message] of latest) {
      if (!reply) break;
      const key = whatsappKey(phone);
      // Your team took over this chat: stored above, the agent stays quiet.
      if (await this.deps.store.pausedUntil(key)) continue;
      if (!this.deps.state.take(`wa-replies:${key}`, this.deps.config.limits.repliesPerWhatsAppNumber)) {
        this.deps.log.warn(`${key} is over its reply limit; message stored, not answered`);
        continue;
      }
      const version = this.deps.state.nextVersion(key);
      void this.reply(phone, { latest: message }, version).catch((error: unknown) =>
        this.deps.log.error(`WhatsApp reply crashed for ${key}: ${String(error)}`),
      );
    }
    return latest.size;
  }

  /** A media file from this number's chats, for the inbox (Meta keeps them for about 30 days). */
  media(mediaId: string): Promise<{ data: Uint8Array; mimeType: string }> {
    return this.deps.meta.downloadMedia(mediaId);
  }

  /** A message from your team (admin API): sent on WhatsApp, then stored. */
  async teamReply(conversationId: string, text: string): Promise<StoredMessage> {
    const phone = conversationId.slice(CHANNEL.length + 1);
    const id = await this.deps.meta.sendText(phone, text);
    return this.deps.store.add({
      conversationId,
      channel: CHANNEL,
      role: 'assistant',
      text,
      data: { team: true, whatsapp: { sent: [id] } },
    });
  }

  /**
   * Has the agent write to the customer now, without a new message from them: `note` tells it
   * why (e.g. "30 minutes have passed since they activated their sticker"). The note is neither
   * sent nor stored. Inside WhatsApp's 24-hour window only, which Meta enforces.
   */
  async nudge(conversationId: string, note: string): Promise<void> {
    if (await this.deps.store.pausedUntil(conversationId)) return;
    const phone = conversationId.slice(CHANNEL.length + 1);
    const version = this.deps.state.nextVersion(conversationId);
    await this.reply(phone, { note }, version);
  }

  private async reply(
    phone: string,
    trigger: { latest: InboundMessage } | { note: string },
    version: number,
  ): Promise<void> {
    const key = whatsappKey(phone);
    const isCancelled = () => this.deps.state.isStale(key, version);
    const latest = 'latest' in trigger ? trigger.latest : undefined;
    const stopTyping = latest ? this.keepTyping(latest.id, isCancelled) : () => {};
    try {
      const [instructions, history, identity] = await Promise.all([
        this.instructions(),
        this.deps.store.recent(key, this.deps.config.agent.historyLimit),
        this.identity(phone),
      ]);
      const messages = await this.toModelMessages(history);
      if ('note' in trigger) messages.push({ role: 'user', content: `[System: ${trigger.note}]` });
      const last = messages.at(-1);
      if (last?.role !== 'user') return;
      prepend(
        last,
        customerNote(
          phone,
          latest?.name ?? history.findLast((r) => r.data?.whatsapp?.name)?.data?.whatsapp?.name,
          identity,
        ),
      );

      const reply = await answer(this.deps, {
        instructions,
        messages,
        context: { conversationId: key, channel: CHANNEL, identity, phone },
        isCancelled,
      });
      // A nudge with no usable answer stays silent: the customer didn't ask anything.
      if (reply && !isCancelled() && (latest || reply.text !== UNAVAILABLE_REPLY)) {
        await this.send(phone, reply, latest ? history.at(-1) : undefined, isCancelled);
      }
    } catch (error) {
      this.deps.alert('whatsapp-reply', `WhatsApp reply failed for ${key}: ${String(error)}`);
      if (latest && !isCancelled())
        await this.send(phone, { text: UNAVAILABLE_REPLY, attachments: {} }, undefined, isCancelled);
    } finally {
      stopTyping();
    }
  }

  /**
   * Sends the reply (text bubbles, maybe a voice note, then cards), storing each message as it
   * goes, so the chat shows exactly what the customer got.
   */
  private async send(
    phone: string,
    reply: NonNullable<Answer>,
    customerRow: StoredMessage | undefined,
    isCancelled: () => boolean,
  ): Promise<void> {
    const { meta, audio, alert } = this.deps;
    const bubbles = splitBubbles(reply.text);
    const cards = reply.attachments.cards ?? [];
    const store = (text: string, data: MessageData) =>
      this.deps.store.add({
        conversationId: whatsappKey(phone),
        channel: CHANNEL,
        role: 'assistant',
        text,
        data,
      });

    for (const [i, bubble] of bubbles.entries()) {
      if (isCancelled()) return;
      if (i > 0) await this.sleep(BUBBLE_GAP_MS);
      try {
        if (i === 0 && audio?.canSpeak && this.wantsVoice(customerRow)) {
          try {
            const voice = await meta.sendVoice(phone, await audio.speak(bubble));
            await store(bubble, {
              voice: true,
              whatsapp: {
                type: 'audio',
                sent: [voice.messageId],
                media: { id: voice.mediaId, mimeType: 'audio/ogg' },
              },
            });
            if (!new RegExp(this.settings.audio?.alsoAsTextPattern ?? 'https?://', 'i').test(bubble))
              continue;
          } catch (voiceError) {
            alert('whatsapp-voice', `Voice reply failed for ${phone}, sent as text: ${String(voiceError)}`);
          }
        }
        await store(bubble, { whatsapp: { sent: [await meta.sendText(phone, bubble)] } });
      } catch (sendError) {
        alert('whatsapp-send', `Sending to ${phone} failed: ${String(sendError)}`);
        await store(bubbles.slice(i).join('\n---\n'), { whatsapp: { error: String(sendError) } });
        return;
      }
    }

    if (cards.length && !isCancelled()) {
      try {
        const sent = await this.sendCards(phone, cards);
        await store(`[Products: ${cards.map((c) => c.title).join(', ')}]`, { cards, whatsapp: { sent } });
      } catch (sendError) {
        alert('whatsapp-send', `Sending cards to ${phone} failed: ${String(sendError)}`);
      }
    }
  }

  /** Cards as a catalog message when `whatsapp.catalog` is set, else as photos with a caption and link. */
  private async sendCards(phone: string, cards: Card[]): Promise<string[]> {
    const { meta, alert } = this.deps;
    const catalog = this.settings.catalog;
    if (catalog) {
      try {
        const [only] = cards;
        if (cards.length === 1 && only)
          return [await meta.sendProduct(phone, catalog.id, only.id, catalog.body)];
        const section = { title: catalog.header, retailerIds: cards.map((c) => c.id).slice(0, 30) };
        return [await meta.sendProductList(phone, catalog.id, catalog.header, catalog.body, [section])];
      } catch (error) {
        alert('whatsapp-catalog', `Catalog message failed for ${phone}, sending photos: ${String(error)}`);
      }
    }
    const currency = this.deps.config.web.widget.currency;
    const ids: string[] = [];
    for (const card of cards) {
      const price = typeof card.price === 'number' ? `${currency}${card.price}` : card.price;
      const caption = [`*${card.title}*`, card.subtitle, price, card.url].filter(Boolean).join('\n');
      ids.push(
        card.image ? await meta.sendImage(phone, card.image, caption) : await meta.sendText(phone, caption),
      );
    }
    return ids;
  }

  /** Voice back to a voice note, or when asked; never when the customer asked for text. */
  private wantsVoice(row: StoredMessage | undefined): boolean {
    const audio = this.settings.audio;
    if (!audio || row?.role !== 'user') return false;
    const isVoiceNote = row.data?.whatsapp?.type === 'audio';
    const mediaId = row.data?.whatsapp?.media?.id;
    const words = isVoiceNote && mediaId ? (this.transcripts.get(mediaId) ?? '') : row.text;
    if (audio.textRequestPattern && new RegExp(audio.textRequestPattern, 'i').test(words)) return false;
    if (isVoiceNote) return true;
    return Boolean(audio.voiceRequestPattern && new RegExp(audio.voiceRequestPattern, 'i').test(words));
  }

  /**
   * Stored turns as model messages: the newest photos attached, the newest voice notes
   * transcribed, and messages your app sent marked as such.
   */
  private async toModelMessages(rows: StoredMessage[]): Promise<ModelMessage[]> {
    const turns = rows.filter((r) => r.role !== 'tool' && r.text.trim());
    const media = (kind: string) =>
      turns
        .filter((r) => r.role === 'user' && r.data?.whatsapp?.media?.mimeType.startsWith(kind))
        .slice(-(kind === 'image' ? this.settings.imagesInContext : VOICE_NOTES_IN_CONTEXT))
        .map((r) => r.id);
    const images = new Set(media('image'));
    const voiceNotes = new Set(media('audio'));

    const messages = await Promise.all(
      turns.map(async (row): Promise<ModelMessage> => {
        if (row.role !== 'user') {
          const text =
            row.data?.context && !row.text.startsWith('[') ? `[Sent by our system] ${row.text}` : row.text;
          return { role: 'assistant', content: text };
        }
        const file = row.data?.whatsapp?.media;
        if (file && voiceNotes.has(row.id)) return { role: 'user', content: await this.voiceNoteText(file) };
        if (file && images.has(row.id))
          return { role: 'user', content: await this.withImage(row.text, file) };
        return { role: 'user', content: row.text };
      }),
    );
    if (messages[0] && messages[0].role !== 'user') {
      messages.unshift({ role: 'user', content: '[System: earlier messages from the business]' });
    }
    return messages;
  }

  private async withImage(
    text: string,
    file: { id: string; mimeType: string },
  ): Promise<Array<TextPart | ImagePart>> {
    try {
      const { data, mimeType } = await this.deps.meta.downloadMedia(file.id);
      return [
        { type: 'text', text },
        { type: 'image', image: data, mediaType: mimeType },
      ];
    } catch (error) {
      this.deps.log.warn(`Photo ${file.id} could not be loaded: ${String(error)}`);
      return [{ type: 'text', text: `${text} (the photo could not be loaded)` }];
    }
  }

  private async voiceNoteText(file: { id: string; mimeType: string }): Promise<string> {
    const cached = this.transcripts.get(file.id);
    if (cached) return `[Voice note] ${cached}`;
    const failed = '[Voice note that could not be transcribed. Ask the customer to type their message.]';
    if (!this.deps.audio) return failed;
    try {
      const { data, mimeType } = await this.deps.meta.downloadMedia(file.id);
      const text = await this.deps.audio.transcribe(data, mimeType);
      if (!text) return '[Voice note with no speech]';
      remember(this.transcripts, file.id, text);
      return `[Voice note] ${text}`;
    } catch (error) {
      this.deps.log.warn(`Voice note ${file.id} could not be transcribed: ${String(error)}`);
      return failed;
    }
  }

  /** The customer as your app knows them (`whatsapp.identityUrl`), cached for a few minutes. */
  private async identity(phone: string): Promise<Identity | null> {
    const url = this.settings.identityUrl;
    if (!url) return null;
    const cached = this.identities.get(phone);
    if (cached && cached.until > Date.now()) return cached.identity;
    try {
      const res = await (this.deps.fetchImpl ?? fetch)(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.deps.secrets.adminToken ?? ''}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ phone }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { token } = (await res.json()) as { token?: string };
      const identity = token
        ? await verifyIdentity(`Bearer ${token}`, this.deps.secrets.identitySecret)
        : null;
      this.identities.set(phone, { identity, until: Date.now() + IDENTITY_TTL_MS });
      return identity;
    } catch (error) {
      this.deps.alert('whatsapp-identity', `Identity lookup failed for ${phone}: ${String(error)}`);
      return null;
    }
  }

  private keepTyping(messageId: string, isCancelled: () => boolean): () => void {
    let count = 0;
    const tick = () => {
      if (isCancelled() || count++ >= TYPING_MAX) return clearInterval(timer);
      this.deps.meta
        .markReadAndTyping(messageId)
        .catch((error: unknown) => this.deps.log.warn(`Typing indicator failed: ${String(error)}`));
    };
    const timer = setInterval(tick, TYPING_EVERY_MS);
    tick();
    return () => clearInterval(timer);
  }

  private isDuplicate(messageId: string): boolean {
    const now = Date.now();
    if (this.seen.size > 5_000) for (const [id, until] of this.seen) if (until <= now) this.seen.delete(id);
    if ((this.seen.get(messageId) ?? 0) > now) return true;
    this.seen.set(messageId, now + SEEN_TTL_MS);
    return false;
  }

  private async instructions(): Promise<string> {
    const fromMcp = this.deps.mcp ? await this.deps.mcp.prompt() : '';
    return `${basePrompt(this.deps.ownPrompt, fromMcp, this.deps.config.agent.name)}\n\n${whatsappNote(this.deps.config)}`;
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** One line the agent reads with the customer's latest message (not stored). */
export function customerNote(phone: string, name: string | undefined, identity: Identity | null): string {
  const number = isUserId(phone) ? 'number not shared (WhatsApp username)' : `+${phone}`;
  const who = [number, name && `profile name "${name}"`].filter(Boolean).join(', ');
  if (!identity) return `[WhatsApp: ${who}.]`;
  return `[WhatsApp: ${who}. Known customer${identity.name ? ` ${identity.name}` : ''}.${identity.note ? ` ${identity.note}` : ''}]`;
}

/** Splits a reply into messages on "---" lines. */
export function splitBubbles(text: string): string[] {
  return text
    .split(/^\s*---\s*$/m)
    .map((part) => part.trim())
    .filter(Boolean);
}

function prepend(message: ModelMessage, line: string): void {
  if (typeof message.content === 'string') message.content = `${line}\n${message.content}`;
  else if (Array.isArray(message.content) && message.role === 'user') {
    message.content = [{ type: 'text', text: line }, ...message.content];
  }
}

function remember(map: Map<string, string>, key: string, value: string): void {
  if (map.size >= MAX_CACHED) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}
