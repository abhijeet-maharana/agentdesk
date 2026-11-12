import type { LanguageModel, ModelMessage } from 'ai';
import type { Alert, Logger } from '../logger.js';
import { type AgentLoopParams, runAgentLoop } from './loop.js';
import { type Attachments, mergeAttachments, type ToolContext, type ToolRunner } from './tools.js';

export const UNAVAILABLE_REPLY = "I'm sorry, I can't answer right now. Please try again in a few minutes.";
const REFUSED_REPLY = "I'm sorry, I can't help with that here. Is there anything else I can do for you?";

export interface AnswerDeps {
  model: LanguageModel;
  providerOptions?: AgentLoopParams['providerOptions'];
  tools: ToolRunner;
  log: Logger;
  alert: Alert;
}

/** The reply to send, or null when a newer message made this run stale. */
export type Answer = { text: string; attachments: Attachments } | null;

/**
 * Runs the agent on a conversation (ending with the customer's turn) and turns every
 * outcome into something to send: the reply, or a polite fallback plus an alert.
 */
export async function answer(
  deps: AnswerDeps,
  params: {
    instructions: string;
    messages: ModelMessage[];
    context: ToolContext;
    isCancelled: () => boolean;
  },
): Promise<Answer> {
  const { context, isCancelled } = params;
  let attachments: Attachments = {};
  try {
    const outcome = await runAgentLoop({
      model: deps.model,
      providerOptions: deps.providerOptions,
      instructions: params.instructions,
      tools: await deps.tools.agentTools(context.channel),
      messages: params.messages,
      executeTool: async (name, input) => {
        const output = await deps.tools.run(name, input, context);
        attachments = mergeAttachments(attachments, output.attachments);
        return output;
      },
      isCancelled,
      onUsage: (u) =>
        deps.log.info(
          `usage ${context.conversationId} model=${u.model} in=${u.inputTokens} cached=${u.cacheReadTokens} out=${u.outputTokens}`,
        ),
    });

    if (outcome.status === 'cancelled' || isCancelled()) return null;
    if (outcome.status === 'completed') return { text: outcome.text, attachments };
    if (outcome.status === 'refused') return { text: REFUSED_REPLY, attachments: {} };
    deps.alert(
      'no-reply',
      `No usable reply for ${context.conversationId} (tools: ${outcome.toolsCalled.join(' → ') || 'none'})`,
    );
    return { text: UNAVAILABLE_REPLY, attachments: {} };
  } catch (error) {
    deps.alert('reply-failed', `Reply failed for ${context.conversationId}: ${String(error)}`, error);
    return isCancelled() ? null : { text: UNAVAILABLE_REPLY, attachments: {} };
  }
}
