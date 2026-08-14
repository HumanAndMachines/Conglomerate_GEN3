import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSingletonLock } from "../../bridge/inbound/singleton.ts";

const scratches: string[] = [];

afterEach(async () => {
  await Promise.all(scratches.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function lockPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "buddy-singleton-"));
  scratches.push(root);
  return join(root, "bridge.lock");
}

describe("Buddy bridge singleton ownership", () => {
  test("a live owner cannot be joined or stolen", async () => {
    const path = await lockPath();
    const first = await acquireSingletonLock(path);
    await expect(acquireSingletonLock(path)).rejects.toThrow("another Buddy bridge is already running");
    await first.release();
  });

  test("two contenders racing on a stale lock produce exactly one owner", async () => {
    const path = await lockPath();
    await writeFile(path, "999999999\n", { mode: 0o600 });

    const results = await Promise.allSettled([
      acquireSingletonLock(path),
      acquireSingletonLock(path),
    ]);
    const acquired = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireSingletonLock>>> =>
        result.status === "fulfilled",
    );
    expect(acquired).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await acquired[0]!.value.release();
  });

  test("an old owner release never removes a replacement owner's token", async () => {
    const path = await lockPath();
    const first = await acquireSingletonLock(path);
    const replacement = { version: 1, pid: process.pid, token: "replacement-owner-token" };
    await writeFile(path, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });

    await first.release();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(replacement);
  });
});
