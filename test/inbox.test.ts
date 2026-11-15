import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { ToolRunner } from '../src/agent/tools.js';
import { parseConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { createApp } from '../src/server.js';
import { STAFF_AUDIENCE } from '../src/staff.js';
import { ChatState } from '../src/state.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { WebChat } from '../src/web/chat.js';
import { mockModel } from './helpers.js';

const SECRET = 'test-secret-that-is-long-enough-123';
const ADMIN_ORIGIN = 'https://admin.example.com';

function setup() {
  const config = parseConfig({
    inbox: { allowedOrigins: [ADMIN_ORIGIN], quickReplies: [{ label: 'Review', text: 'Please review us!' }] },
  });
  const secrets = { identitySecret: SECRET, adminToken: 'admin-token' };
  const store = new MemoryStore();
  const tools = new ToolRunner({ store, hiddenArgs: [], login: false, linkHosts: [] });
  const chat = new WebChat({
    config,
    secrets,
    ownPrompt: '',
    store,
    state: new ChatState(),
    tools,
    model: mockModel([]),
    log: silentLogger,
    alert: () => {},
  });
  const app = createApp({
    config,
    secrets,
    store,
    chat,
    log: silentLogger,
    widgetPath: '/nonexistent/widget.js',
  });
  const call = (path: string, token = 'admin-token', init: RequestInit = {}) =>
    app.request(`/v1/admin${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
    });
  return { app, store, call };
}

const sign = (claims: Record<string, unknown>, audience?: string) => {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('staff-1')
    .setExpirationTime('1h');
  return (audience ? jwt.setAudience(audience) : jwt).sign(new TextEncoder().encode(SECRET));
};

describe('inbox API', () => {
  it('lists chats with unread counts, stars, search and filters', async () => {
    const { store, call } = setup();
    const at = (minute: number) => new Date(Date.now() - (60 - minute) * 60_000).toISOString();
    await store.add({
      conversationId: 'web:a',
      channel: 'web',
      role: 'user',
      text: 'Where is my mug?',
      createdAt: at(1),
    });
    await store.add({
      conversationId: 'web:a',
      channel: 'web',
      role: 'assistant',
      text: 'On its way.',
      createdAt: at(2),
    });
    await store.add({
      conversationId: 'whatsapp:91',
      channel: 'whatsapp',
      role: 'user',
      text: 'hi',
      data: { whatsapp: { id: 'w1', name: 'Asha' } },
      createdAt: at(3),
    });

    const list = async (q = '') =>
      ((await (await call(`/conversations${q}`)).json()) as { conversations: Array<Record<string, unknown>> })
        .conversations;

    expect((await list()).map((c) => [c.conversationId, c.unread, c.name])).toEqual([
      ['whatsapp:91', 1, 'Asha'],
      ['web:a', 1, null],
    ]);
    expect((await list('?search=mug')).map((c) => c.conversationId)).toEqual(['web:a']);
    expect((await list('?search=asha')).map((c) => c.conversationId)).toEqual(['whatsapp:91']);
    expect((await list(`?search=${encodeURIComponent('+91')}`)).map((c) => c.conversationId)).toEqual([
      'whatsapp:91',
    ]);
    expect((await list('?channel=whatsapp')).map((c) => c.conversationId)).toEqual(['whatsapp:91']);

    await call('/conversations/web%3Aa/read', 'admin-token', { method: 'POST', body: '{}' });
    await call('/conversations/web%3Aa/star', 'admin-token', {
      method: 'POST',
      body: JSON.stringify({ starred: true }),
    });
    expect((await list('?starred=true')).map((c) => [c.conversationId, c.unread, c.starred])).toEqual([
      ['web:a', 0, true],
    ]);
  });

  it('gives the inbox its config, with quick replies', async () => {
    const { call } = setup();
    expect(await (await call('/inbox-config')).json()).toMatchObject({
      quickReplies: [{ label: 'Review', text: 'Please review us!' }],
      channels: ['web'],
    });
  });

  it('accepts staff tokens, keeps viewers read-only, and refuses customer tokens', async () => {
    const { call } = setup();
    const agent = await sign({ name: 'Ravi' }, STAFF_AUDIENCE);
    const viewer = await sign({ role: 'viewer' }, STAFF_AUDIENCE);
    const customer = await sign({ toolArgs: { user_token: 'u' } });

    expect((await call('/conversations', agent)).status).toBe(200);
    expect((await call('/conversations/web%3Aa/read', agent, { method: 'POST', body: '{}' })).status).toBe(
      200,
    );
    expect((await call('/conversations', viewer)).status).toBe(200);
    expect((await call('/conversations/web%3Aa/read', viewer, { method: 'POST', body: '{}' })).status).toBe(
      403,
    );
    expect((await call('/conversations', customer)).status).toBe(401);
    expect((await call('/conversations', 'wrong')).status).toBe(401);
  });

  it('lets only the configured admin sites call it from a browser', async () => {
    const { app } = setup();
    const preflight = (origin: string) =>
      app.request('/v1/admin/conversations', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'GET' },
      });
    expect((await preflight(ADMIN_ORIGIN)).headers.get('access-control-allow-origin')).toBe(ADMIN_ORIGIN);
    expect(
      (await preflight('https://evil.example.com')).headers.get('access-control-allow-origin'),
    ).toBeNull();
  });
});
