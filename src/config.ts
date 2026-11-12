import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

/** At most `max` requests per `perMinutes` window. */
const limit = (max: number, perMinutes: number) =>
  z
    .object({ max: z.number().int().positive(), perMinutes: z.number().positive() })
    .default({ max, perMinutes });

const chip = z.object({
  id: z.string(),
  label: z.string(),
  /** Sent as the customer's message when tapped. */
  text: z.string(),
});

const headerLink = z.object({
  label: z.string(),
  url: z.string().url(),
  icon: z.enum(['whatsapp', 'phone', 'mail', 'link']).default('link'),
});

const configSchema = z.object({
  port: z.number().int().default(8080),
  /** Read the visitor's IP from X-Forwarded-For (only behind your own proxy). */
  trustProxy: z.boolean().default(false),
  /** Messages older than this many days are deleted once a day. Unset: chats are kept forever. */
  retentionDays: z.number().int().positive().optional(),

  /**
   * Where chats are kept (with DATABASE_URL): one table, one row per message, with the columns in
   * docs/storage.md. Created if missing; an existing table with those columns (e.g. your app's own
   * WhatsApp log) is shared as it is, so your app and agentdesk see the same conversations.
   */
  /** Errors to Sentry (optional): the project's DSN, e.g. "${SENTRY_DSN}". */
  sentry: z
    .object({
      dsn: z.string().url(),
      environment: z.string().default('production'),
    })
    .optional(),

  storage: z
    .object({
      table: z
        .string()
        .regex(/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/)
        .default('agentdesk_chats'),
    })
    .prefault({}),

  agent: z
    .object({
      /** How the agent calls itself, e.g. in the voice greeting. */
      name: z.string().default('Assistant'),
      model: z.string().default('claude-sonnet-5-5'),
      effort: z.enum(['low', 'medium', 'high']).default('medium'),
      /** If Claude declines a request, re-run it on Anthropic's fallback model in the same call. Off for Haiku. */
      refusalFallback: z.boolean().default(true),
      /** Path to a Markdown/text file with the agent's instructions (relative to the config file). */
      prompt: z.string().optional(),
      /** Stored messages the agent reads per reply (about 5–7 real turns at 30). */
      historyLimit: z.number().int().positive().default(30),
    })
    .prefault({}),

  /** Your tools. Optional: without it the agent can only talk. */
  mcp: z
    .object({
      url: z.string().url(),
      /** Sent with every MCP request, e.g. `Authorization: Bearer ${MCP_TOKEN}`. */
      headers: z.record(z.string(), z.string()).default({}),
      /** An MCP resource with more instructions for the agent, added after `agent.prompt`. */
      promptResource: z.string().optional(),
      /**
       * Tool arguments agentdesk fills in itself and hides from the model, so it can never
       * supply or spoof them. Values come from the visitor's identity token (`toolArgs`),
       * else the built-ins `channel`, `conversation_id` and `phone` (WhatsApp), else "".
       */
      hiddenArgs: z.array(z.string()).default([]),
    })
    .optional(),

  web: z
    .object({
      /** Sites allowed to call the chat API from the browser, e.g. https://www.example.com. "*" allows any. */
      allowedOrigins: z.array(z.string()).default([]),
      /** Your site can log visitors in: enables the `show_login` tool and the "Log in" button. */
      login: z.boolean().default(false),
      /** Links from tools on these hosts are shown under voice replies (the voice never reads URLs out). */
      linkHosts: z.array(z.string()).default([]),
      /** Extra instructions for the website chat, added after the built-in ones. */
      prompt: z.string().default(''),
      widget: z
        .object({
          title: z.string().default('Support'),
          subtitle: z.string().optional(),
          avatarUrl: z.string().url().optional(),
          greeting: z.string().default('Hi! How can I help you?'),
          /** Added to the greeting when voice calls are on. */
          voiceHint: z.string().default('Tap the mic to talk instead of typing.'),
          placeholder: z.string().default('Type your message…'),
          launcherLabel: z.string().optional(),
          /** Note under messages written by a person from your team. */
          teamLabel: z.string().default('Support team'),
          currency: z.string().default('$'),
          chips: z.array(chip).default([]),
          /** Buttons in the chat header, e.g. "Continue on WhatsApp". */
          headerLinks: z.array(headerLink).default([]),
          /** CSS variables without the `--ac-` prefix, e.g. `primary: "#0f172a"`. */
          theme: z.record(z.string(), z.string()).default({}),
        })
        .prefault({}),
    })
    .prefault({}),

  /** The inbox for your team (/inbox, or inbox.js inside your own admin). */
  inbox: z
    .object({
      /** Your admin sites that embed inbox.js, e.g. https://admin.example.com. */
      allowedOrigins: z.array(z.string()).default([]),
      /** Canned replies offered in the reply box. */
      quickReplies: z.array(z.object({ label: z.string(), text: z.string() })).default([]),
    })
    .prefault({}),

  /** Live voice calls in the website chat (Gemini Live). Needs GEMINI_API_KEY. */
  voice: z
    .object({
      model: z.string().default('gemini-3.8-live'),
      voice: z.string().default('Kore'),
      /** Hard cap per call; the browser's token stops working after this. */
      maxMinutes: z.number().positive().default(5),
      /** What the agent says first on a call. */
      greeting: z.string().optional(),
      wsUrl: z
        .string()
        .default(
          'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained',
        ),
    })
    .optional(),

  /** The WhatsApp channel (Meta Cloud API). Needs WHATSAPP_TOKEN and WHATSAPP_APP_SECRET. */
  whatsapp: z
    .object({
      /** The business number's id in Meta (WhatsApp Manager → API Setup). */
      phoneNumberId: z.string().min(1),
      apiVersion: z.string().default('v22.0'),
      /**
       * Your app's lookup of a customer by phone number. agentdesk POSTs `{ "phone": "<digits>" }`
       * with `Authorization: Bearer ADMIN_TOKEN` and expects `{ "token": "<identity token>" }`:
       * the same HS256 token as for logged-in website visitors, so `toolArgs` reach your tools.
       * Without it, tools get the built-in `phone` hidden argument only.
       */
      identityUrl: z.string().url().optional(),
      /** Extra instructions for WhatsApp, added after the built-in ones. */
      prompt: z.string().default(''),
      /** How many of the newest photos the agent looks at (older ones stay as text). */
      imagesInContext: z.number().int().min(0).max(5).default(2),
      /** Cards as WhatsApp catalog messages (card id = the product's retailer id in this catalog). */
      catalog: z
        .object({
          id: z.string().min(1),
          header: z.string().default('Products'),
          body: z.string().default('Tap a product to see the details.'),
        })
        .optional(),
      /** Voice notes: transcription in, voice replies out, through any OpenAI-compatible API. */
      audio: z
        .object({
          baseUrl: z.string().url(),
          transcriptionModel: z.string(),
          /** `transcriptions`: POST /audio/transcriptions. `chat`: the audio goes to a chat model (e.g. Gemini). */
          transcriptionApi: z.enum(['transcriptions', 'chat']).default('transcriptions'),
          /** Voice replies are off without it. */
          speechModel: z.string().optional(),
          speechVoice: z.string().default('alloy'),
          /** What the speech API returns; it is converted to OGG Opus (needs ffmpeg). */
          speechFormat: z.enum(['wav', 'mp3', 'opus']).default('wav'),
          /** Also reply by voice when the customer's text matches (case-insensitive regex). */
          voiceRequestPattern: z.string().optional(),
          /** Never reply by voice when the customer's text matches, e.g. "no voice". */
          textRequestPattern: z.string().optional(),
          /** A spoken reply is also sent as text when it matches (links, reference numbers). */
          alsoAsTextPattern: z.string().default('https?://'),
        })
        .optional(),
    })
    .optional(),

  limits: z
    .object({
      messagesPerConversation: limit(20, 10),
      messagesPerIp: limit(60, 10),
      voiceCallsPerConversation: limit(3, 60),
      voiceCallsPerIp: limit(6, 60),
      /** All visitors together: your daily voice budget. */
      voiceCallsPerDay: limit(100, 24 * 60),
      voiceToolCallsPerCall: limit(40, 10),
      /** Replies per WhatsApp number; messages over it are stored but not answered. */
      repliesPerWhatsAppNumber: limit(15, 5),
    })
    .prefault({}),
});

export type Config = z.infer<typeof configSchema>;
export type Limit = Config['limits']['messagesPerIp'];

/** Secrets come from the environment, never from the config file. */
export interface Secrets {
  /** Postgres connection string. Without it chats are kept in memory (lost on restart). */
  databaseUrl?: string;
  /** Turns voice calls on (with a `voice:` section). */
  geminiApiKey?: string;
  /** Verifies the identity tokens your site signs for logged-in visitors (HS256). */
  identitySecret?: string;
  /** Protects the /v1/admin API. */
  adminToken?: string;
  /** Slack-compatible incoming webhook for errors. */
  alertWebhookUrl?: string;
  /** WhatsApp Cloud API access token (a system user token). */
  whatsappToken?: string;
  /** Your Meta app's secret: checks that webhooks come from Meta. */
  whatsappAppSecret?: string;
  /** Any string; Meta sends it back once when you register the webhook URL. */
  whatsappVerifyToken?: string;
  /** Key for `whatsapp.audio.baseUrl`. */
  audioApiKey?: string;
}

export interface LoadedConfig {
  config: Config;
  secrets: Secrets;
  /** The agent's own instructions (agent.prompt), empty when not set. */
  basePrompt: string;
}

/** Replaces `${NAME}` with the environment variable NAME (empty if unset). */
function expandEnv(value: unknown): unknown {
  if (typeof value === 'string')
    return value.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? '');
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v)]));
  }
  return value;
}

export function parseConfig(raw: unknown): Config {
  const result = configSchema.safeParse(expandEnv(raw ?? {}));
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid config:\n${issues}`);
  }
  return result.data;
}

/**
 * Each secret can also be set as AGENTDESK_<NAME>, which wins: handy when agentdesk shares an
 * env file with your own app, whose DATABASE_URL may point somewhere else.
 */
export function readSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  const value = (name: string) => env[`AGENTDESK_${name}`]?.trim() || env[name]?.trim() || undefined;
  return {
    databaseUrl: value('DATABASE_URL'),
    geminiApiKey: value('GEMINI_API_KEY'),
    identitySecret: value('IDENTITY_SECRET'),
    adminToken: value('ADMIN_TOKEN'),
    alertWebhookUrl: value('ALERT_WEBHOOK_URL'),
    whatsappToken: value('WHATSAPP_TOKEN'),
    whatsappAppSecret: value('WHATSAPP_APP_SECRET'),
    whatsappVerifyToken: value('WHATSAPP_VERIFY_TOKEN'),
    audioApiKey: value('AUDIO_API_KEY'),
  };
}

/** Loads the YAML config (AGENTDESK_CONFIG, default ./agentdesk.config.yaml) and the secrets. */
export function loadConfig(file = process.env.AGENTDESK_CONFIG ?? 'agentdesk.config.yaml'): LoadedConfig {
  const fullPath = path.resolve(file);
  if (!existsSync(fullPath)) {
    throw new Error(`Config file not found: ${fullPath} (copy agentdesk.config.example.yaml to start)`);
  }
  const config = parseConfig(parse(readFileSync(fullPath, 'utf8')));
  const promptFile = config.agent.prompt && path.resolve(path.dirname(fullPath), config.agent.prompt);
  const basePrompt = promptFile ? readFileSync(promptFile, 'utf8').trim() : '';
  return { config, secrets: readSecrets(), basePrompt };
}
