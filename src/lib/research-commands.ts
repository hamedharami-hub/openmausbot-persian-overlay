import type { ResearchRequest } from "../../shared/research-request";

export function researchCommand(id: string): ResearchRequest | null {
  if (id !== "research" && id !== "verify" && id !== "report") return null;
  return { mode: id, depth: "deep", length: id === "report" ? "long" : "normal" };
}

export function typedResearchCommand(text: string): { research: ResearchRequest; text: string } | null {
  const match = /^\/(research|verify|report)(?:\s+([\s\S]*))?$/iu.exec(text);
  const research = match ? researchCommand(match[1]!.toLowerCase()) : null;
  return research ? { research, text: (match?.[2] ?? "").trimStart() } : null;
}
