import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getConnInfo } from '@hono/node-server/conninfo';
import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { Config, Secrets } from './config.js';
import { IdentityError, verifyIdentity } from './identity.js';
import { INBOX_PAGE } from './inbox-page.js';
import type { Logger } from './logger.js';
import { reportError } from './sentry.js';
import { verifyStaff } from './staff.js';
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
const pauseBody = z.object({
  hours: z
    .number()
    .positive()
    .max(24 * 30),
});
const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(50),
    before: z.string().datetime({ offset: true }).optional(),
    search: z.string().trim().min(1).max(100).optional(),
    starred: z.enum(['true', 'false']).optional(),
    channel: z.string().max(20).optional(),
  })
  .transform(({ starred, ...q }) => ({ ...q, starredOnly: starred === 'true' }));
const starBody = z.object({ starred: z.boolean() });
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
    const message = `${c.req.method} ${c.req.path} failed: ${String(error)}`;
    deps.log.error(message);
    reportError('http', message, error);
    return c.json({ error: 'Something went wrong. Please try again.' }, 500);
  });

  app.get('/healthz', (c) => c.json({ ok: true }));

  // The bundles: widget.js for your site's visitors, inbox.js for your team (built next to each other).
  const bundles = new Map<string, string | null>();
  const serveBundle = (file: string) => async (c: Context) => {
    if (!bundles.get(file)) {
      bundles.set(
        file,
        await readFile(path.join(path.dirname(deps.widgetPath), file), 'utf8').catch(() => null),
      );
    }
    const body = bundles.get(file);
    if (!body) return c.text(`// ${file} not built: run npm run build:widget`, 404);
    c.header('content-type', 'application/javascript; charset=utf-8');
    c.header('cache-control', 'public, max-age=300');
    return c.body(body);
  };
  app.get('/widget.js', serveBundle('widget.js'));
  app.get('/inbox.js', serveBundle('inbox.js'));
  app.get('/inbox', (c) => c.html(INBOX_PAGE));

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

  // ── Admin API (your team: Bearer ADMIN_TOKEN from your server, or a staff token in the inbox) ──
  const inboxOrigins = config.inbox.allowedOrigins;
  app.use(
    '/v1/admin/*',
    cors({
      origin: (origin) => (inboxOrigins.includes(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'DELETE'],
      allowHeaders: ['content-type', 'authorization'],
      maxAge: 600,
    }),
  );
  app.use('/v1/admin/*', async (c, next) => {
    const token = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
    if (secrets.adminToken && safeEqual(token, secrets.adminToken)) return next();
    const staff = await verifyStaff(token, secrets.identitySecret);
    if (!staff) return c.json({ error: 'Unauthorized' }, 401);
    if (staff.role === 'viewer' && c.req.method !== 'GET') return c.json({ error: 'Read-only access' }, 403);
    await next();
  });

  /** What the inbox needs to draw itself. */
  app.get('/v1/admin/inbox-config', (c) =>
    c.json({
      title: config.web.widget.title,
      teamLabel: config.web.widget.teamLabel,
      currency: config.web.widget.currency,
      quickReplies: config.inbox.quickReplies,
      channels: ['web', ...(whatsapp ? ['whatsapp'] : [])],
    }),
  );

  app.get('/v1/admin/conversations', async (c) => {
    const query = listQuery.parse(c.req.query());
    return c.json({ conversations: await store.conversations(query) });
  });

  app.post('/v1/admin/conversations/:key/read', async (c) => {
    await store.markRead(c.req.param('key'));
    return c.json({ ok: true });
  });

  app.post('/v1/admin/conversations/:key/star', async (c) => {
    const { starred } = starBody.parse(await c.req.json());
    await store.setStarred(c.req.param('key'), starred);
    return c.json({ starred });
  });

  /** A photo, voice note or file from a WhatsApp chat (customer's or a voice reply). */
  app.get('/v1/admin/media/:id', async (c) => {
    if (!whatsapp) throw new ChatError(404, 'WhatsApp is not configured.');
    const { data, mimeType } = await whatsapp.media(c.req.param('id'));
    c.header('content-type', mimeType);
    c.header('cache-control', 'private, max-age=3600');
    return c.body(Buffer.from(data));
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
   * `?reply=false` stores the messages without answering; `?stored=true` answers messages your app
   * already wrote to the shared chat table (storage.table).
   */
  app.post('/v1/admin/whatsapp/webhook', async (c) => {
    if (!whatsapp) throw new ChatError(404, 'WhatsApp is not configured.');
    const reply = c.req.query('reply') !== 'false';
    const stored = c.req.query('stored') === 'true';
    return c.json({ received: await whatsapp.receive(await c.req.json(), { reply, stored }) });
  });

  return app;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
