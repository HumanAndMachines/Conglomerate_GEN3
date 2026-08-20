import { expect, test } from "bun:test";

import {
  formatUpdateLaneReport,
  parseUpdateCliArgs,
  runUpdateLane,
} from "./update-cli-lib.mjs";

test("CLI keeps one command with only output and root options", () => {
  expect(parseUpdateCliArgs(["--json", "--root", "/tmp/Lazurio"])).toEqual({
    ok: true,
    options: { json: true, help: false, root: "/tmp/Lazurio" },
  });
  expect(parseUpdateCliArgs(["--root=/tmp/Lazurio"]).ok).toBe(true);
  for (const obsolete of ["--check", "--preserve", "--all-orgs", "--plan", "--apply"]) {
    const parsed = parseUpdateCliArgs([obsolete]);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("záměrně nemá");
  }
});

test("CLI adapter returns the shared engine report unchanged", async () => {
  const report = await runUpdateLane({
    rootPath: "/working",
    runtimeRoot: "/runtime",
    deps: {
      runId: "cli-parity",
      now: () => new Date("2026-08-20T12:00:00Z"),
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => ({ repos: [], warnings: [] }),
      updateRepo: async (repo) => ({
        repo_key: repo.key,
        repo_kind: repo.repo_kind,
        organization: null,
        module: "root",
        path: ".",
        state: "current",
        reason: "already_current",
        message: "Repo už je aktuální.",
      }),
    },
  });
  expect(report).toMatchObject({
    schema_version: "lazurio.update.v1",
    state: "current",
    run_id: "cli-parity",
    summary: { current: 1, updated: 0, blocked: 0 },
  });
});

test("human output uses only Lazurio and the three public states", () => {
  const text = formatUpdateLaneReport({
    state: "blocked",
    results: [{
      state: "blocked",
      path: "organizations/Example",
      message: "Historie potřebuje pomoc.",
      recovery_stash: "a".repeat(40),
      next_action: { prompt: "Oprav bezpečně main." },
    }],
    warnings: [],
  });
  expect(text).toContain("Lazurio update: blocked");
  expect(text).toContain("Recovery stash");
  expect(text).toContain("Prompt pro Codex");
  expect(text).not.toMatch(/Conglomerate|HumanAndMachine/);
});
