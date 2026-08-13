import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDesiredModuleState,
  desiredModuleStatePath,
  listDesiredModuleStates,
  readDesiredModuleState,
  validateDesiredModuleState,
  writeDesiredModuleState,
} from "./desired-module-state-lib.mjs";

const roots = [];
const app = { id: "acme-demo-v1", company: "acme", module: "demo" };

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("desired module state is written atomically and preserves the last complete revision", async () => {
  const root = await temporaryRoot();
  const first = buildDesiredModuleState({ app, source: { type: "main" } });
  await writeDesiredModuleState({ root, state: first });

  const second = buildDesiredModuleState({
    app,
    source: { type: "worktree", slug: "DEV-6439-demo" },
    previous: first,
  });
  let renameAttempted = false;
  await expect(writeDesiredModuleState({
    root,
    state: second,
    renameFn: async () => {
      renameAttempted = true;
      throw new Error("simulated atomic replace failure");
    },
  })).rejects.toThrow("simulated atomic replace failure");

  expect(renameAttempted).toBe(true);
  expect(await readDesiredModuleState({ root, company: "acme", module: "demo" })).toEqual(first);
  expect((await listDesiredModuleStates({ root })).filter((item) => !item.ok)).toEqual([]);
});

test("desired module state rejects unknown fields and non-canonical worktree sources", () => {
  const state = buildDesiredModuleState({ app, source: { type: "main" } });
  expect(validateDesiredModuleState({ ...state, token: "must-not-persist" })).toContain("unknown property: token");
  expect(validateDesiredModuleState({
    ...state,
    source: { type: "worktree", slug: "DEV-6439-demo", path: "/tmp/checkout" },
  })).toContain("source contains non-canonical properties");
  expect(validateDesiredModuleState({
    ...state,
    source: { type: "worktree", slug: "x".repeat(201) },
  })[0]).toContain("1-200");
  expect(validateDesiredModuleState({
    ...state,
    source: { type: "worktree", slug: "../DEV-6439-demo" },
  })[0]).toContain("canonical worktree slug");
  expect(validateDesiredModuleState({
    ...state,
    source: { type: "worktree", slug: "DEV 6439 demo" },
  })[0]).toContain("canonical worktree slug");
  expect(validateDesiredModuleState({ ...state, updated_at: "August 13, 2026" }))
    .toContain("updated_at must be an ISO date-time");
  expect(validateDesiredModuleState({ ...state, updated_at: "2026-08-13T12:00:00" }))
    .toContain("updated_at must be an ISO date-time");
});

test("invalid persisted desired state is enumerated as fail-closed evidence", async () => {
  const root = await temporaryRoot();
  await mkdir(root, { recursive: true });
  await writeFile(desiredModuleStatePath(root, "acme", "demo"), "{ invalid json\n", "utf8");
  const [entry] = await listDesiredModuleStates({ root });
  expect(entry.ok).toBe(false);
  expect(entry.error).toContain("is not valid JSON");
});

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "lazurio-desired-state-"));
  roots.push(root);
  return root;
}
