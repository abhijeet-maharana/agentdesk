import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { type JSONSchema7, jsonSchema, type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { Identity } from '../identity.js';
import type { Card, MessageData, Store } from '../store/store.js';
import { errorMessage, type McpTools } from './mcp.js';

// One verbose tool must not fill the context window.
const MAX_TOOL_OUTPUT_CHARS = 4_000;
// More cards than this in one bubble is a wall; the agent can share a link instead.
const MAX_CARDS = 12;

/** A tool as the model sees it. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

/** Who and where a tool call is for. */
export interface ToolContext {
  conversationId: string;
  channel: string;
  identity: Identity | null;
  /** The customer's number, digits only (WhatsApp). */
  phone?: string;
}

/** What a reply shows besides its text. */
export type Attachments = Pick<MessageData, 'cards' | 'login' | 'links'>;

export interface ToolOutput {
  /** What the model reads. */
  content: string;
  isError: boolean;
  attachments: Attachments;
}

export interface ToolRunnerOptions {
  mcp?: McpTools;
  store: Store;
  hiddenArgs: string[];
  /** The site can log visitors in (adds `show_login`). */
  login: boolean;
  /** Links on these hosts are collected from tool output (shown under voice replies). */
  linkHosts: string[];
}

const SHOW_LOGIN: ToolSpec = {
  name: 'show_login',
  description:
    "Show a 'Log in' button in the chat. Call it when a guest asks about their own account (orders, bookings, anything personal). After they log in, their next message comes with their account.",
  inputSchema: {
    type: 'object',
    properties: { reason: { type: 'string', description: 'Why login is needed, in a few words.' } },
    required: [],
  },
};

const cardSchema = z.object({
  id: z.coerce.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  price: z.union([z.number(), z.string()]).optional(),
  originalPrice: z.union([z.number(), z.string()]).optional(),
  image: z.string().url().optional(),
  url: z.string().url(),
});

/**
 * The agent's tools: your MCP tools plus agentdesk's own (`show_login`). Runs each call,
 * records it in the chat, and collects what the reply should show (cards, login, links).
 */
export class ToolRunner {
  constructor(private readonly options: ToolRunnerOptions) {}

  /** Every tool the model can call on `channel`, without the hidden arguments. */
  async specs(channel = 'web'): Promise<ToolSpec[]> {
    const mcpTools = this.options.mcp ? await this.options.mcp.tools() : [];
    // Only the website has a Log in button; on WhatsApp the number is the login.
    const own = this.options.login && channel === 'web' ? [SHOW_LOGIN] : [];
    return [...mcpTools.map((t) => this.toSpec(t)), ...own];
  }

  /** The tools for the AI SDK. They have no `execute`: the agent loop runs them through `run`. */
  async agentTools(channel = 'web'): Promise<ToolSet> {
    const specs = await this.specs(channel);
    return Object.fromEntries(
      specs.map((spec) => [
        spec.name,
        tool({
          description: spec.description,
          inputSchema: jsonSchema<Record<string, unknown>>(spec.inputSchema as JSONSchema7),
        }),
      ]),
    );
  }

  /** Runs one tool call. Never throws: failures come back as `isError` for the model to handle. */
  async run(name: string, input: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> {
    if (name === SHOW_LOGIN.name && this.options.login && context.channel === 'web') {
      const content = context.identity
        ? 'The customer is already logged in. Continue with their request.'
        : 'A Log in button is now shown in the chat. Ask the customer to tap it and log in, then continue.';
      await this.record(context, name, input, content, false);
      return { content, isError: false, attachments: context.identity ? {} : { login: true } };
    }

    if (!this.options.mcp) {
      return { content: `Unknown tool: ${name}`, isError: true, attachments: {} };
    }

    let result: CallToolResult;
    try {
      result = await this.options.mcp.call(name, { ...input, ...this.hiddenValues(context) });
    } catch (error) {
      const message = errorMessage(error);
      await this.record(context, name, input, message, true);
      return { content: message, isError: true, attachments: {} };
    }

    const isError = result.isError === true;
    const text = result.content
      .map((item) => (item.type === 'text' ? item.text : JSON.stringify(item)))
      .join('\n');
    const cards = isError ? [] : parseCards(result.structuredContent);
    const links = this.links(text);

    let content = truncate(text) || (isError ? 'Tool execution failed' : 'Done.');
    if (cards.length) {
      content += `\n(Shown to the customer as ${cards.length} card(s) in the chat. Don't list them again; add one short line.)`;
    }
    await this.record(context, name, input, JSON.stringify(result), isError);

    return {
      content,
      isError,
      attachments: { ...(cards.length ? { cards } : {}), ...(links.length ? { links } : {}) },
    };
  }

  private toSpec(mcpTool: Tool): ToolSpec {
    const hidden = this.options.hiddenArgs;
    const properties = Object.fromEntries(
      Object.entries(mcpTool.inputSchema?.properties ?? {}).filter(([name]) => !hidden.includes(name)),
    );
    const required = (mcpTool.inputSchema?.required ?? []).filter((name) => !hidden.includes(name));
    return {
      name: mcpTool.name,
      description: mcpTool.description ?? '',
      inputSchema: { type: 'object', properties, required },
    };
  }

  /** Values for the hidden arguments: the customer's `toolArgs`, else the built-ins, else "". */
  private hiddenValues(context: ToolContext): Record<string, unknown> {
    const builtIn: Record<string, string> = {
      channel: context.channel,
      conversation_id: context.conversationId,
      ...(context.phone ? { phone: context.phone } : {}),
    };
    return Object.fromEntries(
      this.options.hiddenArgs.map((name) => [
        name,
        context.identity?.toolArgs?.[name] ?? builtIn[name] ?? '',
      ]),
    );
  }

  private links(text: string): string[] {
    const hosts = this.options.linkHosts;
    if (!hosts.length) return [];
    const urls = text.match(/https:\/\/[^\s"'<>)\]\\]+/g) ?? [];
    return [...new Set(urls.filter((url) => isOnHosts(url, hosts)))];
  }

  private async record(
    context: ToolContext,
    name: string,
    input: Record<string, unknown>,
    result: string,
    isError: boolean,
  ): Promise<void> {
    await this.options.store.add({
      conversationId: context.conversationId,
      channel: context.channel,
      role: 'tool',
      text: '',
      data: { tool: { name, input, result: truncate(result), isError } },
    });
  }
}

/** Cards a tool returned as `structuredContent.cards` (invalid ones are dropped). */
export function parseCards(structured: unknown): Card[] {
  const list = (structured as { cards?: unknown } | undefined)?.cards;
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => cardSchema.safeParse(item))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .slice(0, MAX_CARDS);
}

/** True when `url` is https on one of `hosts` or a subdomain of one. */
export function isOnHosts(url: string, hosts: string[]): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && hosts.some((h) => hostname === h || hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** Merges the attachments of all tool calls in one reply. */
export function mergeAttachments(into: Attachments, from: Attachments): Attachments {
  const cards = [...(into.cards ?? []), ...(from.cards ?? [])].filter(
    (card, i, all) => all.findIndex((c) => c.id === card.id) === i,
  );
  const links = [...new Set([...(into.links ?? []), ...(from.links ?? [])])];
  return {
    ...(cards.length ? { cards } : {}),
    ...(into.login || from.login ? { login: true } : {}),
    ...(links.length ? { links } : {}),
  };
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}...[truncated]` : text;
}
