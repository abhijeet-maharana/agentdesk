import type { ToolSpec } from '../agent/tools.js';

export interface VoiceSettings {
  model: string;
  voice: string;
  maxMinutes: number;
}

/** The Live `setup` message (BidiGenerateContentSetup). */
export type LiveSetup = { setup: Record<string, unknown> };

/** The agent's tools as Gemini Live function declarations (already without hidden arguments). */
export function liveToolDeclarations(specs: ToolSpec[]): object[] {
  return specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    parametersJsonSchema: spec.inputSchema,
    // Live runs calls in the background by default; the agent must wait for real results.
    behavior: 'BLOCKING',
  }));
}

/** Audio out, both sides transcribed, the agent's tools. */
export function buildLiveSetup(
  settings: VoiceSettings,
  instruction: string,
  declarations: object[],
): LiveSetup {
  return {
    setup: {
      model: `models/${settings.model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voice } } },
      },
      systemInstruction: { parts: [{ text: instruction }] },
      tools: [{ functionDeclarations: declarations }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: {},
    },
  };
}

/**
 * Mints a one-use Gemini Live token for the browser, valid for one call of `maxMinutes`.
 * The whole setup is locked into the token (no field mask), so a visitor holding it can't
 * swap the prompt, tools or model and use your key for anything else.
 */
export async function mintLiveToken(
  apiKey: string,
  settings: VoiceSettings,
  setup: LiveSetup,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const expireTime = new Date(Date.now() + (settings.maxMinutes + 1) * 60_000).toISOString();
  const res = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      uses: 1,
      expireTime,
      // Resuming a dropped connection counts as a new session, so allow it until the end.
      newSessionExpireTime: expireTime,
      bidiGenerateContentSetup: setup.setup,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { name?: string; error?: { message?: string } };
  if (!res.ok || !body.name) {
    throw new Error(
      `Gemini token request failed (${res.status}): ${body.error?.message ?? 'no token in the answer'}`,
    );
  }
  return body.name;
}
