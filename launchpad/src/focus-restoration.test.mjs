import { expect, test } from "bun:test";
import { focusMenuTriggerAfterRender } from "../public/focus-restoration.js";

test("destruktivní render vrátí fokus na nový ⋯ trigger stejné dlaždice", async () => {
  let focused = null;
  const candidates = [
    {
      dataset: { menuFocusKey: "jiná-dlaždice" },
      focus: () => { focused = "jiná-dlaždice"; },
    },
    {
      dataset: { menuFocusKey: "cílová-dlaždice" },
      focus: () => { focused = "cílová-dlaždice"; },
    },
  ];
  const root = {
    querySelectorAll(selector) {
      expect(selector).toBe(".app-more-button");
      return candidates;
    },
  };

  focusMenuTriggerAfterRender(root, "cílová-dlaždice");
  expect(focused).toBeNull();
  await Promise.resolve();
  expect(focused).toBe("cílová-dlaždice");
});

test("obnova fokusu je bezpečná, když se cílová dlaždice mezitím skryje", async () => {
  const root = { querySelectorAll: () => [] };
  focusMenuTriggerAfterRender(root, "skrytá-dlaždice");
  await Promise.resolve();
});
