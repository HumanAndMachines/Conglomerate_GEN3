import { expect, test } from "bun:test";
import { rolloutBuddyArtifact } from "./runtime/buddy-rollout-lib.mjs";

const BASE = {
  archivePath: "/staging/candidate.tar",
  checksumPath: "/staging/candidate.tar.sha256",
  installRoot: "/opt/lazurio",
  channel: "candidate",
  mutableMountSources: { personalspace: "/srv/conglomerate/personalspace" },
};

test("Buddy rollout publishes success only after resident and service gates both pass", async () => {
  const calls = [];
  const result = await rolloutBuddyArtifact({
    ...BASE,
    updaterInstaller: async (options) => {
      calls.push(["resident", options]);
      return { status: "updated", active: "candidate-b", previous: "candidate-a" };
    },
    serviceInstaller: async (options) => {
      calls.push(["services", options]);
      return { bridge_queue_registered: true, hermes_context_cwd: "/opt/lazurio/active" };
    },
  });
  expect(result.status).toBe("updated");
  expect(result.services.bridge_queue_registered).toBe(true);
  expect(calls.map(([kind]) => kind)).toEqual(["resident", "services"]);
  expect(calls[0][1]).toMatchObject({
    expectedProfile: "buddy",
    mutableMountSources: BASE.mutableMountSources,
  });
});

test("failed update service gate restores the previous resident and reconciles its services", async () => {
  const calls = [];
  let serviceAttempt = 0;
  await expect(rolloutBuddyArtifact({
    ...BASE,
    updaterInstaller: async () => ({
      status: "updated",
      active: "candidate-b",
      previous: "candidate-a",
    }),
    serviceInstaller: async () => {
      serviceAttempt += 1;
      calls.push(`services-${serviceAttempt}`);
      if (serviceAttempt === 1) throw new Error("synthetic hearing failure");
      return { bridge_queue_registered: true };
    },
    activationReverter: async (options) => {
      calls.push(`revert-${options.failedArtifactId}`);
      return { status: "activation_reverted", active: "candidate-a" };
    },
  })).rejects.toThrow("compensated");
  expect(calls).toEqual([
    "services-1",
    "revert-candidate-b",
    "services-2",
  ]);
});

test("failed first cohort service gate removes the initial activation and leaves old services in place", async () => {
  const calls = [];
  await expect(rolloutBuddyArtifact({
    ...BASE,
    updaterInstaller: async () => ({
      status: "installed",
      active: "candidate-a",
      previous: null,
    }),
    serviceInstaller: async () => {
      calls.push("services");
      throw new Error("synthetic first-cutover failure");
    },
    activationReverter: async () => {
      calls.push("deactivate");
      return { status: "initial_activation_reverted", active: null };
    },
  })).rejects.toThrow("initial_activation_reverted");
  expect(calls).toEqual(["services", "deactivate"]);
});

test("a no-op resident never triggers activation compensation", async () => {
  let reverted = false;
  await expect(rolloutBuddyArtifact({
    ...BASE,
    updaterInstaller: async () => ({ status: "noop", active: "candidate-a", previous: null }),
    serviceInstaller: async () => {
      throw new Error("synthetic reconcile failure");
    },
    activationReverter: async () => {
      reverted = true;
    },
  })).rejects.toThrow("resident_activation_unchanged");
  expect(reverted).toBe(false);
});
