import { createHmac, timingSafeEqual } from 'node:crypto';

const GRAPH = 'https://graph.facebook.com';
const TIMEOUT_MS = 15_000;
// WhatsApp's own limit for media the business downloads; bigger files aren't worth sending to a model.
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export interface MetaSettings {
  phoneNumberId: string;
  apiVersion: string;
  token: string;
}

/** A product list section: Meta allows 10 sections and 30 products in all. */
export interface ProductSection {
  title: string;
  retailerIds: string[];
}

/** An error from the Graph API, with Meta's own message. */
export class MetaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** True when `signature` (the X-Hub-Signature-256 header) is Meta's HMAC of `rawBody`. */
export function verifySignature(rawBody: string, signature: string | undefined, appSecret: string): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The few WhatsApp Cloud API calls agentdesk needs. */
export class MetaClient {
  constructor(
    private readonly settings: MetaSettings,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Marks the customer's message read and shows "typing…" (lasts up to 25 s or until we reply). */
  async markReadAndTyping(messageId: string): Promise<void> {
    await this.post('messages', {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    });
  }

  /** Returns the new message's id. */
  async sendText(to: string, text: string): Promise<string> {
    return this.send(to, { type: 'text', text: { body: text, preview_url: true } });
  }

  async sendImage(to: string, link: string, caption: string): Promise<string> {
    return this.send(to, { type: 'image', image: { link, caption } });
  }

  /** A voice note: uploads OGG Opus audio, then sends it. The media id stays downloadable for 30 days. */
  async sendVoice(to: string, ogg: Buffer): Promise<{ messageId: string; mediaId: string }> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', 'audio/ogg');
    form.append('file', new Blob([new Uint8Array(ogg)], { type: 'audio/ogg' }), 'reply.ogg');
    const res = await this.fetchImpl(this.url('media'), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.settings.token}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const { id } = (await this.json(res, 'media upload')) as { id: string };
    return { messageId: await this.send(to, { type: 'audio', audio: { id } }), mediaId: id };
  }

  /** One product from your Meta catalog. */
  async sendProduct(to: string, catalogId: string, retailerId: string, body: string): Promise<string> {
    return this.send(to, {
      type: 'interactive',
      interactive: {
        type: 'product',
        body: { text: body },
        action: { catalog_id: catalogId, product_retailer_id: retailerId },
      },
    });
  }

  async sendProductList(
    to: string,
    catalogId: string,
    header: string,
    body: string,
    sections: ProductSection[],
  ): Promise<string> {
    return this.send(to, {
      type: 'interactive',
      interactive: {
        type: 'product_list',
        header: { type: 'text', text: header.slice(0, 60) },
        body: { text: body.slice(0, 1024) },
        action: {
          catalog_id: catalogId,
          sections: sections.slice(0, 10).map((s) => ({
            title: s.title.slice(0, 24),
            product_items: s.retailerIds.map((id) => ({ product_retailer_id: id })),
          })),
        },
      },
    });
  }

  /** Downloads a media file the customer sent (image, voice note, …). */
  async downloadMedia(mediaId: string): Promise<{ data: Uint8Array; mimeType: string }> {
    const info = await this.fetchImpl(`${GRAPH}/${this.settings.apiVersion}/${mediaId}`, {
      headers: { authorization: `Bearer ${this.settings.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const { url, mime_type, file_size } = (await this.json(info, 'media lookup')) as {
      url: string;
      mime_type: string;
      file_size?: number;
    };
    if (file_size && file_size > MAX_MEDIA_BYTES) throw new MetaError('Media file too large', 413);
    const file = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${this.settings.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!file.ok) throw new MetaError(`Media download failed (${file.status})`, file.status);
    return { data: new Uint8Array(await file.arrayBuffer()), mimeType: mime_type };
  }

  private async send(to: string, message: Record<string, unknown>): Promise<string> {
    const body = await this.post('messages', { messaging_product: 'whatsapp', to, ...message });
    return (body as { messages?: Array<{ id: string }> }).messages?.[0]?.id ?? '';
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchImpl(this.url(path), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.settings.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return this.json(res, path);
  }

  private async json(res: Response, what: string): Promise<unknown> {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } };
    if (!res.ok) {
      throw new MetaError(
        `WhatsApp ${what} failed: ${body.error?.message ?? res.status}`,
        res.status,
        body.error?.code,
      );
    }
    return body;
  }

  private url(path: string): string {
    return `${GRAPH}/${this.settings.apiVersion}/${this.settings.phoneNumberId}/${path}`;
  }
}
