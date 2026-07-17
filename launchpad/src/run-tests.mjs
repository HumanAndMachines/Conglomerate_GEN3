const defaultTimeoutMs = process.platform === "win32" ? 15_000 : 5_000;
const child = Bun.spawn(
  [process.execPath, "test", "--timeout", String(defaultTimeoutMs), ...process.argv.slice(2)],
  {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);

process.exitCode = await child.exited;
