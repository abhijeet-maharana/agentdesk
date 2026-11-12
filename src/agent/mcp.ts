import {
  type CallToolResult,
  Client,
  StreamableHTTPClientTransport,
  type Tool,
} from '@modelcontextprotocol/client';
import type { Logger } from '../logger.js';

const CONNECT_ATTEMPTS = 3;
// A hung tool must not block the whole reply.
const TOOL_TIMEOUT_MS = 25_000;

export interface McpSettings {
  url: string;
  headers: Record<string, string>;
  promptResource?: string;
}

interface Connection {
  client: Client;
  tools: Tool[];
  prompt: string;
}

/**
 * One shared connection to your MCP server: lists its tools, reads its prompt resource
 * and calls tools. Reconnects by itself when the connection breaks.
 */
export class McpTools {
  private connection: Connection | null = null;
  private connecting: Promise<Connection> | null = null;

  constructor(
    private readonly settings: McpSettings,
    private readonly log: Logger,
  ) {}

  async tools(): Promise<Tool[]> {
    return (await this.connect()).tools;
  }

  /** The text of `promptResource`, or "" when not set or unreadable. */
  async prompt(): Promise<string> {
    return (await this.connect()).prompt;
  }

  /** Calls a tool, retrying once on a fresh connection if the transport broke. */
  async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      return await this.callOnce((await this.connect()).client, name, args);
    } catch (error) {
      if (!isConnectionError(error)) throw error;
      this.log.warn(`MCP connection error on ${name}, retrying on a fresh connection`);
      this.reset();
      return await this.callOnce((await this.connect()).client, name, args);
    }
  }

  async close(): Promise<void> {
    const client = this.connection?.client;
    this.connection = null;
    await client?.close().catch(() => {});
  }

  private reset(): void {
    const client = this.connection?.client;
    this.connection = null;
    void client?.close().catch(() => {});
  }

  private async connect(): Promise<Connection> {
    if (this.connection) return this.connection;
    // Concurrent callers share one attempt.
    this.connecting ??= this.connectWithRetry().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connectWithRetry(): Promise<Connection> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
      try {
        return await this.connectOnce();
      } catch (error) {
        lastError = error;
        this.log.warn(`MCP connection attempt ${attempt} failed: ${errorMessage(error)}`);
        if (attempt < CONNECT_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 500));
      }
    }
    throw lastError;
  }

  private async connectOnce(): Promise<Connection> {
    const transport = new StreamableHTTPClientTransport(new URL(this.settings.url), {
      requestInit: { headers: { Accept: 'application/json, text/event-stream', ...this.settings.headers } },
    });
    const client = new Client({ name: 'agentdesk', version: '0.1.0' }, { capabilities: {} });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const prompt = await this.readPrompt(client);

      // Never reuse a connection that closed; ignore events from one already replaced.
      client.onclose = () => {
        if (this.connection?.client === client) this.connection = null;
      };
      client.onerror = (error) => {
        if (this.connection?.client !== client) return;
        this.log.warn(`MCP connection error: ${errorMessage(error)}`);
        this.reset();
      };

      this.connection = { client, tools, prompt };
      this.log.info(`MCP connected: ${tools.length} tools`);
      return this.connection;
    } catch (error) {
      await transport.close().catch(() => {});
      throw error;
    }
  }

  private async readPrompt(client: Client): Promise<string> {
    const uri = this.settings.promptResource;
    if (!uri) return '';
    try {
      const content = (await client.readResource({ uri })).contents[0];
      if (content && 'text' in content && typeof content.text === 'string') return content.text;
      this.log.warn(`MCP prompt resource ${uri} has no text`);
    } catch (error) {
      this.log.warn(`MCP prompt resource ${uri} could not be read: ${errorMessage(error)}`);
    }
    return '';
  }

  private async callOnce(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Tool '${name}' timed out after ${TOOL_TIMEOUT_MS} ms`)),
        TOOL_TIMEOUT_MS,
      );
    });
    try {
      return (await Promise.race([client.callTool({ name, arguments: args }), timeout])) as CallToolResult;
    } finally {
      clearTimeout(timer);
    }
  }
}

function isConnectionError(error: unknown): boolean {
  return /Connection|Closed|Transport|Session not found|ECONNREFUSED|fetch failed/i.test(errorMessage(error));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
