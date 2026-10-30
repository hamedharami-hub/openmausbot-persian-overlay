import { z } from "zod";
import { liveInitialInput, liveInstructions, type LiveBot, type LiveHistoryMessage } from "./live-call.ts";
import { LiveSessionError } from "./live-call.ts";

export const GEMINI_LIVE_MODEL = "models/gemini-3.8-live";
const TOKEN_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";
const tokenResponseSchema = z.object({ name: z.string().min(1) });

export type GeminiLiveTurn = { role: "user" | "model"; parts: Array<{ text: string }> };
export type GeminiLiveSetup = {
  model: string;
  generationConfig: Record<string, unknown>;
  systemInstruction: { parts: Array<{ text: string }> };
  inputAudioTranscription: Record<string, never>;
  outputAudioTranscription: Record<string, never>;
  sessionResumption: Record<string, never>;
  historyConfig: { initialHistoryInClientContent: true };
  tools: Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
};

export function buildGeminiLiveSetup(input: {
  bot: LiveBot;
  history: LiveHistoryMessage[];
  voice: string;
  cloudHome: boolean;
}): GeminiLiveSetup & { initialTurns: GeminiLiveTurn[] } {
  const initialTurns: GeminiLiveTurn[] = liveInitialInput(input.history).map((turn) => ({
    role: turn.role === "assistant" ? "model" : "user",
    parts: [{ text: turn.content[0]?.text ?? "" }],
  }));
  const toolDescription = "Send a clear request from the user to this OpenMausBot agent. The agent uses its own tools and approvals; you only report that it was handed off until its result appears in the chat.";
  return {
    model: GEMINI_LIVE_MODEL,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: safeVoice(input.voice) } } },
    },
    systemInstruction: {
      parts: [{ text: `${liveInstructions(input.bot, { cloudHome: input.cloudHome })}\n\nFor a request that needs the OpenMausBot agent to act, use the delegate_to_openmausbot tool with the user's request. That tool only submits the task; never claim it is complete until the bot has actually replied in the chat. For ordinary conversation and questions answer naturally in speech. Do not claim web search, browser access, or file access unless the agent reports it.` }],
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: {},
    historyConfig: { initialHistoryInClientContent: true },
    tools: [{ functionDeclarations: [{
      name: "delegate_to_openmausbot",
      description: toolDescription,
      parameters: {
        type: "OBJECT",
        properties: { text: { type: "STRING", description: "The user's requested task, stated clearly and without adding new instructions." } },
        required: ["text"],
      },
    }] }],
    initialTurns,
  };
}

export async function createGeminiLiveToken(input: {
  apiKey: string;
  bot: LiveBot;
  history: LiveHistoryMessage[];
  voice: string;
  cloudHome: boolean;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<{ token: string; setup: GeminiLiveSetup; initialTurns: GeminiLiveTurn[] }> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new LiveSessionError("Add a Gemini API key in Settings to start Gemini Live.", 409);
  const now = input.now ?? Date.now();
  const { initialTurns, ...setup } = buildGeminiLiveSetup(input);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(TOKEN_URL, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(now + 30 * 60_000).toISOString(),
        newSessionExpireTime: new Date(now + 60_000).toISOString(),
        liveConnectConstraints: { model: GEMINI_LIVE_MODEL, config: { sessionResumption: {}, responseModalities: ["AUDIO"] } },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new LiveSessionError(timedOut ? "Google did not answer in time. Try Gemini Live again." : "Could not reach Gemini. Check the internet connection.", 502);
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new LiveSessionError("Google rejected the Gemini API key. Check it in Settings.", 401);
    if (response.status === 429) throw new LiveSessionError("Gemini Live usage limit reached. Check your Google AI Studio rate limits, usage, and billing tier.", 429);
    throw new LiveSessionError(`Gemini Live could not create a secure session (HTTP ${response.status}).`, 502);
  }
  const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new LiveSessionError("Google returned an invalid Live token response.", 502);
  return { token: parsed.data.name, setup, initialTurns };
}

function safeVoice(value: string): string {
  return /^[A-Za-z][A-Za-z0-9_-]{0,60}$/.test(value) ? value : "Kore";
}
