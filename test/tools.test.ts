import { describe, expect, it } from 'vitest';
import { isOnHosts, mergeAttachments, parseCards, ToolRunner } from '../src/agent/tools.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { fakeMcp } from './helpers.js';

const orderTool = {
  name: 'my_orders',
  description: 'Orders',
  inputSchema: {
    type: 'object' as const,
    properties: { user_token: { type: 'string' }, status: { type: 'string' } },
    required: ['user_token'],
  },
};

const context = { conversationId: 'web:1', channel: 'web', identity: null };

function runner(handler?: Parameters<typeof fakeMcp>[1], login = true) {
  const { mcp, calls } = fakeMcp([orderTool], handler);
  const store = new MemoryStore();
  const tools = new ToolRunner({
    mcp,
    store,
    hiddenArgs: ['user_token', 'channel'],
    login,
    linkHosts: ['example.com'],
  });
  return { tools, calls, store };
}

describe('ToolRunner', () => {
  it('hides the hidden arguments from the model', async () => {
    const specs = await runner().tools.specs();
    const orders = specs.find((s) => s.name === 'my_orders');
    expect(Object.keys(orders?.inputSchema.properties ?? {})).toEqual(['status']);
    expect(orders?.inputSchema.required).toEqual([]);
  });

  it('adds show_login only when the site has login', async () => {
    expect((await runner().tools.specs()).map((s) => s.name)).toContain('show_login');
    expect((await runner(undefined, false).tools.specs()).map((s) => s.name)).not.toContain('show_login');
  });

  it('fills hidden arguments from the identity, then the built-ins, over anything the model sent', async () => {
    const { tools, calls } = runner();
    const identity = { sub: 'u1', toolArgs: { user_token: 'secret-u1' } };
    await tools.run('my_orders', { status: 'open', user_token: 'spoofed' }, { ...context, identity });
    expect(calls[0]?.args).toEqual({ status: 'open', user_token: 'secret-u1', channel: 'web' });

    await tools.run('my_orders', {}, context);
    expect(calls[1]?.args).toEqual({ user_token: '', channel: 'web' });
  });

  it('shows the login button to a guest only', async () => {
    const { tools } = runner();
    expect((await tools.run('show_login', {}, context)).attachments).toEqual({ login: true });
    const loggedIn = await tools.run('show_login', {}, { ...context, identity: { sub: 'u1' } });
    expect(loggedIn.attachments).toEqual({});
  });

  it('turns structuredContent.cards into cards and collects links on linkHosts', async () => {
    const { tools, store } = runner(() => ({
      content: [{ type: 'text', text: 'See https://example.com/p/1 and https://evil.test/x' }],
      structuredContent: {
        cards: [{ id: 1, title: 'Mug', price: 12, url: 'https://example.com/p/1' }, { bad: true }],
      },
    }));
    const output = await tools.run('my_orders', {}, context);
    expect(output.attachments.cards).toEqual([
      { id: '1', title: 'Mug', price: 12, url: 'https://example.com/p/1' },
    ]);
    expect(output.attachments.links).toEqual(['https://example.com/p/1']);
    expect(output.content).toContain('Shown to the customer as 1 card(s)');
    const rows = await store.recent('web:1', 10, { includeTools: true });
    expect(rows[0]?.data?.tool?.name).toBe('my_orders');
  });

  it('returns a failed call as an error for the model instead of throwing', async () => {
    const { tools } = runner(() => {
      throw new Error('Tool timed out');
    });
    expect(await tools.run('my_orders', {}, context)).toMatchObject({
      content: 'Tool timed out',
      isError: true,
    });
  });
});

describe('helpers', () => {
  it('parseCards drops cards whose link or image is not http(s)', () => {
    const cards = parseCards({
      cards: [
        { id: 'a', title: 'A', url: 'javascript:alert(1)' },
        { id: 'b', title: 'B', url: 'https://example.com/b', image: 'data:image/png;base64,AAAA' },
        { id: 'c', title: 'C', url: 'https://example.com/c' },
      ],
    });
    expect(cards.map((c) => c.id)).toEqual(['c']);
  });

  it('parseCards ignores anything that is not a card list', () => {
    expect(parseCards(undefined)).toEqual([]);
    expect(parseCards({ cards: 'no' })).toEqual([]);
  });

  it('isOnHosts accepts subdomains over https only', () => {
    expect(isOnHosts('https://www.example.com/a', ['example.com'])).toBe(true);
    expect(isOnHosts('http://example.com/a', ['example.com'])).toBe(false);
    expect(isOnHosts('https://notexample.com/a', ['example.com'])).toBe(false);
  });

  it('mergeAttachments dedupes cards and links', () => {
    const card = { id: 'a', title: 'A', url: 'https://example.com/a' };
    expect(
      mergeAttachments({ cards: [card], links: ['x'] }, { cards: [card], links: ['x'], login: true }),
    ).toEqual({
      cards: [card],
      login: true,
      links: ['x'],
    });
  });
});
