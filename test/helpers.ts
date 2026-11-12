import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { MockLanguageModelV4 } from 'ai/test';
import type { McpTools } from '../src/agent/mcp.js';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type Content = GenerateResult['content'][number];

export function reply(
  content: Content[],
  finish: 'stop' | 'tool-calls' | 'content-filter' = 'stop',
): GenerateResult {
  return {
    content,
    finishReason: { unified: finish, raw: undefined },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    },
    warnings: [],
  };
}

export const text = (value: string) => reply([{ type: 'text', text: value }]);

export const toolCall = (id: string, toolName: string, input: object) =>
  reply([{ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) }], 'tool-calls');

/** A model that answers with `responses` in order. */
export const mockModel = (responses: GenerateResult[]) => new MockLanguageModelV4({ doGenerate: responses });

/** An MCP server stand-in: fixed tools, records calls. */
export function fakeMcp(
  tools: Tool[],
  handler: (name: string, args: Record<string, unknown>) => CallToolResult = () => ({
    content: [{ type: 'text', text: 'ok' }],
  }),
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const mcp = {
    tools: async () => tools,
    prompt: async () => 'Tools prompt.',
    call: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return handler(name, args);
    },
    close: async () => {},
  } as unknown as McpTools;
  return { mcp, calls };
}

/** Waits until `check` passes (for background agent runs). */
export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A model that answers only once `release()` is called: for a reply still being written. */
export function gatedModel(response: GenerateResult) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      await gate;
      return response;
    },
  });
  return { model, release };
}
