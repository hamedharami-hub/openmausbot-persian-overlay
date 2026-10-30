export type RemoteVoiceProvider = "host" | "system";

type Preferences = {
  provider?: RemoteVoiceProvider;
  voices?: Record<string, string>;
};

const STORAGE_KEY = "openmausbot.remote-voice.v1";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function read(): Preferences {
  try {
    const value = storage()?.getItem(STORAGE_KEY);
    if (!value) return {};
    const parsed = JSON.parse(value) as Preferences;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function write(next: Preferences): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
  }
}

export function localDeviceVoicesAvailable(): boolean {
  return typeof window !== "undefined" &&
    typeof window.speechSynthesis !== "undefined" &&
    typeof window.SpeechSynthesisUtterance !== "undefined";
}

export function remoteVoiceProvider(): RemoteVoiceProvider {
  const provider = read().provider;
  return provider === "host" ? "host" : "system";
}

export function setRemoteVoiceProvider(provider: RemoteVoiceProvider): void {
  write({ ...read(), provider });
}

export function remoteSystemVoice(botId?: string): string {
  if (!botId) return "";
  return read().voices?.[botId] ?? "";
}

export function setRemoteSystemVoice(botId: string, voiceId: string): void {
  const current = read();
  write({
    ...current,
    voices: {
      ...current.voices,
      [botId]: voiceId,
    },
  });
}

export function localDeviceVoiceActive(): boolean {
  return localDeviceVoicesAvailable() && remoteVoiceProvider() === "system";
}

export const localSystemVoiceActive = localDeviceVoiceActive;

export type LocalSystemVoice = {
  id: string;
  label: string;
  description?: string;
};

export function listLocalDeviceVoices(): LocalSystemVoice[] {
  if (!localDeviceVoicesAvailable()) return [];
  return window.speechSynthesis.getVoices().map((voice) => ({
    id: voice.voiceURI,
    label: voice.name,
    description: voice.lang || undefined,
  }));
}

export function resolveLocalDeviceVoice(voiceId: string): SpeechSynthesisVoice | null {
  if (!localDeviceVoicesAvailable() || !voiceId) return null;
  return (
    window.speechSynthesis
      .getVoices()
      .find((voice) => voice.voiceURI === voiceId || voice.name === voiceId) ?? null
  );
}
