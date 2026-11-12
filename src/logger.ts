export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Plain lines on stdout/stderr, for journald or docker logs. */
export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Posts an error to a Slack-compatible incoming webhook (ALERT_WEBHOOK_URL), at most once
 * every 10 minutes per key, so an outage doesn't flood the channel.
 */
export function createAlerter(webhookUrl: string | undefined, log: Logger) {
  const lastSent = new Map<string, number>();
  return (key: string, text: string): void => {
    log.error(text);
    if (!webhookUrl) return;
    const now = Date.now();
    if ((lastSent.get(key) ?? 0) > now - 10 * 60_000) return;
    lastSent.set(key, now);
    void fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `agentdesk: ${text}` }),
      signal: AbortSignal.timeout(10_000),
    }).catch((error: unknown) => log.warn(`Alert webhook failed: ${String(error)}`));
  };
}

export type Alert = ReturnType<typeof createAlerter>;
