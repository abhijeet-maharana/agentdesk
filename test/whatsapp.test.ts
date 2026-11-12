import { createHmac } from 'node:crypto';
import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { ToolRunner } from '../src/agent/tools.js';
import { parseConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { createApp } from '../src/server.js';
import { ChatState } from '../src/state.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { WebChat } from '../src/web/chat.js';
import type { Audio } from '../src/whatsapp/audio.js';
import { customerNote, splitBubbles, WhatsAppChat, whatsappKey } from '../src/whatsapp/chat.js';
import { MetaClient, verifySignature } from '../src/whatsapp/meta.js';
import { parseWebhook } from '../src/whatsapp/parse.js';
import { eventually, fakeMcp, mockModel, text, toolCall } from './helpers.js';

const APP_SECRET = 'meta-app-secret';
const IDENTITY_SECRET = 'test-secret-that-is-long-enough-123';
const PHONE = '919876543210';

const ordersTool = {
  name: 'my_orders',
  inputSchema: {
    type: 'object' as const,
    properties: { user_token: { type: 'string' } },
    required: ['user_token'],
  },
};
const productsTool = { name: 'list_products', inputSchema: { type: 'object' as const, properties: {} } };

const webhook = (...messages: Array<Record<string, unknown>>) => ({
  entry: [
    {
      changes: [
        {
          value: {
            contacts: [{ wa_id: PHONE, profile: { name: 'Asha' } }],
            messages: messages.map((m, i) => ({ id: `wamid.${i}.${Math.random()}`, from: PHONE, ...m })),
          },
        },
      ],
    },
  ],
});

/** Records Graph API calls and answers them like Meta. */
function fakeGraph() {
  const sent: Array<Record<string, unknown>> = [];
  let n = 0;
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/media') && init?.method === 'POST') return Response.json({ id: 'uploaded-audio' });
    if (u.includes('/media-'))
      return Response.json({ url: 'https://cdn.example/file', mime_type: 'image/jpeg' });
    if (u === 'https://cdn.example/file') return new Response(new Uint8Array([1, 2, 3]));
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (body.status === 'read') return Response.json({ success: true });
    sent.push(body);
    return Response.json({ messages: [{ id: `out-${++n}` }] });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function setup(
  responses: Parameters<typeof mockModel>[0],
  whatsapp: Record<string, unknown> = {},
  options: { audio?: Partial<Audio>; identityFetch?: typeof fetch; cards?: boolean } = {},
) {
  const config = parseConfig({
    agent: { name: 'Sam' },
    mcp: { url: 'http://localhost/mcp', hiddenArgs: ['user_token', 'channel', 'phone'] },
    web: { login: true, widget: { currency: '₹' } },
    whatsapp: { phoneNumberId: '123', ...whatsapp },
    limits: { repliesPerWhatsAppNumber: { max: 5, perMinutes: 5 } },
  });
  const secrets = {
    whatsappToken: 'wa-token',
    whatsappAppSecret: APP_SECRET,
    adminToken: 'admin-token',
    identitySecret: IDENTITY_SECRET,
  };
  const store = new MemoryStore();
  const { mcp, calls } = fakeMcp([ordersTool, productsTool], (name) =>
    name === 'list_products'
      ? {
          content: [{ type: 'text', text: 'two products' }],
          structuredContent: {
            cards: [
              {
                id: 'mug',
                title: 'Mug',
                price: 12,
                url: 'https://example.com/p/mug',
                image: 'https://example.com/m.jpg',
              },
              { id: 'cap', title: 'Cap', price: 9, url: 'https://example.com/p/cap' },
            ],
          },
        }
      : { content: [{ type: 'text', text: 'ORD-1 shipped' }] },
  );
  const tools = new ToolRunner({
    mcp,
    store,
    hiddenArgs: ['user_token', 'channel', 'phone'],
    login: true,
    linkHosts: [],
  });
  const graph = fakeGraph();
  const alert = vi.fn();
  const state = new ChatState();
  const shared = {
    config,
    secrets,
    ownPrompt: 'You are Sam.',
    store,
    state,
    tools,
    mcp,
    log: silentLogger,
    alert,
  };
  const whatsappChat = new WhatsAppChat({
    ...shared,
    model: mockModel(responses),
    meta: new MetaClient({ phoneNumberId: '123', apiVersion: 'v22.0', token: 'wa-token' }, graph.fetchImpl),
    audio: options.audio as Audio | undefined,
    fetchImpl: options.identityFetch,
    sleep: async () => {},
  });
  const chat = new WebChat({ ...shared, model: mockModel([]) });
  const app = createApp({
    config,
    secrets,
    store,
    chat,
    whatsapp: whatsappChat,
    log: silentLogger,
    widgetPath: '/x',
  });
  const key = whatsappKey(PHONE);
  const signed = (body: unknown) => {
    const raw = JSON.stringify(body);
    return app.request('/v1/whatsapp/webhook', {
      method: 'POST',
      headers: {
        'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
      },
      body: raw,
    });
  };
  const rows = () => store.recent(key, 50, { includeTools: true });
  return { app, store, calls, graph, alert, key, signed, rows, whatsappChat };
}

describe('parseWebhook', () => {
  it('labels each message type the way the agent reads it', () => {
    const parsed = parseWebhook(
      webhook(
        { type: 'text', text: { body: 'hi' } },
        { type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'my sticker' } },
        { type: 'audio', audio: { id: 'media-2', mime_type: 'audio/ogg; codecs=opus' } },
        { type: 'interactive', interactive: { type: 'button_reply', button_reply: { title: 'Yes' } } },
        { type: 'location', location: { latitude: 1.5, longitude: 2.5, name: 'Home' } },
        {
          type: 'order',
          order: {
            product_items: [{ product_retailer_id: 'mug', quantity: 2, item_price: 12, currency: 'INR' }],
          },
        },
        { type: 'reaction', reaction: { emoji: '👍' } },
      ),
    );
    expect(parsed.map((m) => m.text)).toEqual([
      'hi',
      '[Image] my sticker',
      '[Voice note]',
      '[Selected: Yes]',
      '[Location: Home, 1.5, 2.5]',
      '[Order from the catalog: mug x2 (12 INR)]',
    ]);
    expect(parsed[1]).toMatchObject({
      name: 'Asha',
      media: { id: 'media-1', mimeType: 'image/jpeg', caption: 'my sticker' },
    });
  });

  it('keeps a username customer by their user id and writes to them with it', async () => {
    const [msg] = parseWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ id: 'w1', from_user_id: 'IN.1349120865', type: 'text', text: { body: 'hi' } }],
              },
            },
          ],
        },
      ],
    });
    expect(msg?.from).toBe('IN.1349120865');
    const graph = fakeGraph();
    const meta = new MetaClient({ phoneNumberId: '1', apiVersion: 'v22.0', token: 't' }, graph.fetchImpl);
    await meta.sendText('IN.1349120865', 'hello');
    expect(graph.sent[0]).toMatchObject({ recipient: 'IN.1349120865' });
    expect(graph.sent[0]).not.toHaveProperty('to');
    expect(customerNote('IN.1349120865', undefined, null)).toBe(
      '[WhatsApp: number not shared (WhatsApp username).]',
    );
  });

  it('checks Meta signatures', () => {
    const sig = `sha256=${createHmac('sha256', 'x').update('body').digest('hex')}`;
    expect(verifySignature('body', sig, 'x')).toBe(true);
    expect(verifySignature('body2', sig, 'x')).toBe(false);
    expect(verifySignature('body', undefined, 'x')).toBe(false);
  });

  it('splits replies into messages and notes who the customer is', () => {
    expect(splitBubbles('one\n---\ntwo')).toEqual(['one', 'two']);
    expect(customerNote(PHONE, 'Asha', null)).toBe('[WhatsApp: +919876543210, profile name "Asha".]');
  });
});

describe('WhatsApp channel', () => {
  it('rejects unsigned webhooks and answers signed ones, bubble by bubble', async () => {
    const { app, signed, graph, rows } = setup([text('Hi Asha!\n---\nHow can I help?')]);
    const unsigned = await app.request('/v1/whatsapp/webhook', { method: 'POST', body: '{}' });
    expect(unsigned.status).toBe(401);

    expect((await signed(webhook({ type: 'text', text: { body: 'hello' } }))).status).toBe(200);
    await eventually(() => graph.sent.length === 2);
    expect(graph.sent.map((m) => (m.text as { body: string }).body)).toEqual(['Hi Asha!', 'How can I help?']);
    expect(graph.sent[0]).toMatchObject({ to: PHONE, type: 'text' });
    await eventually(async () => (await rows()).length === 3);
    expect((await rows()).slice(1)).toMatchObject([
      { role: 'assistant', text: 'Hi Asha!', data: { whatsapp: { sent: ['out-1'] } } },
      { role: 'assistant', text: 'How can I help?', data: { whatsapp: { sent: ['out-2'] } } },
    ]);
  });

  it('answers messages your app already stored, without storing them again', async () => {
    const { whatsappChat, graph, rows, store, key } = setup([text('Hi!')]);
    // Your app logged the customer's message in the shared table itself.
    await store.add({ conversationId: key, channel: 'whatsapp', role: 'user', text: 'hello' });
    expect(
      await whatsappChat.receive(webhook({ type: 'text', text: { body: 'hello' } }), { stored: true }),
    ).toBe(1);
    await eventually(() => graph.sent.length === 1);
    await eventually(async () => (await rows()).length === 2);
    expect((await rows()).map((r) => r.role)).toEqual(['user', 'assistant']);
  });

  it('skips a webhook Meta sends twice', async () => {
    const { whatsappChat, rows } = setup([text('Hi!')]);
    const body = webhook({ type: 'text', text: { body: 'hello' } });
    expect(await whatsappChat.receive(body)).toBe(1);
    expect(await whatsappChat.receive(body)).toBe(0);
    await eventually(async () => (await rows()).length === 2);
  });

  it('passes the identity from identityUrl to the tools as hidden arguments', async () => {
    const token = await new SignJWT({ name: 'Asha', toolArgs: { user_token: 'u-1' } })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(IDENTITY_SECRET));
    const identityFetch = vi.fn(async () => Response.json({ token })) as unknown as typeof fetch;
    const { whatsappChat, calls, graph } = setup(
      [toolCall('1', 'my_orders', {}), text('ORD-1 has shipped.')],
      {
        identityUrl: 'http://app/identity',
      },
      { identityFetch },
    );

    await whatsappChat.receive(webhook({ type: 'text', text: { body: 'where is my order' } }));
    await eventually(() => graph.sent.length === 1);
    expect(identityFetch).toHaveBeenCalledWith(
      'http://app/identity',
      expect.objectContaining({ body: JSON.stringify({ phone: PHONE }) }),
    );
    expect(calls[0]).toEqual({
      name: 'my_orders',
      args: { user_token: 'u-1', channel: 'whatsapp', phone: PHONE },
    });
  });

  it('sends cards as a catalog list, or as photos without a catalog', async () => {
    const withCatalog = setup([toolCall('1', 'list_products', {}), text('Here you go.')], {
      catalog: { id: 'cat-1', header: 'Our stickers' },
    });
    await withCatalog.whatsappChat.receive(webhook({ type: 'text', text: { body: 'what do you sell' } }));
    await eventually(() => withCatalog.graph.sent.length === 2);
    expect(withCatalog.graph.sent[1]).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'product_list',
        action: {
          catalog_id: 'cat-1',
          sections: [
            {
              title: 'Our stickers',
              product_items: [{ product_retailer_id: 'mug' }, { product_retailer_id: 'cap' }],
            },
          ],
        },
      },
    });

    const plain = setup([toolCall('1', 'list_products', {}), text('Here you go.')]);
    await plain.whatsappChat.receive(webhook({ type: 'text', text: { body: 'what do you sell' } }));
    await eventually(() => plain.graph.sent.length === 3);
    expect(plain.graph.sent[1]).toMatchObject({
      type: 'image',
      image: { link: 'https://example.com/m.jpg', caption: '*Mug*\n₹12\nhttps://example.com/p/mug' },
    });
    expect(plain.graph.sent[2]).toMatchObject({
      type: 'text',
      text: { body: '*Cap*\n₹9\nhttps://example.com/p/cap' },
    });
  });

  it('transcribes voice notes and answers them by voice', async () => {
    const audio = {
      canSpeak: true,
      transcribe: vi.fn(async () => 'where is my order'),
      speak: vi.fn(async () => Buffer.from('ogg')),
    };
    const model = mockModel([text('It ships tomorrow.')]);
    const { whatsappChat, graph, store } = setup(
      [],
      { audio: { baseUrl: 'http://audio/v1', transcriptionModel: 't', speechModel: 's' } },
      { audio },
    );
    // swap in the model that records its prompt
    (whatsappChat as unknown as { deps: { model: unknown } }).deps.model = model;

    await whatsappChat.receive(webhook({ type: 'audio', audio: { id: 'media-9', mime_type: 'audio/ogg' } }));
    await eventually(() => graph.sent.length === 1);
    expect(audio.transcribe).toHaveBeenCalled();
    expect(graph.sent[0]).toMatchObject({ type: 'audio', audio: { id: 'uploaded-audio' } });
    await eventually(async () => (await store.recent(whatsappKey(PHONE), 5)).length === 2);
    const [, stored] = await store.recent(whatsappKey(PHONE), 5);
    expect(stored?.data).toMatchObject({
      voice: true,
      whatsapp: { media: { id: 'uploaded-audio', mimeType: 'audio/ogg' } },
    });
    const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain('[Voice note] where is my order');
  });

  it('stores context from your app and relays webhooks from it', async () => {
    const { app, rows, graph } = setup([text('Yes, that was a scan of your sticker.')]);
    const admin = { authorization: 'Bearer admin-token', 'content-type': 'application/json' };
    const context = await app.request(`/v1/admin/conversations/${whatsappKey(PHONE)}/context`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ text: 'Someone scanned your sticker.', ref: 'n-1' }),
    });
    expect(context.status).toBe(200);

    const relay = await app.request('/v1/admin/whatsapp/webhook', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify(webhook({ type: 'text', text: { body: 'who scanned it?' } })),
    });
    expect(await relay.json()).toEqual({ received: 1 });
    await eventually(() => graph.sent.length === 1);
    expect((await rows())[0]).toMatchObject({ role: 'assistant', data: { context: true, ref: 'n-1' } });
  });

  it('sends team replies from the admin API on WhatsApp', async () => {
    const { app, graph, rows } = setup([]);
    const res = await app.request(`/v1/admin/conversations/${whatsappKey(PHONE)}/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hi, this is Ravi from the team.' }),
    });
    expect(res.status).toBe(200);
    expect(graph.sent[0]).toMatchObject({ to: PHONE, text: { body: 'Hi, this is Ravi from the team.' } });
    expect((await rows())[0]).toMatchObject({ data: { team: true, whatsapp: { sent: ['out-1'] } } });
  });

  it('writes to the customer when nudged, without storing the note', async () => {
    const { app, graph, rows } = setup([text('Did your sticker activation go well?')]);
    const res = await app.request(`/v1/admin/conversations/${whatsappKey(PHONE)}/nudge`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ note: '30 minutes have passed since activation' }),
    });
    expect(res.status).toBe(202);
    await eventually(() => graph.sent.length === 1);
    expect(graph.sent[0]).toMatchObject({ text: { body: 'Did your sticker activation go well?' } });
    await eventually(async () => (await rows()).length === 1);
    expect((await rows()).map((r) => r.role)).toEqual(['assistant']);
  });

  it('stays quiet while the team has paused the chat, and answers again after resume', async () => {
    const { app, whatsappChat, graph, rows } = setup([text('Back with you!')]);
    const admin = { authorization: 'Bearer admin-token', 'content-type': 'application/json' };
    const url = `/v1/admin/conversations/${whatsappKey(PHONE)}`;
    const paused = await app.request(`${url}/pause`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ hours: 12 }),
    });
    expect(paused.status).toBe(200);
    expect(
      ((await (await app.request(url, { headers: admin })).json()) as { pausedUntil: string | null })
        .pausedUntil,
    ).toBeTruthy();

    await whatsappChat.receive(webhook({ type: 'text', text: { body: 'hello?' } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(graph.sent).toHaveLength(0);
    expect(await rows()).toHaveLength(1); // stored, not answered

    await app.request(`${url}/pause`, { method: 'DELETE', headers: admin });
    await whatsappChat.receive(webhook({ type: 'text', text: { body: 'anyone?' } }));
    await eventually(() => graph.sent.length === 1);
  });
});
