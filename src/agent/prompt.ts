import type { Config } from '../config.js';

/**
 * Rules for the website chat, added after your own instructions. The same for every
 * visitor, so the prompt cache is shared; who the visitor is goes with their message.
 */
export function webChatNote(config: Config): string {
  const login = config.web.login
    ? [
        "- For anything about the customer's own account, call show_login first if they are a guest, and wait for them to log in.",
        '- Never ask a guest to type a phone number or email to look up an account: only a logged-in customer’s own account can be used.',
      ]
    : [];
  return [
    '<website_chat>',
    'This conversation is in the chat window on the website. These rules override the ones above where they differ:',
    '- The customer cannot send photos, files or voice notes in this chat.',
    '- Each customer message starts with a [Website chat: ...] line saying whether they are logged in.',
    ...login,
    "- Formatting: *single asterisks* for bold, plain links, and '---' on its own line to split a reply into separate bubbles. No markdown headings, tables or [text](url) links.",
    ...(config.web.prompt.trim() ? [config.web.prompt.trim()] : []),
    '</website_chat>',
  ].join('\n');
}

/** Rules for WhatsApp, added after your own instructions (the same for every customer, so the cache is shared). */
export function whatsappNote(config: Config): string {
  const extra = config.whatsapp?.prompt.trim();
  return [
    '<whatsapp_chat>',
    'This conversation is on WhatsApp. These rules override the ones above where they differ:',
    '- Each customer message starts with a [WhatsApp: ...] line with their number and whether your system knows them.',
    '- Photos the customer sent are attached to their message; voice notes come as a transcript.',
    "- Formatting: *single asterisks* for bold, plain links, and '---' on its own line to split a reply into separate messages. No markdown headings, tables or [text](url) links.",
    ...(extra ? [extra] : []),
    '</whatsapp_chat>',
  ].join('\n');
}

/** Added for a live voice call, after the website chat rules. */
export function voiceCallNote(config: Config): string {
  const voice = config.voice;
  const greeting = voice?.greeting ?? `Hi, I'm ${config.agent.name}. How can I help you?`;
  return [
    '<voice_call>',
    'You are now speaking with the customer on a live voice call inside the website chat. The transcript appears in the chat. These rules override all formatting rules above:',
    "- Speak naturally in short sentences, in the customer's language. One question at a time.",
    `- Never read out URLs, IDs or long numbers. Links from your tools appear in the chat by themselves, so say "I've put the link in the chat".`,
    "- No markdown, no '---', no emojis, no lists.",
    `- Start with one short greeting: "${greeting}"`,
    `- The call lasts at most ${voice?.maxMinutes ?? 5} minutes. When the customer is done, say a short goodbye.`,
    '</voice_call>',
  ].join('\n');
}

/** The last few typed turns, so a voice call picks up where the chat left off. */
export function recentTurnsNote(turns: Array<{ role: string; text: string }>, agentName: string): string {
  if (turns.length === 0) return '';
  const lines = turns.map((t) => `${t.role === 'user' ? 'Customer' : agentName}: ${t.text}`);
  return `<chat_so_far>\n${lines.join('\n')}\n</chat_so_far>`;
}

/** Your instructions (agent.prompt, then the MCP prompt resource), or a plain default. */
export function basePrompt(own: string, fromMcp: string, agentName: string): string {
  const parts = [own.trim(), fromMcp.trim()].filter(Boolean);
  return parts.length
    ? parts.join('\n\n')
    : `You are ${agentName}, a friendly customer support assistant. Use your tools to look up real information instead of guessing, and keep replies short.`;
}
