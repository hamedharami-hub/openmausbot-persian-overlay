import { describe, expect, it } from "vitest";

import { sharedMemoryWriteRefusal, sharedMemoryWriteRefusalText } from "./shared-memory-access.ts";

describe("shared bot memory boundaries", () => {
  it("keeps a member's direct-account facts out of memory visible to other accounts", () => {
    expect(sharedMemoryWriteRefusal({
      sharedInstall: true, group: false, groupFeedsBot: false, personKnown: true, ownerAccount: false,
    })).toBe("private-direct");
    expect(sharedMemoryWriteRefusalText("private-direct")).toContain("About me profile");
  });

  it("fails closed when a shared direct turn has no verified account owner", () => {
    expect(sharedMemoryWriteRefusal({
      sharedInstall: true, group: false, groupFeedsBot: false, personKnown: false, ownerAccount: false,
    })).toBe("private-direct");
  });

  it("lets the installation owner update shared memory and preserves single-user behavior", () => {
    const input = { group: false, groupFeedsBot: false, personKnown: true, ownerAccount: true };
    expect(sharedMemoryWriteRefusal({ ...input, sharedInstall: true })).toBeNull();
    expect(sharedMemoryWriteRefusal({ ...input, sharedInstall: false })).toBeNull();
  });

  it("allows a group to update shared memory only when its audience includes every bot user", () => {
    const shared = { sharedInstall: true, group: true, personKnown: false, ownerAccount: false };
    expect(sharedMemoryWriteRefusal({ ...shared, groupFeedsBot: true })).toBeNull();
    expect(sharedMemoryWriteRefusal({ ...shared, groupFeedsBot: false })).toBe("restricted-group");
    expect(sharedMemoryWriteRefusalText("restricted-group")).toContain("Keep the facts in the group");
  });

  it("still blocks a narrowly visible group on a single-user install", () => {
    expect(sharedMemoryWriteRefusal({
      sharedInstall: false, group: true, groupFeedsBot: false, personKnown: false, ownerAccount: false,
    })).toBe("restricted-group");
  });
});
