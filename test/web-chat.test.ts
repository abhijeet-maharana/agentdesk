import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { ToolRunner } from '../src/agent/tools.js';
import { parseConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { createApp } from '../src/server.js';
import { ChatState } from '../src/state.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { INTERRUPTED_REPLY, WebChat } from '../src/web/chat.js';
import { eventually, fakeMcp, gatedModel, mockModel, text, toolCall } from './helpers.js';

const SECRET = 'test-secret-that-is-long-enough-123';
const ORIGIN = 'https://shop.example.com';

const productsTool = { name: 'list_products', inputSchema: { type: 'object' as const, properties: {} } };

function setup(responses: Parameters<typeof mockModel>[0], overrides: Record<string, unknown> = {}) {
  const config = parseConfig({
    agent: { name: 'Sam' },
    mcp: { url: 'http://localhost/mcp', hiddenArgs: ['user_token'] },
    web: { allowedOrigins: [ORIGIN], login: true, linkHosts: ['example.com'] },
    voice: { maxMinutes: 2 },
    limits: { messagesPerConversation: { max: 3, perMinutes: 10 } },
    ...overrides,
  });
  const secrets = { identitySecret: SECRET, adminToken: 'admin-token', geminiApiKey: 'gemini-key' };
  const store = new MemoryStore();
  const { mcp, calls } = fakeMcp([productsTool], () => ({
    content: [{ type: 'text', text: 'mug $12 https://example.com/p/mug' }],
    structuredContent: { cards: [{ id: 'mug', title: 'Mug', price: 12, url: 'https://example.com/p/mug' }] },
  }));
  const tools = new ToolRunner({
    mcp,
    store,
    hiddenArgs: ['user_token'],
    login: true,
    linkHosts: ['example.com'],
  });
  const fetchImpl = vi.fn(async () => Response.json({ name: 'auth_tokens/abc' })) as unknown as typeof fetch;
  const alert = vi.fn();
  const chat = new WebChat({
    config,
    secrets,
    ownPrompt: 'You are Sam.',
    store,
    state: new ChatState(),
    tools,
    mcp,
    model: mockModel(responses),
    log: silentLogger,
    alert,
    fetchImpl,
  });
  const app = createApp({ config, secrets, store, chat, log: silentLogger, widgetPath: '/nonexistent' });
  const id = randomUUID();
  const base = `/v1/web/conversations/${id}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
      body: JSON.stringify(body),
    });
  const load = async () =>
    (await (await app.request(base)).json()) as { messages: Array<Record<string, unknown>>; busy: boolean };
  return { app, store, calls, fetchImpl, alert, id, base, post, load, chat, config };
}

describe('website chat API', () => {
  it("doesn't reply while the team has paused the chat", async () => {
    const { post, load, store, id } = setup([text('Hi!')]);
    await store.setPausedUntil(`web:${id}`, new Date(Date.now() + 60_000));
    expect((await post('/messages', { text: 'Hello?' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    const snapshot = await load();
    expect(snapshot.messages.map((m) => m.role)).toEqual(['user']);
    expect(snapshot.busy).toBe(false);
  });

  it('stores the message, replies in the background, and shows cards', async () => {
    const { post, load } = setup([toolCall('1', 'list_products', {}), text('Here are our mugs.')]);
    expect((await post('/messages', { text: 'Show me mugs' })).status).toBe(200);
    await eventually(async () => (await load()).messages.length === 2);
    const snapshot = await load();
    expect(snapshot.busy).toBe(false);
    expect(snapshot.messages[1]).toMatchObject({
      role: 'assistant',
      text: 'Here are our mugs.',
      cards: [{ id: 'mug', title: 'Mug' }],
    });
    // Links are only kept for voice replies.
    expect(snapshot.messages[1]).not.toHaveProperty('links');
  });

  it("passes a logged-in visitor's tool args to the tools", async () => {
    const { post, load, calls } = setup([toolCall('1', 'list_products', {}), text('Done.')]);
    const token = await new SignJWT({ toolArgs: { user_token: 'u1-token' } })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET));
    await post('/messages', { text: 'My orders?' }, { authorization: `Bearer ${token}` });
    await eventually(async () => (await load()).messages.length === 2);
    expect(calls[0]?.args).toEqual({ user_token: 'u1-token' });
  });

  it('answers 401 for an expired identity token', async () => {
    const { post } = setup([]);
    const res = await post('/messages', { text: 'Hi' }, { authorization: 'Bearer nope' });
    expect(res.status).toBe(401);
  });

  it('rate limits a conversation', async () => {
    const { post } = setup(Array.from({ length: 3 }, () => text('Hi!')));
    for (let i = 0; i < 3; i++) expect((await post('/messages', { text: `m${i}` })).status).toBe(200);
    const res = await post('/messages', { text: 'one more' });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toMatch(/too fast/);
  });

  it('rejects a bad conversation id and an empty message', async () => {
    const { app, post } = setup([]);
    expect((await app.request('/v1/web/conversations/not-a-uuid')).status).toBe(400);
    expect((await post('/messages', { text: '   ' })).status).toBe(400);
  });

  it('only allows configured origins (CORS)', async () => {
    const { app, base } = setup([]);
    const ok = await app.request(base, { headers: { origin: ORIGIN } });
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const other = await app.request(base, { headers: { origin: 'https://evil.test' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('serves the widget config without secrets', async () => {
    const { app } = setup([]);
    const body = (await (await app.request('/v1/web/config')).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Support', login: true, voiceAvailable: true });
    expect(JSON.stringify(body)).not.toContain('gemini-key');
  });
});

describe('voice calls', () => {
  it('mints a locked token, runs tools for that call only, and saves the transcript', async () => {
    const { post, fetchImpl, load } = setup([]);
    const res = await post('/voice', {});
    const call = (await res.json()) as {
      sessionId: string;
      token: string;
      setup: { setup: Record<string, unknown> };
    };
    expect(call.token).toBe('auth_tokens/abc');

    const tokenRequest = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(tokenRequest.body as string);
    expect(body.uses).toBe(1);
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain('<voice_call>');
    // Hidden args never reach Gemini either.
    expect(JSON.stringify(body.bidiGenerateContentSetup.tools)).not.toContain('user_token');

    const tool = await post(`/voice/${call.sessionId}/tools`, { name: 'list_products', args: {} });
    expect(await tool.json()).toMatchObject({
      response: { result: expect.any(String) },
      cards: [{ id: 'mug' }],
    });
    expect((await post(`/voice/${randomUUID()}/tools`, { name: 'list_products', args: {} })).status).toBe(
      403,
    );

    await post(`/voice/${call.sessionId}/transcript`, {
      turns: [
        { role: 'user', text: 'Show mugs' },
        {
          role: 'assistant',
          text: 'Put the link in the chat.',
          links: ['https://example.com/p/mug', 'https://evil.test/x'],
        },
      ],
    });
    const messages = (await load()).messages;
    expect(messages.at(-1)).toMatchObject({ voice: true, links: ['https://example.com/p/mug'] });
  });

  it('is unavailable without a voice section', async () => {
    const { post } = setup([], { voice: undefined });
    expect((await post('/voice', {})).status).toBe(503);
  });
});

describe('admin API', () => {
  it('needs the admin token, lists chats and posts team replies', async () => {
    const { app, post, id, load } = setup([text('Hello!')]);
    await post('/messages', { text: 'Hi' });
    await eventually(async () => (await load()).messages.length === 2);

    expect((await app.request('/v1/admin/conversations')).status).toBe(401);
    const auth = { authorization: 'Bearer admin-token' };
    const list = (await (await app.request('/v1/admin/conversations', { headers: auth })).json()) as {
      conversations: Array<{ conversationId: string }>;
    };
    expect(list.conversations[0]?.conversationId).toBe(`web:${id}`);

    await app.request(`/v1/admin/conversations/web:${id}/messages`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'This is Priya from the team.' }),
    });
    expect((await load()).messages.at(-1)).toMatchObject({
      team: true,
      text: 'This is Priya from the team.',
    });
  });
});

describe('hardening', () => {
  const admin = { authorization: 'Bearer admin-token', 'content-type': 'application/json' };
  const useModel = (chat: WebChat, model: unknown) => {
    (chat as unknown as { deps: { model: unknown } }).deps.model = model;
  };

  it('drops the reply being written when the team pauses the chat', async () => {
    const { app, post, load, id, chat } = setup([]);
    const gated = gatedModel(text('Late AI answer'));
    useModel(chat, gated.model);
    await post('/messages', { text: 'Hello?' });
    expect((await load()).busy).toBe(true);

    await app.request(`/v1/admin/conversations/web:${id}/pause`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ hours: 1 }),
    });
    expect((await load()).busy).toBe(false);
    gated.release();
    await new Promise((r) => setTimeout(r, 30));
    expect((await load()).messages.map((m) => m.text)).toEqual(['Hello?']);
  });

  it('drops the reply being written when the team replies', async () => {
    const { app, post, load, id, chat } = setup([]);
    const gated = gatedModel(text('Late AI answer'));
    useModel(chat, gated.model);
    await post('/messages', { text: 'Hello?' });
    await app.request(`/v1/admin/conversations/web:${id}/messages`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ text: 'Ravi here.' }),
    });
    gated.release();
    await new Promise((r) => setTimeout(r, 30));
    expect((await load()).messages.map((m) => m.text)).toEqual(['Hello?', 'Ravi here.']);
  });

  it('says so in the chat when a shutdown cuts a reply short', async () => {
    const { post, load, id, chat } = setup([]);
    const gated = gatedModel(text('Too late'));
    useModel(chat, gated.model);
    await post('/messages', { text: 'Hello?' });
    const state = (chat as unknown as { deps: { state: ChatState } }).deps.state;
    const unfinished = await state.drain(20);
    expect(unfinished).toEqual([`web:${id}`]);
    await chat.interrupted(unfinished);
    gated.release();
    await new Promise((r) => setTimeout(r, 30));
    expect((await load()).messages.map((m) => m.text)).toEqual(['Hello?', INTERRUPTED_REPLY]);
  });

  it("saves a call transcript once and runs only the call's own tools", async () => {
    const { post } = setup([], { voice: { maxMinutes: 2, tools: ['list_products'] } });
    const call = (await (await post('/voice', {})).json()) as { sessionId: string };
    expect(
      (await post(`/voice/${call.sessionId}/tools`, { name: 'secret_admin_tool', args: {} })).status,
    ).toBe(403);
    const turns = { turns: [{ role: 'assistant', text: 'Refund approved.' }] };
    expect((await post(`/voice/${call.sessionId}/transcript`, turns)).status).toBe(200);
    expect((await post(`/voice/${call.sessionId}/transcript`, turns)).status).toBe(403);
  });

  it('tells the agent which page the visitor wrote from, and drops an odd page value', async () => {
    const model = mockModel([text('That one is waterproof.'), text('Sure.')]);
    const { post, chat, load, store, id } = setup([]);
    useModel(chat, model);
    await post('/messages', { text: 'Is this one waterproof?', page: '/products/car-tag' });
    await eventually(async () => (await load()).messages.length === 2);
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('[Page: /products/car-tag]');
    expect((await post('/messages', { text: 'Thanks', page: 'javascript:alert(1)' })).status).toBe(200);
    await eventually(async () => (await load()).messages.length === 4);
    const rows = await store.recent(`web:${id}`, 10);
    expect(rows.filter((r) => r.role === 'user').map((r) => r.data?.page)).toEqual([
      '/products/car-tag',
      undefined,
    ]);
  });

  it('tells the agent which lines came from a call transcript', async () => {
    const model = mockModel([text('Let me check that.')]);
    const { post, chat, load } = setup([]);
    useModel(chat, model);
    const call = (await (await post('/voice', {})).json()) as { sessionId: string };
    await post(`/voice/${call.sessionId}/transcript`, {
      turns: [{ role: 'assistant', text: 'Refund approved.' }],
    });
    await post('/messages', { text: 'So where is my refund?' });
    await eventually(async () => (await load()).messages.length === 3);
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('[Voice call] Refund approved.');
  });

  it('caps typed replies per day across all visitors', async () => {
    const { app } = setup([text('a'), text('b')], {
      limits: { messagesPerDay: { max: 1, perMinutes: 1440 } },
    });
    const send = (id: string) =>
      app.request(`/v1/web/conversations/${id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ text: 'hi' }),
      });
    expect((await send(randomUUID())).status).toBe(200);
    expect((await send(randomUUID())).status).toBe(429);
  });

  it("rate-limits on the proxy's address, not one the visitor sends", async () => {
    const { app } = setup([text('a'), text('b')], {
      trustProxy: true,
      limits: { messagesPerIp: { max: 1, perMinutes: 10 } },
    });
    const send = (forwarded: string) =>
      app.request(`/v1/web/conversations/${randomUUID()}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': forwarded },
        body: JSON.stringify({ text: 'hi' }),
      });
    expect((await send('1.1.1.1, 9.9.9.9')).status).toBe(200);
    expect((await send('2.2.2.2, 9.9.9.9')).status).toBe(429);
  });

  it('keeps server-only admin calls away from staff tokens', async () => {
    const { app, id } = setup([]);
    const staff = await new SignJWT({ role: 'agent' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('s1')
      .setAudience('agentdesk-inbox')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET));
    const context = await app.request(`/v1/admin/conversations/web:${id}/context`, {
      method: 'POST',
      headers: { authorization: `Bearer ${staff}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(context.status).toBe(403);
    const list = await app.request('/v1/admin/conversations', {
      headers: { authorization: `Bearer ${staff}` },
    });
    expect(list.status).toBe(200);
  });
});
