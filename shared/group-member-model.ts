import type { ModelSelection } from "./wire.ts";

export function groupMemberSelection(
  group: { memberModels?: Record<string, ModelSelection> },
  bot: { id: string; modelSelection: ModelSelection },
): ModelSelection {
  return group.memberModels && Object.hasOwn(group.memberModels, bot.id)
    ? group.memberModels[bot.id]!
    : bot.modelSelection;
}

export function pruneGroupMemberModels(group: { memberIds: string[]; memberModels?: Record<string, ModelSelection> }): void {
  if (!group.memberModels) return;
  const kept = Object.fromEntries(Object.entries(group.memberModels).filter(([id]) => group.memberIds.includes(id)));
  if (Object.keys(kept).length) group.memberModels = kept;
  else delete group.memberModels;
}
