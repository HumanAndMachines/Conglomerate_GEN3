import { expect, test } from "bun:test";
import {
  buildCodexPortConflictPrompt,
  isCodexPortConflict,
} from "../public/codex-handoff.js";

const blockedApp = {
  id: "rozjedeme-ai-mission-control-v3",
  title: "Mission Control v3",
  company: "Rozjedeme-ai",
  port: 5392,
  cwd: "organizations/Rozjedeme-ai_GEN3/mission-control/app/v3",
  dependencies: {
    cwd: "organizations/Rozjedeme-ai_GEN3/mission-control/app/v3",
  },
  runtime: {
    failure_kind: "port_owner_cwd_mismatch",
    message: "Port 5392 používá proces z jiného checkoutu.",
    pid: 55429,
  },
};

test("Codex handoff pozná pouze cizího vlastníka portu", () => {
  expect(isCodexPortConflict(blockedApp)).toBe(true);
  expect(isCodexPortConflict({ runtime: { failure_kind: "port_owner_cwd_unknown" } })).toBe(false);
  expect(isCodexPortConflict({ runtime_status: "unhealthy" })).toBe(false);
});

test("Codex handoff předá přesný kontext a bezpečnostní hranice", () => {
  const prompt = buildCodexPortConflictPrompt(blockedApp);

  expect(prompt).toContain("Mission Control v3");
  expect(prompt).toContain("Rozjedeme-ai");
  expect(prompt).toContain("Port: 5392");
  expect(prompt).toContain("PID procesu na portu: 55429");
  expect(prompt).toContain("organizations/Rozjedeme-ai_GEN3/mission-control/app/v3");
  expect(prompt).toContain("Nejdřív pouze čtením ověř");
  expect(prompt).toContain("Pokud se PID změnil");
  expect(prompt).toContain("nic neukončuj");
  expect(prompt).toContain("neměň soubory, Git stav, závislosti ani data aplikací");
  expect(prompt).toContain("kliknu na „Obnovit stav“");
});

test("Codex handoff nevypíše undefined při neúplné diagnostice", () => {
  const prompt = buildCodexPortConflictPrompt({
    title: "Guide",
    runtime: { failure_kind: "port_owner_cwd_mismatch" },
  });

  expect(prompt).not.toContain("undefined");
  expect(prompt).not.toContain("null");
  expect(prompt).toContain("neuvedeno");
});
