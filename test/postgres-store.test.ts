import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresStore } from '../src/store/postgres-store.js';

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
    const list = await store.conversations(500);
    const ours = list.filter((c) => c.conversationId === a || c.conversationId === b);
    expect(ours.map((c) => [c.conversationId, c.lastMessage, c.messages])).toEqual([
      [b, 'Newer', 1],
      [a, 'Hello', 2],
    ]);
  });
});
