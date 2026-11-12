import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getConnInfo } from '@hono/node-server/conninfo';
import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { Config, Secrets } from './config.js';
import { IdentityError, verifyIdentity } from './identity.js';
import type { Logger } from './logger.js';
import type { Store } from './store/store.js';
import { ChatError, type WebChat } from './web/chat.js';
import { CHANNEL as WHATSAPP, type WhatsAppChat } from './whatsapp/chat.js';
import { MetaError, verifySignature } from './whatsapp/meta.js';

const conversationId = z.string().uuid();
const sessionId = z.string().uuid();

const sendBody = z.object({ text: z.string().trim().min(1).max(1000) });
const voiceToolBody = z.object({
  name: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).default({}),
});
const transcriptBody = z.object({
  turns: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string().trim().min(1).max(2000),
        links: z.array(z.string().url().max(500)).max(10).optional(),
      }),
    )
    .max(80),
});
const teamReplyBody = z.object({ text: z.string().trim().min(1).max(4000) });
const importBody = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string().trim().min(1).max(4000),
        createdAt: z.string().datetime({ offset: true }),
      }),
    )
    .min(1)
    .max(200),
});
const pauseBody = z.object({
  hours: z
    .number()
    .positive()
    .max(24 * 30),
});
const nudgeBody = z.object({ note: z.string().trim().min(1).max(2000) });
const contextBody = z.object({
  text: z.string().trim().min(1).max(4000),
  ref: z.string().max(200).optional(),
});

export interface ServerDeps {
  config: Config;
  secrets: Secrets;
  store: Store;
  chat: WebChat;
  /** Set when the config has a `whatsapp:` section. */
  whatsapp?: WhatsAppChat;
  log: Logger;
  /** The built widget bundle. */
  widgetPath: string;
}

/** The HTTP API: the widget's chat endpoints, the widget itself, and the admin API. */
export function createApp(deps: ServerDeps): Hono {
  const { config, secrets, chat, store, whatsapp } = deps;
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof ChatError) return c.json({ error: error.message }, error.status);
    if (error instanceof IdentityError) return c.json({ error: error.message }, 401);
    if (error instanceof MetaError) return c.json({ error: error.message }, 502);
    if (error instanceof z.ZodError) return c.json({ error: 'Invalid request.' }, 400);
    deps.log.error(`${c.req.method} ${c.req.path} failed: ${String(error)}`);
    return c.json({ error: 'Something went wrong. Please try again.' }, 500);
  });

  app.get('/healthz', (c) => c.json({ ok: true }));

  let widget: string | null = null;
  app.get('/widget.js', async (c) => {
    widget ??= await readFile(deps.widgetPath, 'utf8').catch(() => null);
    if (!widget) return c.text('// widget not built: run npm run build:widget', 404);
    c.header('content-type', 'application/javascript; charset=utf-8');
    c.header('cache-control', 'public, max-age=300');
    return c.body(widget);
  });

  // ── Widget API (called from your site's pages) ─────────────────────────────
  const origins = config.web.allowedOrigins;
  app.use(
    '/v1/web/*',
    cors({
      origin: (origin) => (origins.includes('*') || origins.includes(origin) ? origin : null),
      allowMethods: ['GET', 'POST'],
      allowHeaders: ['content-type', 'authorization'],
      maxAge: 600,
    }),
  );

  const identityOf = (c: Context) => verifyIdentity(c.req.header('authorization'), secrets.identitySecret);
  const ipOf = (c: Context): string => {
    if (config.trustProxy) {
      const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (forwarded) return forwarded;
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown'; // not served by Node (tests)
    }
  };

  /** What the widget needs to draw itself. */
  app.get('/v1/web/config', (c) =>
    c.json({ ...config.web.widget, login: config.web.login, voiceAvailable: chat.voiceAvailable }),
  );

  app.get('/v1/web/conversations/:id', async (c) => {
    const id = conversationId.parse(c.req.param('id'));
    return c.json(await chat.snapshot(id));
  });

  app.post('/v1/web/conversations/:id/messages', async (c) => {
    const id = conversationId.parse(c.req.param('id'));
    const { text } = sendBody.parse(await c.req.json());
    await chat.send(id, text, await identityOf(c), ipOf(c));
    return c.json({ ok: true });
  });

  app.post('/v1/web/conversations/:id/voice', async (c) => {
    const id = conversationId.parse(c.req.param('id'));
    return c.json(await chat.startVoice(id, await identityOf(c), ipOf(c)));
  });

  app.post('/v1/web/conversations/:id/voice/:session/tools', async (c) => {
    const id = conversationId.parse(c.req.param('id'));
    const session = sessionId.parse(c.req.param('session'));
    const { name, args } = voiceToolBody.parse(await c.req.json());
    return c.json(await chat.voiceTool(id, session, name, args, await identityOf(c)));
  });

  app.post('/v1/web/conversations/:id/voice/:session/transcript', async (c) => {
    const id = conversationId.parse(c.req.param('id'));
    const session = sessionId.parse(c.req.param('session'));
    const { turns } = transcriptBody.parse(await c.req.json());
    return c.json({ saved: await chat.saveVoiceTurns(id, session, turns) });
  });

  // ── WhatsApp webhook (Meta calls it; register https://<host>/v1/whatsapp/webhook) ──
  if (whatsapp) {
    app.get('/v1/whatsapp/webhook', (c) => {
      const ok =
        c.req.query('hub.mode') === 'subscribe' &&
        Boolean(secrets.whatsappVerifyToken) &&
        c.req.query('hub.verify_token') === secrets.whatsappVerifyToken;
      return ok ? c.text(c.req.query('hub.challenge') ?? '') : c.text('Forbidden', 403);
    });

    app.post('/v1/whatsapp/webhook', async (c) => {
      const raw = await c.req.text();
      if (
        !secrets.whatsappAppSecret ||
        !verifySignature(raw, c.req.header('x-hub-signature-256'), secrets.whatsappAppSecret)
      ) {
        return c.text('Invalid signature', 401);
      }
      await whatsapp.receive(JSON.parse(raw));
      return c.text('OK');
    });
  }

  // ── Admin API (your team; Authorization: Bearer ADMIN_TOKEN) ─────────────
  app.use('/v1/admin/*', async (c, next) => {
    const token = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
    if (!secrets.adminToken || !safeEqual(token, secrets.adminToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  app.get('/v1/admin/conversations', async (c) => {
    const limit = z.coerce.number().int().min(1).max(500).default(50).parse(c.req.query('limit'));
    return c.json({ conversations: await store.conversations(limit) });
  });

  app.get('/v1/admin/conversations/:key', async (c) => {
    const limit = z.coerce.number().int().min(1).max(1000).default(200).parse(c.req.query('limit'));
    const key = c.req.param('key');
    const [messages, pausedUntil] = await Promise.all([
      store.recent(key, limit, { includeTools: true }),
      store.pausedUntil(key),
    ]);
    return c.json({ messages, pausedUntil: pausedUntil?.toISOString() ?? null });
  });

  app.post('/v1/admin/conversations/:key/messages', async (c) => {
    const { text } = teamReplyBody.parse(await c.req.json());
    const key = c.req.param('key');
    if (key.startsWith(`${WHATSAPP}:`)) {
      if (!whatsapp) throw new ChatError(404, 'WhatsApp is not configured.');
      return c.json({ message: await whatsapp.teamReply(key, text) });
    }
    return c.json({ message: await chat.teamReply(key, text) });
  });

  /** A message your own app sent the customer (a notification, a code): the agent reads it, nothing is sent. */
  app.post('/v1/admin/conversations/:key/context', async (c) => {
    const { text, ref } = contextBody.parse(await c.req.json());
    const key = c.req.param('key');
    const channel = key.split(':')[0] ?? '';
    const message = await store.add({
      conversationId: key,
      channel,
      role: 'assistant',
      text,
      data: { context: true, ...(ref ? { ref } : {}) },
    });
    return c.json({ message });
  });

  /**
   * Earlier messages from your own records (e.g. before agentdesk answered this number), oldest
   * first, so the agent knows the conversation. Only into an empty conversation: a second
   * import gets 409, so calling it on every first contact is safe.
   */
  app.post('/v1/admin/conversations/:key/import', async (c) => {
    const { messages } = importBody.parse(await c.req.json());
    const key = c.req.param('key');
    if ((await store.recent(key, 1, { includeTools: true })).length > 0) {
      throw new ChatError(409, 'This conversation already has messages.');
    }
    const channel = key.split(':')[0] ?? '';
    // One at a time, so the rows keep their order.
    for (const m of messages) {
      await store.add({
        conversationId: key,
        channel,
        role: m.role,
        text: m.text,
        data: { imported: true },
        createdAt: m.createdAt,
      });
    }
    return c.json({ imported: messages.length });
  });

  /** Your team takes over: the agent stays quiet in this chat for `hours` (messages are still stored). */
  app.post('/v1/admin/conversations/:key/pause', async (c) => {
    const { hours } = pauseBody.parse(await c.req.json());
    const until = new Date(Date.now() + hours * 60 * 60_000);
    await store.setPausedUntil(c.req.param('key'), until);
    return c.json({ pausedUntil: until.toISOString() });
  });

  /** The agent answers this chat again (from the customer's next message). */
  app.delete('/v1/admin/conversations/:key/pause', async (c) => {
    await store.setPausedUntil(c.req.param('key'), null);
    return c.json({ pausedUntil: null });
  });

  /** The agent writes to a WhatsApp customer now; `note` says why (not sent, not stored). Runs in the background. */
  app.post('/v1/admin/conversations/:key/nudge', async (c) => {
    const { note } = nudgeBody.parse(await c.req.json());
    const key = c.req.param('key');
    if (!whatsapp || !key.startsWith(`${WHATSAPP}:`))
      throw new ChatError(404, 'Only WhatsApp chats can be nudged.');
    void whatsapp
      .nudge(key, note)
      .catch((error: unknown) => deps.log.error(`Nudge failed for ${key}: ${String(error)}`));
    return c.json({ ok: true }, 202);
  });

  /**
   * For an app that keeps its own Meta webhook: it checks Meta's signature itself and passes
   * on the webhook body (all of it, or only the customers agentdesk should answer).
   */
  app.post('/v1/admin/whatsapp/webhook', async (c) => {
    if (!whatsapp) throw new ChatError(404, 'WhatsApp is not configured.');
    return c.json({ received: await whatsapp.receive(await c.req.json()) });
  });

  return app;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
