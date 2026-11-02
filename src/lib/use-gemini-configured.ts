import { useEffect, useState } from "react";

/** Whether the server holds the Gemini credential the voice features need. The key itself never reaches the browser. */
export function useGeminiVoiceConfigured(): boolean {
  const [configured, setConfigured] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/gemini-voice/status", { signal: controller.signal, credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => { if (!controller.signal.aborted) setConfigured(Boolean(body?.configured)); })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return configured;
}
