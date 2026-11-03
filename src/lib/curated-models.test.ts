import { describe, expect, it } from "vitest";
import { curatedModels } from "./curated-models";
const ids = (values: string[], retain?: string[]) => curatedModels(values.map((id) => ({ id })), new Set(retain)).map((row) => row.id);

describe("curated model presentation", () => {
  it("keeps the newest Luna, Terra, Astra and Sol without batch/latest/pro duplicates", () => {
    expect(ids(["openai/gpt-6.1-sol", "openai/gpt-6-sol", "openai/gpt-5.6-sol", "openai/gpt-6.1-terra", "openai/gpt-6-astra", "openai/gpt-6-luna", "openai/gpt-6-luna-pro", "openai/gpt-6-luna:batch", "~openai/gpt-luna-latest"])).toEqual(["openai/gpt-6.1-sol", "openai/gpt-6.1-terra", "openai/gpt-6-astra", "openai/gpt-6-luna"]);
  });
  it("prefers undated native IDs and current DeepSeek generation", () => {
    expect(ids(["deepseek/deepseek-v4.1-flash-1017", "deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-pro", "deepseek/deepseek-v3.2", "deepseek/deepseek-r1"])).toEqual(["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-pro"]);
  });
  it("does not collapse distinct paid/free or provider routes", () => {
    expect(ids(["opencode-go/grok-4.7", "openrouter/x-ai/grok-4.7", "xai/grok-4.7", "openrouter/x-ai/grok-4.0:free"])).toHaveLength(4);
  });
  it("retains older starred and selected models without replacing their IDs", () => {
    expect(ids(["gpt-6.1-sol", "gpt-5.6-sol"], ["gpt-5.6-sol"])).toEqual(["gpt-6.1-sol", "gpt-5.6-sol"]);
  });
  it("keeps custom entries and removes exact duplicates", () => {
    expect(curatedModels([{ id: "mine", custom: true }, { id: "mine", custom: true }])).toEqual([{ id: "mine", custom: true }]);
  });
  it("curates discovered catalogs even when the driver marks every entry custom", () => {
    expect(curatedModels(["gpt-6.1-sol", "gpt-6-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-6-astra", "gpt-oss-120b", "gpt-5-mini"].map((id) => ({ id, custom: true }))).map((row) => row.id)).toEqual(["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-6-astra"]);
  });
  it("treats Grok 4.20 as the older 4.2 series, not version 20", () => {
    expect(ids(["x-ai/grok-4.20", "x-ai/grok-4.7"])).toEqual(["x-ai/grok-4.7"]);
  });
  it("caps each route/family at four distinct branches", () => {
    expect(ids(["qwen/qwen3-coder", "qwen/qwen3-thinking", "qwen/qwen3-instruct", "qwen/qwen3-mini", "qwen/qwen3-small"])).toHaveLength(4);
  });
});
