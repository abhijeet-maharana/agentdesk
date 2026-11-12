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

export interface ServerDeps {
  config: Config;
  secrets: Secrets;
  store: Store;
  chat: WebChat;
  log: Logger;
  /** The built widget bundle. */
  widgetPath: string;
}

/** The HTTP API: the widget's chat endpoints, the widget itself, and the admin API. */
export function createApp(deps: ServerDeps): Hono {
  const { config, secrets, chat, store } = deps;
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof ChatError) return c.json({ error: error.message }, error.status);
    if (error instanceof IdentityError) return c.json({ error: error.message }, 401);
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
    return c.json({ messages: await store.recent(c.req.param('key'), limit, { includeTools: true }) });
  });

  app.post('/v1/admin/conversations/:key/messages', async (c) => {
    const { text } = teamReplyBody.parse(await c.req.json());
    return c.json({ message: await chat.teamReply(c.req.param('key'), text) });
  });

  return app;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
