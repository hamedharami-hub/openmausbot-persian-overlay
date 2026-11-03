# Gemini Live conversation

A live, spoken conversation with Gemini: the browser streams microphone audio to
the server, the server speaks to Gemini Live, and Gemini's reply plays back as
it arrives. The credential stays on the server; the browser never holds it.

## Use

Press "Live talk" next to the composer microphone. The button appears only when
the server holds the `haramipourhamedgemini` credential. Gemini speaks Persian
and English and answers in the language it hears. Captions show what you said
and what Gemini said. The conversation is about the current chat's bot and
title. Google receives the audio; its quota, billing and data terms apply.

The Live path is separate from the OpenAI live call: no OpenAI key is needed
for it, and it does not change how bots answer in writing.

## Transport

- Browser to server: one WebSocket at `/api/gemini-live/conversation`, same
  origin, `client` scope. Binary frames are PCM16 microphone audio; text
  frames are `{"type":"text","text":"…"}` envelopes, so audio is never
  mistaken for words.
- Server to Gemini Live: `wss://generativelanguage.googleapis.com/…` with the
  key in the URL query, as the Live API requires. The key never appears in a
  message, a caption or a transcript.
- Audio in is 16 kHz PCM, audio out is 24 kHz PCM.
- Reply chunks are scheduled consecutively on one audio clock, not started
  simultaneously. Interruption and hangup cancel every scheduled source.
- Capture waits for setup readiness; late microphone grants after hangup
  are immediately stopped. Browser echo cancellation remains enabled.

## Checks

```sh
pnpm exec vitest run server/gemini-live.test.ts server/routes/gemini-live.test.ts src/lib/gemini-live-client.test.ts --maxWorkers=1
pnpm exec tsc -p tsconfig.server.build.json --noEmit
```

The route test drives a fake upstream and asserts the key never reaches the
browser. Browser tests use a fake socket/audio clock to assert consecutive
chunk start times, interruption cleanup, and late microphone-grant cleanup. A
manual check on a real device is still needed for microphone permission,
acoustic echo and the audible voice quality.
