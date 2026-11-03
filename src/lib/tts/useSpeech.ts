import { useSyncExternalStore } from "react";

import { speaker, type PlaybackDetails, type SpeechSnapshot } from "./index";

export function useSpeech(): SpeechSnapshot {
  return useSyncExternalStore(
    (fn) => speaker.subscribe(fn),
    () => speaker.state,
    () => speaker.state,
  );
}

export function useSpeechPlayback(): PlaybackDetails {
  return useSyncExternalStore(
    (fn) => speaker.subscribePlayback(fn),
    () => speaker.playbackState,
    () => speaker.playbackState,
  );
}
