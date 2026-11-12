import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anthropic } from '@ai-sdk/anthropic';
import { serve } from '@hono/node-server';
import type { LanguageModel } from 'ai';
import { McpTools } from './agent/mcp.js';
import { ToolRunner } from './agent/tools.js';
import { loadConfig } from './config.js';
import { consoleLogger, createAlerter, type Logger } from './logger.js';
import { createApp } from './server.js';
import { ChatState } from './state.js';
import { MemoryStore } from './store/memory-store.js';
import { PostgresStore } from './store/postgres-store.js';
import type { Store } from './store/store.js';
import { WebChat } from './web/chat.js';

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
  if (!options.model && !process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');

  const store: Store = secrets.databaseUrl ? new PostgresStore(secrets.databaseUrl) : new MemoryStore();
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

  const chat = new WebChat({
    config,
    secrets,
    ownPrompt: basePrompt,
    store,
    state: new ChatState(),
    tools,
    mcp,
    model: options.model ?? anthropic(config.agent.model),
    providerOptions: {
      anthropic: {
        effort: config.agent.effort,
        // Caches the conversation so far between tool rounds.
        cacheControl: { type: 'ephemeral' },
        ...(config.agent.refusalFallback ? { fallbacks: 'default' } : {}),
      },
    },
    log,
    alert,
  });

  const app = createApp({
    config,
    secrets,
    store,
    chat,
    log,
    widgetPath: path.join(root, 'public', 'widget.js'),
  });
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
      log.info(`agentdesk listening on :${port} (voice ${chat.voiceAvailable ? 'on' : 'off'})`);
      resolve(s);
    });
  });

  return {
    port: config.port,
    close: async () => {
      server.close();
      await Promise.allSettled([store.close(), mcp?.close()]);
    },
  };
}
