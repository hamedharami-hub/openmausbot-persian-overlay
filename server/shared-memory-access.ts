/** Shared bot memory is visible in every conversation that can use the bot. Never learn account-private facts into it. */
export type SharedMemoryRefusal = "private-direct" | "restricted-group";

export function sharedMemoryWriteRefusal(input: {
  sharedInstall: boolean;
  group: boolean;
  groupFeedsBot: boolean;
  personKnown: boolean;
  ownerAccount: boolean;
}): SharedMemoryRefusal | null {
  if (input.group) return input.groupFeedsBot ? null : "restricted-group";
  if (!input.sharedInstall) return null;
  return input.personKnown && input.ownerAccount ? null : "private-direct";
}

export function sharedMemoryWriteRefusalText(reason: SharedMemoryRefusal): string {
  if (reason === "restricted-group") {
    return "Notes cannot be saved from this group because fewer people can see it than can use this bot. Keep the facts in the group or its shared memory; do not call memory_update or memory_log or edit shared memory files.";
  }
  return "This is an account-private conversation on a shared installation. Shared bot memory is visible in other accounts, so do not save personal facts here. Do not call memory_update or memory_log or edit shared memory files. The person can save their own preferences in their About me profile.";
}
