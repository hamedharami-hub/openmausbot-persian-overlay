// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ResearchRequestBar } from "./ResearchRequestBar";

it("changes depth independently of length and can remove the request mode", () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), onChange = vi.fn();
  flushSync(() => root.render(createElement(ResearchRequestBar, { value: { mode: "research", depth: "deep", length: "short" }, onChange })));
  const selects = container.querySelectorAll("select");
  expect(selects).toHaveLength(2);
  selects[0]!.value = "standard";
  flushSync(() => selects[0]!.dispatchEvent(new Event("change", { bubbles: true })));
  expect(onChange).toHaveBeenLastCalledWith({ mode: "research", depth: "standard", length: "short" });
  flushSync(() => container.querySelector("button")!.click());
  expect(onChange).toHaveBeenLastCalledWith(null);
  flushSync(() => root.unmount()); container.remove();
});
