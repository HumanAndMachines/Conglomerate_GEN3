import { expect, test } from "bun:test";
import { createGenerationSafeResponseCache } from "./apps-response-cache-lib.mjs";

test("apps cache deduplicates reads inside one generation", async () => {
  let builds = 0;
  const pending = deferred();
  const cache = createGenerationSafeResponseCache({
    build: () => {
      builds += 1;
      return pending.promise;
    },
    ttlMs: 30_000,
  });

  const first = cache.get();
  const shared = cache.get();
  expect(builds).toBe(1);
  pending.resolve({ value: "current" });

  expect(await first).toEqual({ value: "current" });
  expect(await shared).toEqual({ value: "current" });
  expect(await cache.get()).toEqual({ value: "current" });
  expect(builds).toBe(1);
});

test("apps cache expires at the configured TTL boundary", async () => {
  let clock = 1_000;
  let builds = 0;
  const cache = createGenerationSafeResponseCache({
    build: async () => ({ build: ++builds }),
    ttlMs: 10_000,
    now: () => clock,
  });

  expect(await cache.get()).toEqual({ build: 1 });
  clock = 10_999;
  expect(await cache.get()).toEqual({ build: 1 });
  clock = 11_000;
  expect(await cache.get()).toEqual({ build: 2 });
});

test("a rejected build clears in-flight state and can be retried", async () => {
  let builds = 0;
  const cache = createGenerationSafeResponseCache({
    build: async () => {
      builds += 1;
      if (builds === 1) throw new Error("temporary discovery failure");
      return { value: "recovered" };
    },
  });

  await expect(cache.get()).rejects.toThrow("temporary discovery failure");
  expect(await cache.get()).toEqual({ value: "recovered" });
  expect(builds).toBe(2);
});

test("an in-flight pre-mutation build cannot restore stale cache state", async () => {
  const builds = [];
  const commits = [];
  const cache = createGenerationSafeResponseCache({
    build: () => {
      const pending = deferred();
      builds.push(pending);
      return pending.promise;
    },
    onCommit: (value) => commits.push(value.value),
  });

  const staleRead = cache.get();
  cache.invalidate();
  const freshRead = cache.get();
  expect(builds).toHaveLength(2);

  builds[1].resolve({ value: "fresh" });
  expect(await freshRead).toEqual({ value: "fresh" });
  builds[0].resolve({ value: "stale" });
  expect(await staleRead).toEqual({ value: "stale" });

  expect(await cache.get()).toEqual({ value: "fresh" });
  expect(builds).toHaveLength(2);
  expect(commits).toEqual(["fresh"]);
});

test("a force build supersedes an older in-flight request even when it resolves first", async () => {
  const builds = [];
  const cache = createGenerationSafeResponseCache({
    build: () => {
      const pending = deferred();
      builds.push(pending);
      return pending.promise;
    },
  });

  const staleRead = cache.get();
  const forcedRead = cache.get({ force: true });
  expect(builds).toHaveLength(2);

  builds[0].resolve({ value: "stale" });
  expect(await staleRead).toEqual({ value: "stale" });
  builds[1].resolve({ value: "forced" });
  expect(await forcedRead).toEqual({ value: "forced" });

  expect(await cache.get()).toEqual({ value: "forced" });
  expect(builds).toHaveLength(2);
});

test("a failed mutation invalidates both the prior cache and any mid-mutation read", async () => {
  const snapshots = ["before", "during", "after"];
  let builds = 0;
  const cache = createGenerationSafeResponseCache({
    build: async () => ({ value: snapshots[builds++] }),
  });

  expect(await cache.get()).toEqual({ value: "before" });
  await expect(cache.runMutation(async () => {
    expect(await cache.get()).toEqual({ value: "during" });
    throw new Error("partial mutation failed");
  })).rejects.toThrow("partial mutation failed");

  expect(await cache.get()).toEqual({ value: "after" });
  expect(builds).toBe(3);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
