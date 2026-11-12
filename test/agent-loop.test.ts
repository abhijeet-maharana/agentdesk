import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { isInternalText, runAgentLoop } from '../src/agent/loop.js';
import { ToolRunner } from '../src/agent/tools.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { fakeMcp, mockModel, reply, text, toolCall } from './helpers.js';

const { mcp } = fakeMcp([
  { name: 'lookup', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
]);
const tools = await new ToolRunner({
  mcp,
  store: new MemoryStore(),
  hiddenArgs: [],
  login: false,
  linkHosts: [],
}).agentTools();

function run(responses: Parameters<typeof mockModel>[0], isCancelled = () => false) {
  const executeTool = vi.fn(async (name: string, input: Record<string, unknown>) => ({
    content: `${name} result for ${JSON.stringify(input)}`,
    isError: false,
  }));
  const messages: ModelMessage[] = [{ role: 'user', content: 'Where is my order?' }];
  const outcome = runAgentLoop({
    model: mockModel(responses),
    instructions: 'Be helpful.',
    tools,
    messages,
    executeTool,
    isCancelled,
  });
  return { outcome, executeTool, messages };
}

describe('runAgentLoop', () => {
  it('returns the reply when the model answers directly', async () => {
    const { outcome } = run([text('It ships tomorrow.')]);
    expect(await outcome).toEqual({ status: 'completed', text: 'It ships tomorrow.', toolsCalled: [] });
  });

  it('runs tools and continues with their results', async () => {
    const { outcome, executeTool, messages } = run([
      toolCall('1', 'lookup', { id: 'A1' }),
      text('Found it.'),
    ]);
    expect(await outcome).toEqual({ status: 'completed', text: 'Found it.', toolsCalled: ['lookup'] });
    expect(executeTool).toHaveBeenCalledWith('lookup', { id: 'A1' });
    expect(messages.some((m) => m.role === 'tool')).toBe(true);
  });

  it('answers an identical second call from the cache', async () => {
    const { outcome, executeTool } = run([
      toolCall('1', 'lookup', { id: 'A1' }),
      toolCall('2', 'lookup', { id: 'A1' }),
      text('Done.'),
    ]);
    await outcome;
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('re-prompts after an empty or leaked reply', async () => {
    const { outcome, messages } = run([text(''), text('default_api.lookup(id="A1")'), text('Here you go.')]);
    expect(await outcome).toMatchObject({ status: 'completed', text: 'Here you go.' });
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(3);
  });

  it('reports a content filter refusal', async () => {
    const { outcome } = run([reply([{ type: 'text', text: '' }], 'content-filter')]);
    expect(await outcome).toEqual({ status: 'refused', toolsCalled: [] });
  });

  it('stops when a newer message arrives', async () => {
    const { outcome } = run([text('Too late.')], () => true);
    expect(await outcome).toEqual({ status: 'cancelled' });
  });

  it('gives up after 8 model calls', async () => {
    const { outcome } = run(Array.from({ length: 8 }, () => text('')));
    expect(await outcome).toEqual({ status: 'exhausted', toolsCalled: [] });
  });
});

describe('isInternalText', () => {
  it('spots tool syntax but not normal replies', () => {
    expect(isInternalText('default_api.lookup(id="1")')).toBe(true);
    expect(isInternalText('[System: Assistant called tool lookup]')).toBe(true);
    expect(isInternalText('Your order ships tomorrow.')).toBe(false);
  });
});
