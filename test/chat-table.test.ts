import { describe, expect, it } from 'vitest';
import { type ChatRow, conversationIdOf, fromRow, rowKey, toColumns } from '../src/store/chat-table.js';

const row = (over: Partial<ChatRow>): ChatRow => ({
  id: 'r1',
  created_at: new Date('2026-11-12T10:00:00Z'),
  phone_number: '919876543210',
  message: '',
  role: 'user',
  metadata: null,
  is_read: null,
  is_starred: null,
  ...over,
});

describe('chat table', () => {
  it('keys WhatsApp chats by number and website chats by web:<id>', () => {
    expect(rowKey('whatsapp:919876543210')).toBe('919876543210');
    expect(rowKey('web:abc')).toBe('web:abc');
    expect(conversationIdOf('919876543210')).toBe('whatsapp:919876543210');
    expect(conversationIdOf('IN.13491208')).toBe('whatsapp:IN.13491208');
    expect(conversationIdOf('web:abc')).toBe('web:abc');
  });

  it('writes the metadata keys an app WhatsApp log uses, and reads them back', () => {
    const c = toColumns({
      conversationId: 'whatsapp:91',
      channel: 'whatsapp',
      role: 'user',
      text: '[Image] my sticker',
      data: {
        whatsapp: {
          id: 'wamid.1',
          type: 'image',
          name: 'Asha',
          media: { id: 'm1', mimeType: 'image/jpeg', caption: 'my sticker' },
        },
      },
    });
    expect(c).toEqual({
      phone_number: '91',
      message: '[Image] my sticker',
      role: 'user',
      metadata: {
        whatsapp_message_id: 'wamid.1',
        type: 'image',
        profile_name: 'Asha',
        whatsapp_media_id: 'm1',
        mime_type: 'image/jpeg',
        caption: 'my sticker',
      },
    });
    expect(fromRow(row({ message: c.message, metadata: c.metadata })).data).toEqual({
      whatsapp: {
        id: 'wamid.1',
        type: 'image',
        name: 'Asha',
        media: { id: 'm1', mimeType: 'image/jpeg', caption: 'my sticker' },
      },
    });
  });

  it('stores a tool call as one function row and reads it back', () => {
    const c = toColumns({
      conversationId: 'web:a',
      channel: 'web',
      role: 'tool',
      text: '',
      data: { tool: { name: 'my_orders', input: { q: 1 }, result: '{"ok":true}', isError: false } },
    });
    expect(c).toMatchObject({ phone_number: 'web:a', role: 'function', message: '{"ok":true}' });
    const back = fromRow(
      row({ phone_number: 'web:a', role: 'function', message: c.message, metadata: c.metadata }),
    );
    expect(back).toMatchObject({ conversationId: 'web:a', channel: 'web', role: 'tool', text: '' });
    expect(back.data?.tool).toEqual({
      name: 'my_orders',
      input: { q: 1 },
      result: '{"ok":true}',
      isError: false,
    });
  });

  it('reads rows another app wrote: its tool results, voice notes and own sends', () => {
    const legacyTool = fromRow(
      row({
        role: 'function',
        message: '{"isError":true,"content":[]}',
        metadata: { name: 'commerce_orders' },
      }),
    );
    expect(legacyTool.data?.tool).toMatchObject({ name: 'commerce_orders', isError: true, input: {} });

    const voice = fromRow(
      row({ message: '[Audio]', metadata: { type: 'audio', whatsapp_media_id: 'm2', url: 'https://x' } }),
    );
    expect(voice.data?.whatsapp?.media).toEqual({ id: 'm2', mimeType: 'audio/ogg' });

    const template = fromRow(
      row({ role: 'assistant', message: 'Sent template', metadata: { template_name: 'otp_login' } }),
    );
    expect(template.data?.context).toBe(true);
    const automated = fromRow(
      row({ role: 'assistant', message: '[Automated System Message]\nYour QR was scanned' }),
    );
    expect(automated.data?.context).toBe(true);
  });

  it('records a pause as a system row', () => {
    const c = toColumns({
      conversationId: 'whatsapp:91',
      channel: 'whatsapp',
      role: 'system',
      text: 'AI paused',
      data: { pausedUntil: '2026-11-13T10:00:00.000Z' },
    });
    expect(c).toMatchObject({ role: 'system', metadata: { paused_until: '2026-11-13T10:00:00.000Z' } });
  });
});
