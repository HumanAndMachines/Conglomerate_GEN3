export function createGenerationSafeResponseCache({
  build,
  onCommit = null,
  ttlMs = 30_000,
  now = () => Date.now(),
} = {}) {
  if (typeof build !== "function") throw new TypeError("apps response cache requires a build function");
  if (onCommit !== null && typeof onCommit !== "function") {
    throw new TypeError("apps response cache onCommit must be a function");
  }

  let generation = 0;
  let cached = null;
  let inFlight = null;

  function invalidate() {
    generation += 1;
    cached = null;
    // Older callers still receive their own snapshot, but new callers must not
    // join work that began before this invalidation boundary.
    inFlight = null;
    return generation;
  }

  async function get({ force = false } = {}) {
    if (force) invalidate();
    const requestGeneration = generation;
    if (cached?.generation === requestGeneration && now() < cached.expiresAt) {
      return cached.value;
    }
    if (inFlight?.generation === requestGeneration) return inFlight.promise;

    let buildPromise;
    try {
      buildPromise = Promise.resolve(build());
    } catch (error) {
      buildPromise = Promise.reject(error);
    }
    const entry = {
      generation: requestGeneration,
      promise: buildPromise,
    };
    inFlight = entry;
    try {
      const value = await entry.promise;
      // A mutation or newer forced sync may have crossed the generation while
      // this build was running. Its caller may use the snapshot it requested,
      // but it can no longer publish cache or other server-wide side effects.
      if (generation === requestGeneration) {
        onCommit?.(value);
        cached = {
          generation: requestGeneration,
          value,
          expiresAt: now() + ttlMs,
        };
      }
      return value;
    } finally {
      if (inFlight === entry) inFlight = null;
    }
  }

  async function runMutation(action) {
    if (typeof action !== "function") throw new TypeError("apps response cache mutation requires an action");
    // Invalidate on both sides: a failed action may have changed part of the
    // runtime/filesystem, and a read racing inside the action may have observed
    // an intermediate state. Neither is safe to retain.
    invalidate();
    try {
      return await action();
    } finally {
      invalidate();
    }
  }

  return { get, invalidate, runMutation };
}
