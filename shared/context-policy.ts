export const CONTEXT_CATEGORIES = ["general", "decisions", "tasks", "learning", "work", "custom"] as const;
export type ContextCategory = typeof CONTEXT_CATEGORIES[number];
export interface ContextPolicy {
  automatic: boolean;
  category: ContextCategory;
  guidance: string;
  maxBytes: number;
}
export const DEFAULT_CONTEXT_POLICY: ContextPolicy = { automatic: true, category: "general", guidance: "", maxBytes: 4096 };

export interface ImportantMessagePreview {
  id: string;
  role: string;
  at: number;
  text: string;
}
