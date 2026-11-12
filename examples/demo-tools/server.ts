// A pretend shop for trying agentdesk: an MCP server with products and orders (/mcp), and a
// web page with the chat on it (/) that can log a demo customer in (/demo-login).
// Run: npm run demo:tools, then open http://localhost:8090
// Your real tools work the same way: any MCP server over Streamable HTTP.

import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { z } from 'zod';

const port = Number(process.env.PORT ?? 8090);

const PRODUCTS = [
  { id: 'mug-blue', title: 'Ceramic mug', subtitle: 'Blue, 350 ml', price: 12, originalPrice: 15 },
  { id: 'tote-black', title: 'Canvas tote bag', subtitle: 'Black', price: 18 },
  { id: 'cap-green', title: 'Cotton cap', subtitle: 'Green, one size', price: 9 },
].map((p) => ({ ...p, image: `http://localhost:${port}/images/${p.id}.svg` }));

// Product pictures, drawn here so the demo needs nothing from the internet.
const IMAGES: Record<string, string> = {
  'mug-blue':
    '<rect width="100" height="100" fill="#dbeafe"/><rect x="26" y="30" width="38" height="44" rx="6" fill="#2563eb"/><path d="M64 40h6a9 9 0 0 1 0 18h-6" fill="none" stroke="#2563eb" stroke-width="6"/>',
  'tote-black':
    '<rect width="100" height="100" fill="#e2e8f0"/><path d="M38 42v-8a12 12 0 0 1 24 0v8" fill="none" stroke="#0f172a" stroke-width="4"/><path d="M26 42h48l-5 36H31z" fill="#0f172a"/>',
  'cap-green':
    '<rect width="100" height="100" fill="#dcfce7"/><path d="M24 62a26 26 0 0 1 52 0z" fill="#16a34a"/><path d="M50 62h32a4 4 0 0 1 0 8H50z" fill="#15803d"/><circle cx="50" cy="36" r="3" fill="#15803d"/>',
};

// Orders per user id: the user comes from the hidden `user_token` argument, never from the model.
const ORDERS: Record<string, Array<{ id: string; item: string; status: string }>> = {
  'demo-user': [
    { id: 'ORD-1001', item: 'Ceramic mug', status: 'Shipped, arriving Friday' },
    { id: 'ORD-1002', item: 'Cotton cap', status: 'Packed, ships tomorrow' },
  ],
};

const INSTRUCTIONS = `You are Sam, the support assistant of Demo Shop, a small online store.
Be short and friendly. Use list_products to show products; the customer sees them as cards.
For orders, use my_orders. It only works for a logged-in customer.
Delivery is free on every order. Returns are free within 30 days.`;

function createServer(): McpServer {
  const server = new McpServer({ name: 'demo-shop', version: '1.0.0' });

  server.registerResource('instructions', 'demo://instructions', { mimeType: 'text/plain' }, async (uri) => ({
    contents: [{ uri: uri.href, text: INSTRUCTIONS }],
  }));

  server.registerTool(
    'list_products',
    {
      description:
        'List the products in stock, optionally filtered by a search word. Shown as cards in the chat.',
      inputSchema: z.object({ search: z.string().optional().describe('A word to filter by, e.g. "mug"') }),
    },
    async ({ search }) => {
      const found = PRODUCTS.filter(
        (p) => !search || `${p.title} ${p.subtitle}`.toLowerCase().includes(search.toLowerCase()),
      ).map((p) => ({ ...p, url: `https://example.com/products/${p.id}` }));
      return {
        content: [
          { type: 'text', text: JSON.stringify(found.map(({ id, title, price }) => ({ id, title, price }))) },
        ],
        structuredContent: { cards: found },
      };
    },
  );

  server.registerTool(
    'my_orders',
    {
      description: "The logged-in customer's orders and their status.",
      inputSchema: z.object({ user_token: z.string() }),
    },
    async ({ user_token }) => {
      if (!user_token) {
        return { content: [{ type: 'text', text: 'The customer is not logged in.' }], isError: true };
      }
      const orders = ORDERS[user_token] ?? [];
      return { content: [{ type: 'text', text: JSON.stringify(orders) }] };
    },
  );

  return server;
}

const handler = createMcpHandler(createServer);
const app = new Hono();
app.all('/mcp', (c) => handler.fetch(c.req.raw));

app.get('/images/:file', (c) => {
  const svg = IMAGES[c.req.param('file').replace(/\.svg$/, '')];
  if (!svg) return c.notFound();
  c.header('content-type', 'image/svg+xml');
  return c.body(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${svg}</svg>`);
});

// The shop's page, with the chat widget on it.
const page = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
app.get('/', (c) => c.html(page));

// What your site does after its own login: sign a short-lived identity token with the
// secret it shares with agentdesk. `toolArgs.user_token` reaches the hidden `user_token`
// argument of my_orders; the model never sees or sets it.
app.post('/demo-login', async (c) => {
  const secret = process.env.IDENTITY_SECRET;
  if (!secret) return c.json({ error: 'Set IDENTITY_SECRET for both servers' }, 500);
  const token = await new SignJWT({
    name: 'Demo Customer',
    email: 'demo@example.com',
    toolArgs: { user_token: 'demo-user' },
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('demo-user')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
  return c.json({ token });
});

serve({ fetch: app.fetch, port }, () => console.log(`Demo shop on http://localhost:${port} (tools at /mcp)`));
