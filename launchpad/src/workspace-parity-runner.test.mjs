import { expect, test } from "bun:test";
import {
  bootReconcileProofAccepted,
  externalAssertions,
  explicitStopResponseAccepted,
  noResurrectionProofAccepted,
  parityLoopbackProbeHosts,
  parseArgs,
  runtimePortsMatchModuleLease,
  worktreeProvenanceMatches,
} from "./workspace-parity-runner.mjs";

const canonicalIotorOrganization = "IotorLazurio_GEN3";
const expectedCreator = "t3-code/iotor-builder";

test("workspace parity runner uses the same versioned phases for local and hosted profiles", () => {
  expect(parseArgs([
    "--profile", "local",
    "--phase", "live",
    "--organization", canonicalIotorOrganization,
    "--app-id", "iotor-knowledgebase-v2",
    "--worktree-slug", "DEV-6439-parity",
    "--expected-worktree-created-by", expectedCreator,
  ])).toMatchObject({ profile: "local", phase: "live" });
  expect(parseArgs([
    "--profile", "hosted",
    "--phase", "post-restart",
    "--organization", canonicalIotorOrganization,
    "--app-id", "iotor-knowledgebase-v2",
    "--worktree-slug", "DEV-6439-parity",
    "--expected-worktree-created-by", expectedCreator,
    "--expected-origin", "https://knowledgebase.iotor.example/",
    "--t3-pid", "101",
    "--codex-pid", "151",
    "--launchpad-pid", "202",
  ])).toMatchObject({
    profile: "hosted",
    phase: "post-restart",
    t3Pid: 101,
    codexPid: 151,
    launchpadPid: 202,
    expectedWorktreeCreatedBy: expectedCreator,
  });
  expect(parseArgs([
    "--profile", "hosted",
    "--phase", "expect-disabled",
    "--organization", canonicalIotorOrganization,
    "--app-id", "iotor-knowledgebase-v2",
    "--worktree-slug", "DEV-6439-parity",
    "--expected-worktree-created-by", expectedCreator,
    "--expected-origin", "https://knowledgebase.iotor.example/",
    "--t3-pid", "101",
    "--codex-pid", "151",
    "--launchpad-pid", "202",
  ])).toMatchObject({ phase: "expect-disabled" });
});

test("hosted parity runner fails closed without exact external origin", () => {
  expect(() => parseArgs([
    "--profile", "hosted",
    "--organization", canonicalIotorOrganization,
    "--app-id", "iotor-knowledgebase-v2",
    "--worktree-slug", "DEV-6439-parity",
    "--expected-worktree-created-by", expectedCreator,
  ])).toThrow("--expected-origin is required");
});

test("hosted evidence requests proof that the catalog origin is private development preview", () => {
  expect(externalAssertions).toContain(
    "generated Team service-catalog origin is a private development preview reachable only through the approved Tailscale/VPN access plane, never a public production endpoint",
  );
});

test("hosted parity runner requires T3, Codex and Launchpad process identities", () => {
  expect(() => parseArgs([
    "--profile", "hosted",
    "--organization", canonicalIotorOrganization,
    "--app-id", "iotor-knowledgebase-v2",
    "--worktree-slug", "DEV-6439-parity",
    "--expected-worktree-created-by", expectedCreator,
    "--expected-origin", "https://knowledgebase.iotor.example/",
    "--t3-pid", "101",
    "--launchpad-pid", "202",
  ])).toThrow("--codex-pid is required for hosted profile");
});

test("workspace parity runner requires an exact T3 creation identity", () => {
  expect(() => parseArgs([
    "--organization", canonicalIotorOrganization,
    "--app-id", "iotor-knowledgebase-v2",
    "--worktree-slug", "DEV-6439-parity",
  ])).toThrow("--expected-worktree-created-by is required");
});

test("expect-disabled is a separate phase after a recorded Stop", () => {
  expect(() => parseArgs([
    "--phase", "expect-disabled",
    "--stop-after",
    "--organization", canonicalIotorOrganization,
    "--app-id", "iotor-knowledgebase-v2",
    "--worktree-slug", "DEV-6439-parity",
    "--expected-worktree-created-by", expectedCreator,
  ])).toThrow("--stop-after is not valid");
});

test("runtime takeover requires one integer module lease port and exact equality", () => {
  expect(runtimePortsMatchModuleLease([24_301, 24_301, 24_301, 24_301], 24_301)).toBe(true);
  expect(runtimePortsMatchModuleLease([undefined, undefined, undefined, undefined], undefined)).toBe(false);
  expect(runtimePortsMatchModuleLease([24_301, 24_302, 24_301, 24_301], 24_301)).toBe(false);
  expect(runtimePortsMatchModuleLease([], 24_301)).toBe(false);
});

test("disabled vacancy probes every loopback spelling for the numeric module lease", () => {
  expect(parityLoopbackProbeHosts("localhost")).toEqual(["localhost", "127.0.0.1", "::1"]);
  expect(parityLoopbackProbeHosts("[::1]")).toEqual(["::1", "127.0.0.1"]);
});

test("Stop and post-stop restart evidence prove disabled desired state without resurrection", () => {
  const stopped = {
    action: "stop",
    desired: { enabled: false, status: "disabled", source: { type: "worktree", slug: "DEV-6439-parity" } },
    runtime: { managed: false, status: "stopped" },
  };
  expect(explicitStopResponseAccepted(stopped)).toBe(true);
  expect(explicitStopResponseAccepted({ ...stopped, desired: { enabled: true, status: "active" } })).toBe(false);

  const afterRestart = {
    managed: false,
    status: "stopped",
    owner: "none",
    port_owner: null,
    probe: { reachable: false },
    desired: stopped.desired,
    runtime_source: { type: "worktree", slug: "DEV-6439-parity" },
  };
  const noListener = { rawTcpReachable: false };
  expect(noResurrectionProofAccepted(afterRestart, "DEV-6439-parity", noListener)).toBe(true);
  expect(noResurrectionProofAccepted(afterRestart, "DEV-6439-parity", { rawTcpReachable: true })).toBe(false);
  expect(noResurrectionProofAccepted({ ...afterRestart, managed: true }, "DEV-6439-parity", noListener)).toBe(false);
  expect(noResurrectionProofAccepted({
    ...afterRestart,
    status: "healthy",
    owner: "adopted-port",
    port_owner: { pid: 404 },
    probe: { reachable: true },
  }, "DEV-6439-parity", noListener)).toBe(false);
  expect(noResurrectionProofAccepted(afterRestart, "another-worktree", noListener)).toBe(false);
});

test("worktree provenance and boot reconcile use the exact API and desired-state shapes", () => {
  const worktree = {
    ownership_status: "owned",
    metadata: { created_by: expectedCreator },
  };
  expect(worktreeProvenanceMatches(worktree, expectedCreator)).toBe(true);
  expect(worktreeProvenanceMatches({ ...worktree, created_by: expectedCreator, metadata: {} }, expectedCreator)).toBe(false);

  const health = {
    status: "healthy",
    managed: true,
    runtime_source: { type: "worktree", slug: "DEV-6439-parity" },
    desired: {
      enabled: true,
      status: "active",
      source: { type: "worktree", slug: "DEV-6439-parity" },
    },
  };
  expect(bootReconcileProofAccepted(health, "DEV-6439-parity")).toBe(true);
  expect(bootReconcileProofAccepted({
    ...health,
    desired: { ...health.desired, source: { type: "main" } },
  }, "DEV-6439-parity")).toBe(false);
  expect(bootReconcileProofAccepted({
    ...health,
    desired: { ...health.desired, enabled: false },
  }, "DEV-6439-parity")).toBe(false);
});
