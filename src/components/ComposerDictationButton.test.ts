// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerDictationButton } from "./ComposerDictationButton";

let root: Root;
let container: HTMLDivElement;
const toggle = vi.fn();
const language = vi.fn();
const mic = () => container.querySelector("button")!;
const select = () => container.querySelector("select");
const fire = (name: string) => flushSync(() => mic().dispatchEvent(new PointerEvent(name, { bubbles: true, button: 0 })));
const click = () => flushSync(() => mic().click());
const advance = (ms: number) => flushSync(() => vi.advanceTimersByTime(ms));
const key = (key: string, shiftKey = false) => flushSync(() => mic().dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true })));
const render = (cloud = true) => flushSync(() => root.render(createElement(ComposerDictationButton, {
  language: "auto", onLanguage: language, onClick: toggle, cloud, transcribing: false, "aria-label": "Dictate",
})));

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  render();
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("hides language by default and preserves short tap dictation", () => {
  expect(select()).toBeNull();
  fire("pointerdown");
  advance(100);
  fire("pointerup");
  click();
  advance(500);
  expect(toggle).toHaveBeenCalledOnce();
  expect(select()).toBeNull();
});

it("opens Auto/Farsi/English on long press without recording on release", () => {
  fire("pointerdown");
  advance(500);
  expect(select()?.value).toBe("auto");
  expect([...select()!.options].map((option) => option.text)).toEqual(["Auto", "فارسی", "English"]);
  fire("pointerup");
  click();
  expect(toggle).not.toHaveBeenCalled();
  flushSync(() => {
    select()!.value = "fa";
    select()!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(language).toHaveBeenCalledWith("fa");
  expect(select()).toBeNull();
  expect(document.activeElement).toBe(mic());
  fire("pointerdown");
  fire("pointerup");
  click();
  expect(toggle).toHaveBeenCalledOnce();
});

it("cancels the long press on pointercancel without recording", () => {
  fire("pointerdown");
  advance(200);
  fire("pointercancel");
  advance(600);
  click();
  expect(select()).toBeNull();
  expect(toggle).not.toHaveBeenCalled();
});

it("cancels a pending menu on pointerleave", () => {
  fire("pointerdown");
  fire("pointerout");
  advance(600);
  expect(select()).toBeNull();
});

it.each(["ArrowDown", "ContextMenu", "F10"])("opens language with %s and restores focus on Escape", (name) => {
  key(name, name === "F10");
  expect(document.activeElement).toBe(select());
  flushSync(() => select()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(select()).toBeNull();
  expect(document.activeElement).toBe(mic());
  expect(toggle).not.toHaveBeenCalled();
  key("Enter");
  click();
  expect(toggle).toHaveBeenCalledOnce();
});

it("offers context menu access without starting dictation and closes outside", () => {
  flushSync(() => mic().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  expect(select()).not.toBeNull();
  expect(toggle).not.toHaveBeenCalled();
  flushSync(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(select()).toBeNull();
});

it("preserves native dictation without offering unsupported language selection", () => {
  render(false);
  fire("pointerdown");
  advance(600);
  fire("pointerup");
  click();
  expect(toggle).toHaveBeenCalledOnce();
  expect(select()).toBeNull();
  expect(mic().hasAttribute("aria-haspopup")).toBe(false);
});

it("cleans up a pending long press when unmounted", () => {
  fire("pointerdown");
  flushSync(() => root.render(null));
  expect(vi.getTimerCount()).toBe(0);
});
