import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";

import {
  classifyRepositoryProbe,
  classifyDataState,
  evaluateEffectiveRules,
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
      lock_branch: { enabled: false },
      required_signatures: { enabled: false },
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
        lock_branch: { enabled: false },
        required_signatures: { enabled: false },
        [field]: value,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain(phrase);
  }
});

test("rejects a locked branch, required signatures and friction rulesets", () => {
  for (const field of ["lock_branch", "required_signatures"]) {
    const result = evaluateProtection({
      kind: "configured",
      value: {
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        enforce_admins: { enabled: true },
        required_pull_request_reviews: null,
        required_status_checks: null,
        restrictions: null,
        lock_branch: { enabled: false },
        required_signatures: { enabled: false },
        [field]: { enabled: true },
      },
    });
    expect(result.ok).toBe(false);
  }
  const result = evaluateEffectiveRules({
    kind: "configured",
    value: [
      { type: "non_fast_forward", ruleset_id: 7 },
      { type: "deletion", ruleset_id: 7 },
      { type: "pull_request", ruleset_id: 7 },
      { type: "required_status_checks", ruleset_id: 7 },
      { type: "update", ruleset_id: 7 },
    ],
    details: {
      7: { enforcement: "active", bypass_actors: [] },
    },
  });
  expect(result.historyProtected).toBe(true);
  expect(result.problems).toHaveLength(3);
  expect(evaluateEffectiveRules({ kind: "unsupported" })).toEqual({
    kind: "unsupported",
    historyProtected: false,
    problems: [],
  });
});

test("accepts native rulesets only when both history rules have no bypass", () => {
  const classic = { kind: "unconfigured" };
  const rules = {
    kind: "configured",
    value: [
      { type: "non_fast_forward", ruleset_id: 9 },
      { type: "deletion", ruleset_id: 9 },
    ],
    details: {
      9: { enforcement: "active", bypass_actors: [] },
    },
  };
  expect(evaluateProtection(classic, rules)).toEqual({
    mode: "provider-enforced",
    ok: true,
    problems: [],
  });
  rules.details[9].bypass_actors = [{ actor_type: "RepositoryRole" }];
  expect(evaluateProtection(classic, rules)).toMatchObject({
    mode: "capable-unprotected",
    ok: false,
  });
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

test("trusted-process gates only objective automation and unconfirmed membership", () => {
  const writers = Array.from({ length: 20 }, (_, index) => ({
    login: `builder-${index}`,
    type: "User",
  }));
  expect(
    evaluateTrustedProcessCircle({
      enforcementMode: "trusted-process",
      writers,
    }),
  ).toEqual([]);
  expect(
    evaluateTrustedProcessCircle({
      enforcementMode: "trusted-process",
      writers: [{ login: "writer-bot", type: "Bot" }],
    }).join(" "),
  ).toContain("automatizovaného writera");
  expect(
    evaluateTrustedProcessCircle({
      enforcementMode: "trusted-process",
      writers,
      unconfirmedMemberships: [
        { login: "unconfirmed-builder", message: "GitHub vrátil 404" },
      ],
    }).join(" "),
  ).toContain("membership writera unconfirmed-builder není potvrzené");
  expect(
    evaluateTrustedProcessCircle({
      enforcementMode: "provider-enforced",
      writers,
      unconfirmedMemberships: [
        { login: "unconfirmed-builder", message: "GitHub vrátil 404" },
      ],
    }),
  ).toEqual([]);
});

test("repository probe distinguishes a confirmed 404 from unreadable GitHub state", () => {
  expect(classifyRepositoryProbe({ status: 0, value: {} })).toEqual({
    exists: true,
    error: null,
  });
  expect(
    classifyRepositoryProbe({
      status: 1,
      value: { status: "404", message: "Not Found" },
    }),
  ).toEqual({ exists: false, error: null });
  expect(
    classifyRepositoryProbe({
      status: 1,
      value: { status: "403", message: "Forbidden" },
    }),
  ).toEqual({ exists: null, error: "Forbidden" });
  expect(
    classifyRepositoryProbe({ status: 1, value: null, stderr: "network failed" }),
  ).toEqual({ exists: null, error: "network failed" });
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

test("one malformed Organization is reported with its path instead of aborting the audit", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-invalid-smoke-"));
  const organizationRoot = join(root, "organizations", "Broken_GEN3");
  try {
    mkdirSync(organizationRoot, { recursive: true });
    writeFileSync(join(organizationRoot, "company.gen3.json"), "{broken\n");
    const results = runSmoke(root);
    expect(results).toHaveLength(1);
    expect(results[0].data_state).toBe("invalid");
    expect(results[0].errors.join(" ")).toContain("company.gen3.json");
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
