#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anthropic } from '@ai-sdk/anthropic';
import { serve } from '@hono/node-server';
import { McpTools } from './agent/mcp.js';
import { ToolRunner } from './agent/tools.js';
import { loadConfig } from './config.js';
import { createAlerter, consoleLogger as log } from './logger.js';
import { createApp } from './server.js';
import { ChatState } from './state.js';
import { MemoryStore } from './store/memory-store.js';
import { PostgresStore } from './store/postgres-store.js';
import type { Store } from './store/store.js';
import { WebChat } from './web/chat.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main(): Promise<void> {
  const { config, secrets, basePrompt } = loadConfig();
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');

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
    model: anthropic(config.agent.model),
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
  const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
    log.info(`agentdesk listening on :${port} (voice ${chat.voiceAvailable ? 'on' : 'off'})`);
  });

  const shutdown = () => {
    log.info('Shutting down');
    server.close();
    void Promise.allSettled([store.close(), mcp?.close()]).then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
