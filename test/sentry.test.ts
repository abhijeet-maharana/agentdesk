import { beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  close: vi.fn(),
}));
vi.mock('@sentry/node', () => sentry);

import { parseConfig } from '../src/config.js';
import { createAlerter, silentLogger } from '../src/logger.js';
import { initSentry } from '../src/sentry.js';

describe('Sentry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stays off without a sentry section', () => {
    initSentry(parseConfig({}).sentry);
    expect(sentry.init).not.toHaveBeenCalled();
  });

  it('starts with the configured DSN, tagged as agentdesk', () => {
    initSentry(parseConfig({ sentry: { dsn: 'https://key@example.ingest.sentry.io/1' } }).sentry);
    expect(sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://key@example.ingest.sentry.io/1',
        environment: 'production',
        initialScope: { tags: { service: 'agentdesk' } },
      }),
    );
  });

  it('sends the caught error with the alert key', () => {
    const error = new Error('boom');
    createAlerter(undefined, silentLogger)('reply-failed', 'Reply failed for web:1: boom', error);
    expect(sentry.captureException).toHaveBeenCalledWith(error, {
      tags: { alert: 'reply-failed' },
      extra: { message: 'Reply failed for web:1: boom' },
    });
  });

  it('sends the message when there is no error object', () => {
    createAlerter(undefined, silentLogger)('no-reply', 'No usable reply for web:1');
    expect(sentry.captureMessage).toHaveBeenCalledWith('No usable reply for web:1', {
      level: 'error',
      tags: { alert: 'no-reply' },
      extra: { message: 'No usable reply for web:1' },
    });
  });
});
