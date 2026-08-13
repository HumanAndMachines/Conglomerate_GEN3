import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { acquireModuleRuntimeLock, moduleRuntimeLockName } from "./module-runtime-lock-lib.mjs";

const roots = [];
afterAll(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test("two Launchpad instances serialize the same company/module transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-module-lock-"));
  roots.push(root);
  const first = await acquireModuleRuntimeLock({ root, key: "Acme/presentation", instanceId: "one" });
  let secondAcquired = false;
  const secondPromise = acquireModuleRuntimeLock({
    root,
    key: "Acme/presentation",
    instanceId: "two",
    timeoutMs: 1_000,
    pollMs: 5,
  }).then((lock) => {
    secondAcquired = true;
    return lock;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(secondAcquired).toBe(false);
  await first.release();
  const second = await secondPromise;
  expect(secondAcquired).toBe(true);
  await second.release();
});

test("a dead owner is quarantined and its stale mutex is recovered", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-module-lock-stale-"));
  roots.push(root);
  const identities = new Map([[987654, "dead-owner"], [process.pid, "live-owner"]]);
  const resolveProcessIdentity = async (pid) => identities.get(pid) ?? null;
  const first = await acquireModuleRuntimeLock({
    root,
    key: "Acme/demo",
    instanceId: "dead",
    pid: 987654,
    resolveProcessIdentity,
  });
  identities.set(987654, null);
  const recovered = await acquireModuleRuntimeLock({
    root,
    key: "Acme/demo",
    instanceId: "live",
    processAlive: async () => false,
    resolveProcessIdentity,
  });
  expect(recovered.owner.instance_id).toBe("live");
  expect(await first.release()).toBe(false);
  await recovered.release();
});

test("a reused live PID cannot keep a stale module lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-module-lock-pid-reuse-"));
  roots.push(root);
  let identity = "original-process";
  const resolveProcessIdentity = async () => identity;
  const first = await acquireModuleRuntimeLock({
    root,
    key: "Acme/reused-pid",
    instanceId: "crashed",
    pid: 4242,
    resolveProcessIdentity,
  });
  identity = "different-process-same-pid";
  const recovered = await acquireModuleRuntimeLock({
    root,
    key: "Acme/reused-pid",
    instanceId: "live",
    pid: 4242,
    processAlive: async () => true,
    resolveProcessIdentity,
  });
  expect(recovered.owner.process_identity).toBe("different-process-same-pid");
  expect(await first.release()).toBe(false);
  await recovered.release();
});

test("transient identity lookup failure cannot steal a live lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-module-lock-identity-failure-"));
  roots.push(root);
  const ownerPid = 4243;
  let failOwnerLookup = false;
  const resolveProcessIdentity = async (pid) => {
    if (pid === ownerPid) return failOwnerLookup ? null : "live-owner";
    return "contender";
  };
  const first = await acquireModuleRuntimeLock({
    root,
    key: "Acme/live-owner",
    instanceId: "live",
    pid: ownerPid,
    resolveProcessIdentity,
  });
  failOwnerLookup = true;

  await expect(acquireModuleRuntimeLock({
    root,
    key: "Acme/live-owner",
    instanceId: "contender",
    timeoutMs: 20,
    pollMs: 5,
    processAlive: async () => true,
    resolveProcessIdentity,
  })).rejects.toThrow("nebyl získán");
  expect(await first.release()).toBe(true);
});

test("hung identity lookup is bounded by the module lock timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-module-lock-hung-identity-"));
  roots.push(root);
  const startedAt = Date.now();
  await expect(acquireModuleRuntimeLock({
    root,
    key: "Acme/hung-identity",
    instanceId: "contender",
    timeoutMs: 25,
    resolveProcessIdentity: async () => new Promise(() => {}),
  })).rejects.toThrow("nemůže ověřit identitu");
  expect(Date.now() - startedAt).toBeLessThan(250);
});

test("an incomplete legacy lock without owner metadata is recovered", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-module-lock-incomplete-"));
  roots.push(root);
  await mkdir(join(root, moduleRuntimeLockName("Acme/incomplete")));

  const recovered = await acquireModuleRuntimeLock({
    root,
    key: "Acme/incomplete",
    instanceId: "live",
    timeoutMs: 1_000,
  });
  expect(recovered.owner.instance_id).toBe("live");
  await recovered.release();
});

test("a malformed owner record cannot wedge the module lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-module-lock-malformed-"));
  roots.push(root);
  await writeFile(
    join(root, moduleRuntimeLockName("Acme/malformed")),
    JSON.stringify({ schema_version: "lazurio.module_runtime_lock.v1", pid: process.pid }),
  );

  const recovered = await acquireModuleRuntimeLock({
    root,
    key: "Acme/malformed",
    instanceId: "live",
    timeoutMs: 1_000,
  });
  expect(recovered.owner.instance_id).toBe("live");
  await recovered.release();
});

test("lock paths cannot escape the runtime lock directory", () => {
  expect(moduleRuntimeLockName("../../Acme/Demo")).toMatch(/^[a-z0-9-]+\.lock$/);
});
