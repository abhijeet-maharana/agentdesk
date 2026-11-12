#!/usr/bin/env node
import { consoleLogger as log } from './logger.js';
import { startAgentdesk } from './start.js';

startAgentdesk()
  .then((agentdesk) => {
    const shutdown = () => {
      log.info('Shutting down');
      void agentdesk.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })
  .catch((error: unknown) => {
    log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
