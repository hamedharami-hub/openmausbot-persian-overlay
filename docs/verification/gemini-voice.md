# Gemini voice overlay

The `haramipourhamedgemini` engine instance supplies its server-only
`GEMINI_API_KEY`. No credential is returned to the browser. This overlay does
not change the Live-call provider, engine selections or bot transcripts.

## Use

- In a secure browser (HTTPS), the composer microphone records up to two minutes.
  Choose Auto, فارسی or English. Press again to transcribe, or × to discard.
  Google receives the audio; its quota, billing and data terms apply.
- The result is inserted into the current draft. Review/edit it and press Send
  yourself. Editing, sending, cancelling or changing threads discards late results.
- In a bot's voice settings choose Gemini and Kore, Aoede or Puck. The ordinary
  read-aloud/stop controls use Gemini TTS; Persian and English are preserved
  automatically. The preview contains both languages. Existing automatic-reply
  preferences are unchanged.

## Checks

Run in an isolated checkout with dependencies installed:

```sh
pnpm exec vitest run server/gemini-voice.test.ts server/gemini-voice-audio.test.ts server/routes/gemini-voice.test.ts server/routes/tts.test.ts server/tts/tts.test.ts server/request-auth.test.ts src/lib/use-browser-dictation.test.ts src/components/Composer.dictation.test.ts src/components/VoiceSettings.test.ts --maxWorkers=1
pnpm exec tsc -p tsconfig.server.build.json --noEmit
```

The route tests use a loopback HTTP server and stub Gemini. Browser hook tests
use a fake microphone/MediaRecorder; they do not use the person's microphone or
send bot messages. A manual device check is still needed for Android microphone
permissions, physical recording quality and audible pronunciation.

The transcription endpoint accepts only supported raw audio MIME types, up to
8 MB, with one request in flight. Uploads time out after 15 seconds; ffmpeg
normalizes them to mono WAV and rejects decoded audio longer than 125 seconds
(the browser stops at 120 seconds). ffmpeg is required on the server. The TTS path retains the 500-character utterance
limit. Provider calls time out after 60 seconds. Provider error bodies are not
returned to clients. Cancelling a pending transcription disconnects/aborts its
provider request (it cannot undo quota already consumed).
