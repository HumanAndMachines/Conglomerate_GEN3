import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireCreateLock,
  releaseCreateLock,
} from "./worktree-create-lock.mjs";

const cleanupPaths = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

async function lockFixture() {
  const root = await mkdtemp(join(tmpdir(), "worktree-create-lock-"));
  cleanupPaths.push(root);
  const lockPath = join(root, ".worktrees", ".worktree-create.lock");
  await mkdir(join(root, ".worktrees"), { recursive: true });
  return { root, lockPath };
}

test("lock records ownership, blocks a live peer and releases only its own create_id", async () => {
  const { root, lockPath } = await lockFixture();
  const first = await acquireCreateLock({
    lockPath,
    primaryRoot: root,
    branch: "agent/CAC-0007-first",
    planCode: "CAC-0007",
    createId: () => "first",
    host: "fixture-host",
    pid: 7001,
    processAlive: () => true,
  });
  expect(first.ok).toBe(true);
  const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
  expect(owner).toMatchObject({
    create_id: "first",
    pid: 7001,
    hostname: "fixture-host",
    branch: "agent/CAC-0007-first",
    plan_code: "CAC-0007",
  });

  const second = await acquireCreateLock({
    lockPath,
    primaryRoot: root,
    branch: "agent/CAC-0007-second",
    createId: () => "second",
    host: "fixture-host",
    processAlive: () => true,
  });
  expect(second).toMatchObject({ ok: false });
  expect(second.message).toContain("fixture-host:7001");
  expect((await releaseCreateLock(first.lock)).released).toBe(true);
  expect(existsSync(lockPath)).toBe(false);
});

test.each([
  ["dead same-host owner", "fixture-host", false, true],
  ["live same-host owner", "fixture-host", true, false],
  ["foreign-host owner", "other-host", false, false],
])("stale recovery table: %s", async (_name, ownerHost, ownerAlive, shouldReclaim) => {
  const { root, lockPath } = await lockFixture();
  const old = new Date("2026-08-07T10:00:00.000Z");
  const current = new Date("2026-08-07T11:00:00.000Z");
  const owner = await acquireCreateLock({
    lockPath,
    primaryRoot: root,
    branch: "agent/CAC-0007-old",
    createId: () => "old-owner",
    host: ownerHost,
    pid: 7002,
    now: () => old,
  });
  expect(owner.ok).toBe(true);

  const candidate = await acquireCreateLock({
    lockPath,
    primaryRoot: root,
    branch: "agent/CAC-0007-new",
    createId: (() => {
      const ids = ["new-owner", "quarantine"];
      return () => ids.shift() ?? "fallback";
    })(),
    host: "fixture-host",
    pid: 7003,
    now: () => current,
    processAlive: () => ownerAlive,
  });
  expect(candidate.ok).toBe(shouldReclaim);
  if (shouldReclaim) {
    expect(candidate.reclaimed).toBe(true);
    expect((await releaseCreateLock(candidate.lock)).released).toBe(true);
  } else {
    expect(existsSync(lockPath)).toBe(true);
  }
});

test("malformed lock is never reclaimed automatically", async () => {
  const { root, lockPath } = await lockFixture();
  await mkdir(lockPath);
  await writeFile(join(lockPath, "owner.json"), "not-json\n", "utf8");
  const result = await acquireCreateLock({
    lockPath,
    primaryRoot: root,
    branch: "agent/CAC-0007-new",
  });
  expect(result).toMatchObject({ ok: false });
  expect(result.message).toContain("nemá ověřitelná ownership metadata");
  expect(existsSync(lockPath)).toBe(true);
});

test("release refuses to delete a lock whose ownership metadata changed", async () => {
  const { root, lockPath } = await lockFixture();
  const acquired = await acquireCreateLock({
    lockPath,
    primaryRoot: root,
    branch: "agent/CAC-0007-first",
    createId: () => "first",
  });
  const ownerPath = join(lockPath, "owner.json");
  const owner = JSON.parse(await readFile(ownerPath, "utf8"));
  await writeFile(ownerPath, `${JSON.stringify({ ...owner, create_id: "foreign" })}\n`, "utf8");
  const released = await releaseCreateLock(acquired.lock);
  expect(released.released).toBe(false);
  expect(released.reason).toContain("ownership changed");
  expect(existsSync(lockPath)).toBe(true);
});
