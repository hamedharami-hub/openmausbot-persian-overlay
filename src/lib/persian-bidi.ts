// Standalone RTL / Persian BiDi helper kept separate from core components to avoid merge conflicts on upstream updates.

const RTL_LETTER_GLOBAL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/gu;
const ANY_LETTER_GLOBAL = /\p{Letter}/gu;
const RTL_LETTER_SINGLE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const FIRST_LETTER = /\p{Letter}/u;

/**
 * Determines text direction using majority script weight with a first-strong tie-breaker.
 * Fixes Persian sentences that start with an English word, brand name, version number, or punctuation
 * (e.g. "React یک کتابخانه است.", "v2.1 منتشر شد.", ".نقطه در ابتدای خط").
 */
export function smartTextDirection(value: string): "rtl" | "ltr" {
  const rtlMatches = value.match(RTL_LETTER_GLOBAL);
  const rtlCount = rtlMatches ? rtlMatches.length : 0;
  if (rtlCount === 0) return "ltr";

  const allMatches = value.match(ANY_LETTER_GLOBAL);
  const totalLetters = allMatches ? allMatches.length : rtlCount;
  const ltrCount = totalLetters - rtlCount;

  if (rtlCount > ltrCount) return "rtl";
  if (rtlCount >= 2 && rtlCount / totalLetters >= 0.25) {
    const first = FIRST_LETTER.exec(value);
    if (first && RTL_LETTER_SINGLE.test(first[0])) return "rtl";
  }
  if (rtlCount === ltrCount) {
    const first = FIRST_LETTER.exec(value);
    return first && RTL_LETTER_SINGLE.test(first[0]) ? "rtl" : "ltr";
  }
  return "ltr";
}

/**
 * Prefixes Right-to-Left Mark (\u200F) on predominantly RTL strings that begin with a Latin word,
 * number, or punctuation so native browser `dir="auto"` and `unicode-bidi: plaintext` (such as
 * in Sidebar rows and plain-text bubbles) align and order the line as RTL.
 */
export function fixBidiAutoText(value: string | undefined | null): string {
  if (!value) return "";
  if (value.startsWith("\u200F") || value.startsWith("\u200E")) return value;
  if (smartTextDirection(value) !== "rtl") return value;
  const first = FIRST_LETTER.exec(value);
  const trimmed = value.trimStart();
  if (!trimmed) return value;
  if (!first || !RTL_LETTER_SINGLE.test(first[0]) || !RTL_LETTER_SINGLE.test(trimmed[0]!)) {
    return `\u200F${value}`;
  }
  return value;
}
