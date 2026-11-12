import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anthropic } from '@ai-sdk/anthropic';
import { serve } from '@hono/node-server';
import type { LanguageModel } from 'ai';
import { McpTools } from './agent/mcp.js';
import { ToolRunner } from './agent/tools.js';
import { loadConfig } from './config.js';
import { consoleLogger, createAlerter, type Logger } from './logger.js';
import { flushSentry, initSentry } from './sentry.js';
import { createApp } from './server.js';
import { ChatState } from './state.js';
import { MemoryStore } from './store/memory-store.js';
import { PostgresStore } from './store/postgres-store.js';
import type { Store } from './store/store.js';
import { WebChat } from './web/chat.js';
import { Audio } from './whatsapp/audio.js';
import { WhatsAppChat } from './whatsapp/chat.js';
import { MetaClient } from './whatsapp/meta.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface StartOptions {
  /** The config file; defaults to AGENTDESK_CONFIG or agentdesk.config.yaml. */
  configFile?: string;
  /** Replaces Claude, e.g. with a scripted model for demos and screenshots. */
  model?: LanguageModel;
  log?: Logger;
}

export interface Agentdesk {
  port: number;
  close(): Promise<void>;
}

/** Starts the server: store, tools, chat and the HTTP API. */
export async function startAgentdesk(options: StartOptions = {}): Promise<Agentdesk> {
  const log = options.log ?? consoleLogger;
  const { config, secrets, basePrompt } = loadConfig(options.configFile);
  initSentry(config.sentry);
  if (!options.model && !process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');

  const store: Store = secrets.databaseUrl
    ? new PostgresStore(secrets.databaseUrl, config.storage.table)
    : new MemoryStore();
  if (!secrets.databaseUrl)
    log.warn('DATABASE_URL is not set: chats are kept in memory and lost on restart.');
  await store.init();

  const alert = createAlerter(secrets.alertWebhookUrl, log);
  const mcp = config.mcp ? new McpTools(config.mcp, log) : undefined;
  const tools = new ToolRunner({
    mcp,
    store,
    hiddenArgs: config.mcp?.hiddenArgs ?? [],
    login: config.web.login,
    linkHosts: config.web.linkHosts,
  });

  const stopCleanup = config.retentionDays ? startCleanup(store, config.retentionDays, log) : () => {};

  const shared = {
    config,
    secrets,
    ownPrompt: basePrompt,
    store,
    // One state for both channels: they never share a conversation key.
    state: new ChatState(),
    tools,
    mcp,
    model: options.model ?? anthropic(config.agent.model),
    providerOptions: {
      anthropic: {
        effort: config.agent.effort,
        // Caches the conversation so far between tool rounds.
        cacheControl: { type: 'ephemeral' as const },
        ...(config.agent.refusalFallback ? { fallbacks: 'default' as const } : {}),
      },
    },
    log,
    alert,
  };
  const chat = new WebChat(shared);
  const whatsapp = startWhatsApp(shared);

  const app = createApp({
    config,
    secrets,
    store,
    chat,
    whatsapp,
    log,
    widgetPath: path.join(root, 'public', 'widget.js'),
  });
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
      log.info(
        `agentdesk listening on :${port} (voice ${chat.voiceAvailable ? 'on' : 'off'}, WhatsApp ${whatsapp ? 'on' : 'off'})`,
      );
      resolve(s);
    });
  });

  return {
    port: config.port,
    close: async () => {
      stopCleanup();
      server.close();
      await Promise.allSettled([store.close(), mcp?.close(), flushSentry()]);
    },
  };
}

/**
 * The WhatsApp channel, when configured. Missing secrets turn it off with an error instead of
 * stopping the server, so the website chat keeps working.
 */
function startWhatsApp(shared: Omit<ConstructorParameters<typeof WhatsAppChat>[0], 'meta' | 'audio'>) {
  const settings = shared.config.whatsapp;
  if (!settings) return undefined;
  const { whatsappToken, audioApiKey, adminToken, identitySecret } = shared.secrets;
  const missing = [
    !whatsappToken && 'WHATSAPP_TOKEN',
    settings.identityUrl && !adminToken && 'ADMIN_TOKEN',
    settings.identityUrl && !identitySecret && 'IDENTITY_SECRET',
  ].filter(Boolean);
  if (missing.length || !whatsappToken) {
    shared.log.error(`WhatsApp is off: set ${missing.join(', ')}`);
    return undefined;
  }
  return new WhatsAppChat({
    ...shared,
    meta: new MetaClient({
      phoneNumberId: settings.phoneNumberId,
      apiVersion: settings.apiVersion,
      token: whatsappToken,
    }),
    audio: settings.audio ? new Audio(settings.audio, audioApiKey) : undefined,
  });
}

/** Deletes messages older than `days`, now and then once a day. */
function startCleanup(store: Store, days: number, log: Logger): () => void {
  const run = () => {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000);
    store
      .deleteBefore(cutoff)
      .then((count) => count && log.info(`Deleted ${count} messages older than ${days} days`))
      .catch((error: unknown) => log.error(`Old chat cleanup failed: ${String(error)}`));
  };
  run();
  const timer = setInterval(run, 24 * 60 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
