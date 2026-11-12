/** A media file attached to a customer's message. */
export interface InboundMedia {
  id: string;
  mimeType: string;
  caption?: string;
  filename?: string;
}

/** One customer message from a Meta webhook, as agentdesk stores it. */
export interface InboundMessage {
  /** Meta's message id (wamid), used to skip retries. */
  id: string;
  /** The customer's number, digits only, or their business-scoped user id (BSUID). */
  from: string;
  /** Their WhatsApp profile name, when Meta sends it. */
  name?: string;
  type: string;
  /** What the agent and the admin view read, e.g. "[Image] my sticker" or "[Button: Yes]". */
  text: string;
  media?: InboundMedia;
}

interface MetaMessage {
  id?: string;
  from?: string;
  /** A business-scoped user id (e.g. "IN.1349…") for customers who share a username instead of their number. */
  from_user_id?: string;
  type?: string;
  text?: { body?: string };
  image?: MetaMedia;
  audio?: MetaMedia;
  video?: MetaMedia;
  document?: MetaMedia & { filename?: string };
  sticker?: MetaMedia;
  button?: { text?: string };
  interactive?: {
    type?: string;
    button_reply?: { title?: string };
    list_reply?: { title?: string; description?: string };
  };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  contacts?: Array<{ name?: { formatted_name?: string }; phones?: Array<{ phone?: string }> }>;
  order?: {
    product_items?: Array<{
      product_retailer_id?: string;
      quantity?: number;
      item_price?: number;
      currency?: string;
    }>;
  };
}

interface MetaMedia {
  id?: string;
  mime_type?: string;
  caption?: string;
}

interface MetaPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: MetaMessage[];
      };
    }>;
  }>;
}

const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'] as const;
const MEDIA_LABEL: Record<(typeof MEDIA_TYPES)[number], string> = {
  image: 'Image',
  audio: 'Voice note',
  video: 'Video',
  document: 'Document',
  sticker: 'Sticker',
};

/** The customer messages in a webhook body. Delivery statuses and unknown shapes are skipped. */
export function parseWebhook(payload: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of (payload as MetaPayload)?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const names = new Map(
        (value?.contacts ?? []).map((c) => [c.wa_id ?? '', c.profile?.name ?? ''] as const),
      );
      for (const message of value?.messages ?? []) {
        const parsed = parseMessage(message);
        if (!parsed) continue;
        const name = names.get(parsed.from);
        out.push(name ? { ...parsed, name } : parsed);
      }
    }
  }
  return out;
}

function parseMessage(m: MetaMessage): InboundMessage | null {
  const from = customerId(m.from ?? m.from_user_id ?? '');
  if (!m.id || !from || !m.type) return null;
  const base = { id: m.id, from, type: m.type };

  if (m.type === 'text') return { ...base, text: m.text?.body ?? '' };

  if ((MEDIA_TYPES as readonly string[]).includes(m.type)) {
    const type = m.type as (typeof MEDIA_TYPES)[number];
    const media = (m[type] ?? {}) as MetaMedia & { filename?: string };
    if (!media.id) return null;
    const caption = media.caption?.trim();
    const label = [`[${MEDIA_LABEL[type]}]`, media.filename, caption].filter(Boolean).join(' ');
    return {
      ...base,
      text: label,
      media: {
        id: media.id,
        mimeType: media.mime_type ?? 'application/octet-stream',
        ...(caption ? { caption } : {}),
        ...(media.filename ? { filename: media.filename } : {}),
      },
    };
  }

  if (m.type === 'button') return { ...base, text: `[Button: ${m.button?.text ?? ''}]` };

  if (m.type === 'interactive') {
    const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
    if (!reply) return null;
    const description = m.interactive?.list_reply?.description;
    return { ...base, text: `[Selected: ${reply.title ?? ''}${description ? ` (${description})` : ''}]` };
  }

  if (m.type === 'location') {
    const l = m.location ?? {};
    const place = [l.name, l.address].filter(Boolean).join(', ');
    return { ...base, text: `[Location: ${place ? `${place}, ` : ''}${l.latitude}, ${l.longitude}]` };
  }

  if (m.type === 'contacts') {
    const list = (m.contacts ?? []).map((c) =>
      `${c.name?.formatted_name ?? ''} ${c.phones?.map((p) => p.phone).join(', ') ?? ''}`.trim(),
    );
    return { ...base, text: `[Contacts: ${list.join('; ')}]` };
  }

  if (m.type === 'order') {
    const items = (m.order?.product_items ?? []).map((i) =>
      `${i.product_retailer_id} x${i.quantity ?? 1} (${i.item_price ?? '?'} ${i.currency ?? ''})`.trim(),
    );
    return { ...base, text: `[Order from the catalog: ${items.join(', ')}]` };
  }

  // Reactions, unsupported and system messages: nothing for the agent to answer.
  return null;
}

/** True for a business-scoped user id ("IN.1349…", "IN.ENT.1181…") rather than a phone number. */
export function isUserId(id: string): boolean {
  return /^[A-Z]{2}\./.test(id);
}

/** A phone number as digits only; a business-scoped user id as is. */
function customerId(raw: string): string {
  return isUserId(raw) ? raw : raw.replace(/\D/g, '');
}
