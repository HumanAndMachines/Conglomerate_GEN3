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
    isRunningExpectedLaunchpad: async (url) => {
      calls.push(["probe", url]);
      return true;
    },
    openExisting: async (url) => calls.push(["open", url]),
  });

  expect(result).toEqual({ mode: "reused", url: "http://127.0.0.1:4174" });
  expect(calls).toEqual([
    ["probe", "http://127.0.0.1:4174"],
    ["open", "http://127.0.0.1:4174"],
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
    isRunningExpectedLaunchpad: async (url) => {
      calls.push(["probe", url]);
      return false;
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
    isRunningExpectedLaunchpad: async () => false,
  })).rejects.toMatchObject({ code: "EADDRINUSE" });
});
