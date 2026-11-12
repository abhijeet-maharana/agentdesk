import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memory-store.js';

describe('retention', () => {
  it('deletes messages older than the cutoff', async () => {
    const store = new MemoryStore();
    const base = { conversationId: 'whatsapp:91', channel: 'whatsapp', role: 'user' as const };
    await store.add({ ...base, text: 'old', createdAt: '2026-09-01T00:00:00Z' });
    await store.add({ ...base, text: 'new', createdAt: '2026-11-11T00:00:00Z' });
    expect(await store.deleteBefore(new Date('2026-10-13T00:00:00Z'))).toBe(1);
    expect((await store.recent('whatsapp:91', 10)).map((m) => m.text)).toEqual(['new']);
  });
});
