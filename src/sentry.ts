import * as Sentry from '@sentry/node';
import type { Config } from './config.js';

/** Sends errors to Sentry when the config has a `sentry:` section; otherwise reporting is a no-op. */
export function initSentry(sentry: Config['sentry']): void {
  if (!sentry) return;
  Sentry.init({
    dsn: sentry.dsn,
    environment: sentry.environment,
    initialScope: { tags: { service: 'agentdesk' } },
  });
}

/** Reports an error (or, without one, the message) to Sentry, tagged with the alert key. */
export function reportError(key: string, message: string, error?: unknown): void {
  const scope = { tags: { alert: key }, extra: { message } };
  if (error === undefined) Sentry.captureMessage(message, { level: 'error', ...scope });
  else Sentry.captureException(error, scope);
}

/** Waits for queued events to be sent, e.g. before the process exits. */
export const flushSentry = (timeoutMs = 2000) => Sentry.close(timeoutMs);
