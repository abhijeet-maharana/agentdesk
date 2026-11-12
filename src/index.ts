#!/usr/bin/env node
import { consoleLogger as log } from './logger.js';
import { startAgentdesk } from './start.js';

startAgentdesk()
  .then((agentdesk) => {
    let closing = false;
    const shutdown = () => {
      // A second signal (e.g. Ctrl+C twice) stops at once.
      if (closing) process.exit(1);
      closing = true;
      log.info('Shutting down: finishing replies being written');
      void agentdesk.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })
  .catch((error: unknown) => {
    log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
