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

test("launch refuses a foreign root on the requested port", async () => {
  await expect(startLaunchpadWithPortPolicy({
    requestedPort: 4174,
    explicitPort: false,
    shouldOpen: true,
    startServer() {
      throw addressInUse();
    },
    isRunningExpectedLaunchpad: async () => false,
    openExisting: async () => {
      throw new Error("must not open");
    },
  })).rejects.toMatchObject({ code: "EADDRINUSE" });
});
