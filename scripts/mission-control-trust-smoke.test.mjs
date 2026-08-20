import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";

import {
  classifyDataState,
  evaluateProtection,
  evaluateRootLedgers,
  evaluateTrustedProcessCircle,
  runSmoke,
} from "./mission-control-trust-smoke.mjs";

test("classifies active, planned and deliberately staged repositories separately", () => {
  expect(classifyDataState({ status: "active" }, true)).toBe("active");
  expect(classifyDataState({ status: "planned_slot" }, false)).toBe("planned");
  expect(classifyDataState({ status: "planned_slot" }, true)).toBe("staged");
  expect(classifyDataState(undefined, true)).toBe("incomplete");
});

test("accepts provider enforcement that preserves direct fast-forward pushes", () => {
  const result = evaluateProtection({
    kind: "configured",
    value: {
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: null,
      required_status_checks: null,
      restrictions: null,
    },
  });
  expect(result).toEqual({ mode: "provider-enforced", ok: true, problems: [] });
});

test("rejects provider rules that add PR, status-check or second-roster friction", () => {
  for (const [field, value, phrase] of [
    ["required_pull_request_reviews", {}, "pull request"],
    ["required_status_checks", {}, "status check"],
    ["restrictions", { users: [] }, "druhým push rosterem"],
  ]) {
    const result = evaluateProtection({
      kind: "configured",
      value: {
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        enforce_admins: { enabled: true },
        required_pull_request_reviews: null,
        required_status_checks: null,
        restrictions: null,
        [field]: value,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain(phrase);
  }
});

test("treats an unavailable private-branch feature as trusted-process, not as an access grant", () => {
  expect(evaluateProtection({ kind: "unsupported" })).toEqual({
    mode: "trusted-process",
    ok: true,
    problems: [],
  });
  expect(evaluateProtection({ kind: "unconfigured" }).ok).toBe(false);
  expect(evaluateProtection({ kind: "blocked", message: "forbidden" }).mode).toBe("blocked");
});

test("trusted-process growth guard is an audit gate, while provider enforcement accepts the same circle", () => {
  const writers = Array.from({ length: 11 }, (_, index) => ({
    login: `builder-${index}`,
    type: "User",
  }));
  expect(
    evaluateTrustedProcessCircle({
      enforcementMode: "trusted-process",
      writers,
      outsideLogins: ["outside-builder"],
    }).join(" "),
  ).toContain("před rozšířením nad 10");
  expect(
    evaluateTrustedProcessCircle({
      enforcementMode: "trusted-process",
      writers: [{ login: "writer-bot", type: "Bot" }],
    }).join(" "),
  ).toContain("automatizovaného writera");
  expect(
    evaluateTrustedProcessCircle({
      enforcementMode: "provider-enforced",
      writers,
      outsideLogins: ["outside-builder"],
    }),
  ).toEqual([]);
});

test("live smoke fails closed instead of passing an empty checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-empty-smoke-"));
  try {
    mkdirSync(join(root, "organizations"));
    expect(() => runSmoke(root)).toThrow("odmítá false-green běh bez Organizací");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active slots require empty typed pointers and canonical task sources", () => {
  const root = join(tmpdir(), `mc-pointer-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const taskSources = [];
  for (const [file, kind, collection] of [
    ["TODO.tasks.json", "todo-tasks-json", "tasks"],
    ["DONE.tasks.json", "done-tasks-json", "tasks"],
    ["ISSUES.open.json", "open-issues-json", "issues"],
  ]) {
    const canonical = `mission-control/db/data/mission-control/${file}`;
    writeFileSync(join(root, file), JSON.stringify({
      authority: "pointer",
      status: "read-only",
      superseded_by: canonical,
      frozen_snapshot: `history/mission-control-root-snapshots/2026-08-20/${file}`,
      [collection]: [],
    }));
    taskSources.push({ kind, path: canonical, authority: "source-of-truth" });
  }
  expect(evaluateRootLedgers(root, "active", taskSources)).toEqual([]);
  expect(evaluateRootLedgers(root, "planned", taskSources)).toContain(
    "planned slot nesmí předčasně používat root pointer TODO.tasks.json",
  );
});
