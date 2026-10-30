import type { Message } from "./store.ts";
import type { ReplayEntry } from "./context-rebuild.ts";
import { isRoomContextMessage } from "./host/room-transcript.ts";
import { digestPromptLine } from "./digest.ts";
import { roomTurnNarrationIds } from "./room-reply.ts";

export function roomSummaryHistory(messages: readonly Message[], resultText?: (requestId: string) => string): { history: ReplayEntry[]; foldedThroughId: string; firstKeptId: string } | null {
  const record = messages.findLast(message => message.kind === "compaction" && message.compaction);
  const anchor = record ? messages.findIndex(message => message.id === record.compaction!.foldedThroughId) : -1;
  const valid = Boolean(record && anchor >= 0 && messages.indexOf(record) > anchor);
  const narration = roomTurnNarrationIds(messages);
  const context = messages.slice(valid ? anchor + 1 : 0).filter(message => isRoomContextMessage(message) && !narration.has(message.id));
  if (context.length < 3) return null;
  const kept = Math.min(6, Math.max(2, Math.floor(context.length / 3)));
  const folded = context.slice(0, -kept);
  const history: ReplayEntry[] = [
    ...(valid ? [{ id: record!.id, role: "assistant" as const, text: record!.compaction!.summary }] : []),
    ...folded.map(message => ({ id: message.id, role: message.role === "user" ? "user" as const : "assistant" as const,
      ...(message.important ? { important: true } : {}),
      text: message.roomRequest?.phase === "result"
        ? resultText?.(message.roomRequest.id) ?? "Teammate result recorded; details were not loaded."
        : message.kind === "digest" && message.digest ? digestPromptLine(message.digest, message.from?.name ?? "Bot")
          : `${message.from?.name ?? message.sender?.name ?? message.role}: ${message.text ?? ""}` })),
  ];
  return { history, foldedThroughId: folded.at(-1)!.id, firstKeptId: context[folded.length]!.id };
}
