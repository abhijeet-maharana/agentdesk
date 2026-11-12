import { generateText, type LanguageModel, type ModelMessage, type ToolResultPart, type ToolSet } from 'ai';

// Complex requests take several tool rounds.
const MAX_MODEL_CALLS = 8;
// A slow call fails fast, so the fallback reply arrives while the visitor still waits.
const MODEL_CALL_TIMEOUT_MS = 45_000;

const EMPTY_REPLY_REPROMPT = 'Please provide a clear and helpful response for the customer.';
const LEAKED_SYNTAX_REPROMPT =
  'Your last reply contained internal syntax instead of a customer message. If you need information or need to take an action, call the appropriate tool. Otherwise, reply to the customer directly in natural language.';

export type AgentOutcome =
  | { status: 'completed'; text: string; toolsCalled: string[] }
  | { status: 'refused'; toolsCalled: string[] }
  | { status: 'exhausted'; toolsCalled: string[] }
  | { status: 'cancelled' };

export interface AgentLoopParams {
  model: LanguageModel;
  /** Provider options for every call (effort, caching, fallbacks). */
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions'];
  instructions: string;
  tools: ToolSet;
  /** The conversation so far, ending with a user turn. Appended to in place. */
  messages: ModelMessage[];
  executeTool: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<{ content: string; isError: boolean }>;
  /** True once a newer visitor message makes this run stale. */
  isCancelled: () => boolean | Promise<boolean>;
  onUsage?: (usage: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
  }) => void;
}

/**
 * Runs the agent: calls the model, runs the tools it asks for, and repeats until it
 * writes a reply for the customer.
 *
 * Tools run here rather than in the SDK's own loop, so identical calls are answered
 * from a cache and cancellation is checked between them. `messages` is only ever
 * appended to: Claude's thinking blocks are only valid while the prefix stays the same.
 */
export async function runAgentLoop(params: AgentLoopParams): Promise<AgentOutcome> {
  const { messages, executeTool, isCancelled } = params;
  const toolsCalled: string[] = [];
  const toolResultCache = new Map<string, { content: string; isError: boolean }>();

  for (let call = 1; call <= MAX_MODEL_CALLS; call++) {
    const result = await generateText({
      model: params.model,
      maxOutputTokens: 16_000,
      // Tools render before the system prompt, so this one breakpoint caches both.
      instructions: {
        role: 'system',
        content: params.instructions,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
      },
      tools: params.tools,
      messages,
      providerOptions: params.providerOptions,
      timeout: MODEL_CALL_TIMEOUT_MS,
    });
    params.onUsage?.({
      model: result.response.modelId,
      inputTokens: result.usage.inputTokenDetails.noCacheTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      cacheReadTokens: result.usage.inputTokenDetails.cacheReadTokens ?? 0,
    });
    if (await isCancelled()) return { status: 'cancelled' };

    messages.push(...result.response.messages);

    if (result.finishReason === 'content-filter') return { status: 'refused', toolsCalled };

    if (result.toolCalls.length > 0) {
      const toolResults: ToolResultPart[] = [];
      for (const toolCall of result.toolCalls) {
        const input = (toolCall.input ?? {}) as Record<string, unknown>;
        const cacheKey = `${toolCall.toolName}:${JSON.stringify(input)}`;
        let output = toolResultCache.get(cacheKey);
        if (output) {
          output = {
            ...output,
            content: `${output.content}\n(Cached result from an identical earlier call.)`,
          };
        } else {
          toolsCalled.push(toolCall.toolName);
          output = await executeTool(toolCall.toolName, input);
          toolResultCache.set(cacheKey, output);
          if (await isCancelled()) return { status: 'cancelled' };
        }
        toolResults.push({
          type: 'tool-result',
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          output: { type: output.isError ? 'error-text' : 'text', value: output.content },
        });
      }
      // All results go back in one tool message.
      messages.push({ role: 'tool', content: toolResults });
      continue;
    }

    const text = result.text.trim();
    if (text && !isInternalText(text)) return { status: 'completed', text, toolsCalled };

    messages.push({ role: 'user', content: text ? LEAKED_SYNTAX_REPROMPT : EMPTY_REPLY_REPROMPT });
  }

  return { status: 'exhausted', toolsCalled };
}

/** Tool-call syntax or raw tool output written as a reply: never shown to a customer. */
export function isInternalText(text: string): boolean {
  const t = text.trim();
  return (
    /^\[System:\s*(?:Assistant called tool|Tool\s+['"]?[^'"]+['"]?\s+output|default_api\.)/i.test(t) ||
    /^\[Context:\s*(?:Executed tool|Tool\s+['"]?[^'"]+['"]?\s+returned)/i.test(t) ||
    /^Assistant called tool\s+['"]?[^'"]+['"]?\s+with args/i.test(t) ||
    /^\{\s*["']_meta["']\s*:\s*\{\s*["']io\.modelcontextprotocol/i.test(t) ||
    /^default_api\./i.test(t)
  );
}
