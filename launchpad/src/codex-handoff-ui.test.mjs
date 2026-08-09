import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const publicRoot = join(import.meta.dirname, "..", "public");

test("portový blokátor otevírá přístupný Codex handoff dialog", async () => {
  const [app, component, css] = await Promise.all([
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "codex-handoff.js"), "utf8"),
    readFile(join(publicRoot, "codex-handoff.css"), "utf8"),
  ]);

  expect(app).toContain('from "./codex-handoff.js"');
  expect(app).toContain("isCodexPortConflict(app)");
  expect(app).toContain("openCodexPortConflictDialog(app)");
  expect(app).toContain('action.textContent = isCodexPortConflict(app) ? "Vyřešit s Codexem" : "Zobrazit aplikaci"');
  expect(app).toContain("action.dataset.appId = app.id");
  expect(component).toContain('document.createElement("dialog")');
  expect(component).toContain('dialog.setAttribute("aria-labelledby", "codexHandoffTitle")');
  expect(component).toContain('copyStatus.setAttribute("aria-live", "polite")');
  expect(component).toContain('copyButton.textContent = "Zkopírovat zprávu"');
  expect(component).toContain('navigator.clipboard?.writeText');
  expect(component).toContain("findAppTrigger(appId)");
  expect(css).toContain(".codex-handoff-dialog::backdrop");
  expect(css).toContain("@media (max-width: 640px)");
});
