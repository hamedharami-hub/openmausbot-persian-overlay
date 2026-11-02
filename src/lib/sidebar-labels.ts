import { fixBidiAutoText } from "./persian-bidi";

/** Sidebar labels come from user data, so a name often carries two languages at once.
 * "انتشار و تحلیل (Growth)" is shown as "انتشار و تحلیل" and the rest moves into the tooltip,
 * because the narrow column can only fit one of the two. A bracket in the same script as the
 * name is part of it ("Bot (v2)") and stays. */
export interface SidebarLabel {
  /** What the row shows. */
  label: string;
  /** The text that was left out, empty when nothing was cut. */
  rest: string;
}

const LATIN = /\p{Script=Latin}/u;
const RTL = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u;

function scriptOf(value: string): "latin" | "rtl" | "other" {
  if (RTL.test(value)) return "rtl";
  if (LATIN.test(value)) return "latin";
  return "other";
}

export function compactSidebarLabel(value: string): SidebarLabel {
  const text = value.trim();
  const match = /^(.*?)\s*\(([^()]{1,80})\)\s*$/.exec(text);
  if (!match) return { label: fixBidiAutoText(text), rest: "" };
  const base = match[1].trim();
  const bracket = match[2].trim();
  if (!base || !bracket) return { label: fixBidiAutoText(text), rest: "" };
  const baseScript = scriptOf(base);
  const bracketScript = scriptOf(bracket);
  if (baseScript === "other" || bracketScript === "other") return { label: fixBidiAutoText(text), rest: "" };
  if (baseScript === bracketScript) return { label: fixBidiAutoText(text), rest: "" };
  return { label: fixBidiAutoText(base), rest: text };
}
