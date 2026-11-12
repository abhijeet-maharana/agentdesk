import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresStore } from '../src/store/postgres-store.js';
import { DuplicateMessageError } from '../src/store/store.js';

// Runs against a real database only when TEST_DATABASE_URL is set, e.g.
//   docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=pw postgres:17
//   TEST_DATABASE_URL=postgres://postgres:pw@localhost:5433/postgres npm test
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('PostgresStore', () => {
  const store = new PostgresStore(url ?? '');
  const a = `test:${randomUUID()}`;
  const b = `test:${randomUUID()}`;

  afterAll(() => store.close());

  it('creates its table, stores messages and reads them back in order', async () => {
    await store.init();
    await store.init(); // idempotent
    await store.add({ conversationId: a, channel: 'web', role: 'user', text: 'Hi' });
    await store.add({
      conversationId: a,
      channel: 'web',
      role: 'tool',
      text: '',
      data: { tool: { name: 'x', input: {}, result: 'ok', isError: false } },
    });
    const reply = await store.add({
      conversationId: a,
      channel: 'web',
      role: 'assistant',
      text: 'Hello',
      data: { cards: [{ id: '1', title: 'Mug', url: 'https://example.com/m' }] },
    });
    expect(reply.data?.cards?.[0]?.title).toBe('Mug');

    expect((await store.recent(a, 10)).map((m) => m.text)).toEqual(['Hi', 'Hello']);
    expect(await store.recent(a, 10, { includeTools: true })).toHaveLength(3);
    expect((await store.recent(a, 1)).map((m) => m.text)).toEqual(['Hello']);
  });

  it('lists conversations, latest first', async () => {
    await store.add({ conversationId: b, channel: 'web', role: 'user', text: 'Newer' });
    const list = await store.conversations({ limit: 500 });
    const ours = list.filter((c) => c.conversationId === a || c.conversationId === b);
    expect(ours.map((c) => [c.conversationId, c.lastMessage, c.messages])).toEqual([
      [b, 'Newer', 1],
      [a, 'Hello', 2],
    ]);
  });

  it('keeps a given time and deletes messages before a cutoff', async () => {
    const c = `test:${randomUUID()}`;
    const old = await store.add({
      conversationId: c,
      channel: 'web',
      role: 'user',
      text: 'Old',
      createdAt: '2000-01-01T00:00:00Z',
    });
    expect(old.createdAt).toBe('2000-01-01T00:00:00.000Z');
    await store.add({ conversationId: c, channel: 'web', role: 'user', text: 'Now' });
    expect(await store.deleteBefore(new Date('2000-01-02T00:00:00Z'))).toBeGreaterThanOrEqual(1);
    expect((await store.recent(c, 10)).map((m) => m.text)).toEqual(['Now']);
  });

  it('pauses and resumes a conversation', async () => {
    const c = `test:${randomUUID()}`;
    expect(await store.pausedUntil(c)).toBeNull();
    await store.setPausedUntil(c, new Date(Date.now() + 60_000));
    expect(await store.pausedUntil(c)).toBeInstanceOf(Date);
    await store.setPausedUntil(c, new Date(Date.now() - 1_000));
    expect(await store.pausedUntil(c)).toBeNull(); // expired
    await store.setPausedUntil(c, null);
    expect(await store.pausedUntil(c)).toBeNull();
  });
});

describe.skipIf(!url)('PostgresStore on an app table it shares', () => {
  const table = `app_chats_${randomUUID().slice(0, 8)}`;
  const store = new PostgresStore(url ?? '', table);
  const sql = postgres(url ?? '', { max: 1, onnotice: () => {} });

  afterAll(async () => {
    await sql.unsafe(`drop table if exists ${table}`);
    await sql.end();
    await store.close();
  });

  it('uses the existing table as it is and reads rows the app wrote', async () => {
    // The app's own WhatsApp log, with a row it wrote itself (no extra index, its own metadata).
    await sql.unsafe(`create table ${table} (
      id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(),
      phone_number text not null, message text not null, role text not null, metadata jsonb,
      is_read boolean, is_starred boolean)`);
    await sql.unsafe(`insert into ${table} (phone_number, message, role, metadata, created_at) values
      ('919876543210', '[Audio]', 'user', '{"type":"audio","whatsapp_media_id":"m9","whatsapp_message_id":"w9"}', now() - interval '2 minutes'),
      ('919876543210', '[Automated System Message]\nYour QR was scanned', 'assistant', null, now() - interval '1 minute')`);
    await store.init();
    const indexes = await sql.unsafe(`select indexname from pg_indexes where tablename = '${table}'`);
    expect(indexes).toHaveLength(1); // only its own primary key: agentdesk added nothing

    const history = await store.recent('whatsapp:919876543210', 10);
    expect(history.map((m) => [m.role, m.text])).toEqual([
      ['user', '[Audio]'],
      ['assistant', '[Automated System Message]\nYour QR was scanned'],
    ]);
    expect(history[0]?.data?.whatsapp?.media).toEqual({ id: 'm9', mimeType: 'audio/ogg' });
    expect(history[1]?.data?.context).toBe(true);
  });

  it('lists chats with unread, star, search and channel, and marks them read', async () => {
    await store.add({
      conversationId: 'web:abc',
      channel: 'web',
      role: 'user',
      text: 'Do you ship to Pune?',
    });
    const list = async (q: Partial<Parameters<PostgresStore['conversations']>[0]> = {}) =>
      (await store.conversations({ limit: 10, ...q })).map((c) => [
        c.conversationId,
        c.channel,
        c.unread,
        c.starred,
      ]);

    expect(await list()).toEqual([
      ['web:abc', 'web', 1, false],
      ['whatsapp:919876543210', 'whatsapp', 1, false],
    ]);
    expect(await list({ channel: 'whatsapp' })).toEqual([['whatsapp:919876543210', 'whatsapp', 1, false]]);
    expect(await list({ search: 'pune' })).toEqual([['web:abc', 'web', 1, false]]);

    await store.markRead('web:abc');
    await store.setStarred('whatsapp:919876543210', true);
    expect(await list({ starredOnly: true })).toEqual([['whatsapp:919876543210', 'whatsapp', 1, true]]);
    expect(await list({ channel: 'web' })).toEqual([['web:abc', 'web', 0, false]]);
    await store.setStarred('whatsapp:919876543210', false);
    expect(await list({ starredOnly: true })).toEqual([]);
  });

  it('refuses a WhatsApp message id it already has', async () => {
    const message = {
      conversationId: 'whatsapp:91',
      channel: 'whatsapp',
      role: 'user' as const,
      text: 'hi',
      data: { whatsapp: { id: 'dup-1' } },
    };
    await sql.unsafe(
      `create unique index on ${table} ((metadata->>'whatsapp_message_id')) where metadata->>'whatsapp_message_id' is not null`,
    );
    await store.add(message);
    await expect(store.add(message)).rejects.toBeInstanceOf(DuplicateMessageError);
  });

  it('shows a pause in the chat list and as a system row', async () => {
    await store.setPausedUntil('web:abc', new Date(Date.now() + 60_000));
    expect((await store.conversations({ limit: 10, channel: 'web' }))[0]?.pausedUntil).toBeTruthy();
    expect((await store.recent('web:abc', 10, { includeTools: true })).at(-1)?.role).toBe('system');
    expect((await store.recent('web:abc', 10)).map((m) => m.role)).toEqual(['user']); // the agent never sees it
  });
});
