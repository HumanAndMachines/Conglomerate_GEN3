import { expect, test } from "bun:test";
import { startLaunchpadWithPortPolicy } from "./server-startup-lib.mjs";

function addressInUse() {
  return Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
}

test("default dev port falls forward to the next free port", async () => {
  const attempts = [];
  const result = await startLaunchpadWithPortPolicy({
    requestedPort: 4174,
    explicitPort: false,
    shouldOpen: false,
    startServer(port) {
      attempts.push(port);
      if (port === 4174) throw addressInUse();
      return { port };
    },
  });

  expect(attempts).toEqual([4174, 4175]);
  expect(result).toEqual({ mode: "started", server: { port: 4175 } });
});

test("explicit dev port fails closed instead of moving silently", async () => {
  await expect(startLaunchpadWithPortPolicy({
    requestedPort: 4174,
    explicitPort: true,
    shouldOpen: false,
    startServer() {
      throw addressInUse();
    },
  })).rejects.toMatchObject({ code: "EADDRINUSE" });
});

test("launch reuses only a same-root instance and opens it", async () => {
  const calls = [];
  const result = await startLaunchpadWithPortPolicy({
    requestedPort: 4174,
    explicitPort: false,
    shouldOpen: true,
    startServer() {
      throw addressInUse();
    },
    inspectRunningLaunchpad: async (url) => {
      calls.push(["probe", url]);
      return { status: "compatible" };
    },
    openExisting: async (url) => calls.push(["open", url]),
  });

  expect(result).toEqual({ mode: "reused", url: "http://127.0.0.1:4174" });
  expect(calls).toEqual([
    ["probe", "http://127.0.0.1:4174"],
    ["open", "http://127.0.0.1:4174"],
  ]);
});

test("agent serve reuses a same-root instance without opening a system browser", async () => {
  const calls = [];
  const result = await startLaunchpadWithPortPolicy({
    requestedPort: 4174,
    explicitPort: false,
    shouldOpen: false,
    shouldReuse: true,
    startServer() {
      throw addressInUse();
    },
    inspectRunningLaunchpad: async (url) => {
      calls.push(["probe", url]);
      return { status: "compatible" };
    },
    openExisting: async (url) => calls.push(["open", url]),
  });

  expect(result).toEqual({ mode: "reused", url: "http://127.0.0.1:4174" });
  expect(calls).toEqual([["probe", "http://127.0.0.1:4174"]]);
});

test("agent serve reuses a same-root instance on a fallback port", async () => {
  const attempts = [];
  const calls = [];
  const result = await startLaunchpadWithPortPolicy({
    requestedPort: 4174,
    explicitPort: false,
    shouldOpen: false,
    shouldReuse: true,
    startServer(port) {
      attempts.push(port);
      throw addressInUse();
    },
    inspectRunningLaunchpad: async (url) => {
      calls.push(["probe", url]);
      return { status: url === "http://127.0.0.1:4175" ? "compatible" : "foreign_root" };
    },
    openExisting: async (url) => calls.push(["open", url]),
  });

  expect(result).toEqual({ mode: "reused", url: "http://127.0.0.1:4175" });
  expect(attempts).toEqual([4174, 4175]);
  expect(calls).toEqual([
    ["probe", "http://127.0.0.1:4174"],
    ["probe", "http://127.0.0.1:4175"],
  ]);
});

test("launch falls forward when the requested implicit port belongs to a foreign root", async () => {
  const attempts = [];
  const calls = [];
  const result = await startLaunchpadWithPortPolicy({
    requestedPort: 4174,
    explicitPort: false,
    shouldOpen: true,
    startServer(port) {
      attempts.push(port);
      if (port === 4174) throw addressInUse();
      return { port };
    },
    inspectRunningLaunchpad: async (url) => {
      calls.push(["probe", url]);
      return { status: "foreign_root" };
    },
    openExisting: async () => {
      throw new Error("must not open foreign root");
    },
  });

  expect(attempts).toEqual([4174, 4175]);
  expect(calls).toEqual([["probe", "http://127.0.0.1:4174"]]);
  expect(result).toEqual({ mode: "started", server: { port: 4175 } });
});

test("explicit port with --open stays fail-closed for a foreign root", async () => {
  await expect(startLaunchpadWithPortPolicy({
    requestedPort: 4174,
    explicitPort: true,
    shouldOpen: true,
    startServer() {
      throw addressInUse();
    },
    inspectRunningLaunchpad: async () => ({ status: "foreign_root" }),
  })).rejects.toMatchObject({ code: "EADDRINUSE" });
});

test("dev mode refuses a second compatible Server for the same root", async () => {
  await expect(startLaunchpadWithPortPolicy({
    requestedPort: 4174,
    explicitPort: false,
    shouldOpen: false,
    shouldReuse: false,
    startServer() {
      throw addressInUse();
    },
    inspectRunningLaunchpad: async () => ({ status: "compatible" }),
  })).rejects.toMatchObject({ code: "LAZURIO_SERVER_ALREADY_RUNNING" });
});

test("same-root legacy and indeterminate processes fail closed without a fallback Server", async () => {
  for (const status of ["legacy_same_root", "protocol_incompatible", "probe_failed"]) {
    const attempts = [];
    await expect(startLaunchpadWithPortPolicy({
      requestedPort: 4174,
      explicitPort: false,
      shouldOpen: true,
      startServer(port) {
        attempts.push(port);
        throw addressInUse();
      },
      inspectRunningLaunchpad: async () => ({ status }),
    })).rejects.toMatchObject({
      code: status === "probe_failed" ? "LAZURIO_SERVER_PROBE_FAILED" : "LAZURIO_SERVER_UPGRADE_REQUIRED",
    });
    expect(attempts).toEqual([4174]);
  }
});

test("stale same-root Server is replaced only after the exact port is released", async () => {
  const attempts = [];
  const shutdowns = [];
  const result = await startLaunchpadWithPortPolicy({
    requestedPort: 4174,
    explicitPort: false,
    shouldOpen: true,
    startServer(port) {
      attempts.push(port);
      if (attempts.length < 3) throw addressInUse();
      return { port };
    },
    inspectRunningLaunchpad: async () => ({ status: "stale_install", identity: { instance_id: "fixture" } }),
    shutdownStaleLaunchpad: async (url, observation) => {
      shutdowns.push([url, observation.identity.instance_id]);
      return true;
    },
    waitBeforeStaleRebind: async () => {},
  });

  expect(result).toEqual({ mode: "started", server: { port: 4174 } });
  expect(attempts).toEqual([4174, 4174, 4174]);
  expect(shutdowns).toEqual([["http://127.0.0.1:4174", "fixture"]]);
});

test("failed stale shutdown never falls forward", async () => {
  const attempts = [];
  await expect(startLaunchpadWithPortPolicy({
    requestedPort: 4174,
    explicitPort: false,
    shouldOpen: true,
    startServer(port) {
      attempts.push(port);
      throw addressInUse();
    },
    inspectRunningLaunchpad: async () => ({ status: "stale_install" }),
    shutdownStaleLaunchpad: async () => false,
  })).rejects.toMatchObject({ code: "LAZURIO_STALE_SERVER_STOP_FAILED" });
  expect(attempts).toEqual([4174]);
});
