import { describe, expect, it } from "vitest";

import { memoryNoteFacts, memoryNotes, noteIsExpired, withMemoryNote, withoutMemoryNote } from "./memory-notes";

const doc = "# Notes\n- Omkar uses Resolve Studio\n* Likes short replies\nplain line\n  - nested one\n";

describe("the notes in MEMORY.md", () => {
  it("are its bullet lines, each with the line it sits on", () => {
    expect(memoryNotes(doc)).toEqual([
      { line: 1, text: "Omkar uses Resolve Studio" }, { line: 2, text: "Likes short replies" }, { line: 4, text: "nested one" },
    ]);
    expect(memoryNotes("")).toEqual([]);
  });

  it("forget one line and leave every other byte alone", () => {
    expect(withoutMemoryNote(doc, 2)).toBe("# Notes\n- Omkar uses Resolve Studio\nplain line\n  - nested one\n");
    expect(withoutMemoryNote(doc, 3), "a line that is not a note is never removed").toBe(doc);
    expect(withoutMemoryNote(doc, 99)).toBe(doc);
  });

  it("add a note as one bullet at the end, on its own line", () => {
    expect(withMemoryNote(doc, "  Prefers the free version ")).toBe(`${doc}- Prefers the free version\n`);
    expect(withMemoryNote("", "First")).toBe("- First\n");
    expect(withMemoryNote("# Notes", "Two\nlines")).toBe("# Notes\n- Two lines\n");
  });
});

describe("what a memory line records", () => {
  it("reads the server's entry grammar for date, source, expiry and supersession", () => {
    expect(memoryNoteFacts('- 2026-09-25 · from chat "Launch" · Prefers morning calls · until 2026-12-01')).toEqual({
      date: "2026-09-25", source: 'chat "Launch"', sourceKind: "chat", until: "2026-12-01", expiredOn: null, supersededOn: null, struck: false });
    expect(memoryNoteFacts('- 2026-09-25 · from room "Plan" · Ships on Friday (noticed)')).toMatchObject({ sourceKind: "noticed" });
    expect(memoryNoteFacts('- 2026-09-25 · from dream across 4 chats · Keeps a tidy inbox')).toMatchObject({ sourceKind: "dream" });
    expect(memoryNoteFacts('- 2026-08-01 · from thread abc · Old fact · expired 2026-09-01')).toMatchObject({ expiredOn: "2026-09-01" });
    expect(memoryNoteFacts('- 2026-08-01 · from chat "X" · ~~Replaced fact~~ · superseded 2026-09-01')).toMatchObject({ struck: true, supersededOn: "2026-09-01" });
  });

  it("invents no source or date for a line a person typed", () => {
    expect(memoryNoteFacts("- Ada's favourite fruit is durian")).toEqual({
      date: null, source: null, sourceKind: null, until: null, expiredOn: null, supersededOn: null, struck: false });
    expect(memoryNoteFacts('- 2026-09-25 · from some other writer · A fact').sourceKind).toBe("other");
  });

  it("counts an expiry by date only while the note is still standing", () => {
    expect(noteIsExpired(memoryNoteFacts("- 2026-01-01 · from chat \"a\" · Old · until 2026-02-01"), "2026-03-01")).toBe(true);
    expect(noteIsExpired(memoryNoteFacts("- 2026-01-01 · from chat \"a\" · Live · until 2026-12-01"), "2026-03-01")).toBe(false);
    expect(noteIsExpired(memoryNoteFacts("- 2026-01-01 · from chat \"a\" · ~~Gone~~ · until 2026-02-01 · superseded 2026-01-20"), "2026-03-01")).toBe(false);
    expect(noteIsExpired(memoryNoteFacts("- 2026-01-01 · from chat \"a\" · Gone · expired 2026-02-01"), "2026-01-15")).toBe(true);
  });
});
