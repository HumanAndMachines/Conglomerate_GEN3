import { createHash, randomUUID } from "crypto";
import { link, mkdir, readFile, rename, rm, unlink, writeFile } from "fs/promises";
import { join } from "path";

const defaultTimeoutMs = 30_000;
const defaultPollMs = 50;
const defaultIdentityTimeoutMs = 2_000;

export function moduleRuntimeLockName(key) {
  const label = String(key ?? "module").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  const digest = createHash("sha256").update(String(key ?? "")).digest("hex").slice(0, 12);
  return `${label || "module"}-${digest}.lock`;
}

export async function acquireModuleRuntimeLock({
  root,
  key,
  instanceId,
  pid = process.pid,
  timeoutMs = defaultTimeoutMs,
  pollMs = defaultPollMs,
  processAlive = defaultProcessAlive,
  resolveProcessIdentity = defaultProcessIdentity,
  now = () => new Date(),
}) {
  await mkdir(root, { recursive: true });
  const path = join(root, moduleRuntimeLockName(key));
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  const processIdentity = await boundedProcessIdentity(resolveProcessIdentity, pid, deadline);
  if (typeof processIdentity !== "string" || processIdentity.trim() === "") {
    throw new Error(`Module runtime lock ${key} nemůže ověřit identitu PID ${pid}`);
  }
  const owner = {
    schema_version: "lazurio.module_runtime_lock.v1",
    key,
    token,
    instance_id: instanceId,
    pid,
    process_identity: processIdentity,
    acquired_at: now().toISOString(),
  };
  while (true) {
    if (await claimLockFile({ path, owner })) {
      return {
        path,
        owner,
        release: () => releaseOwnedLock({ path, token }),
      };
    }

    const current = await readLockOwner(path);
    if (current && Number.isInteger(current.pid) && current.pid > 0) {
      const currentIdentity = await boundedProcessIdentity(resolveProcessIdentity, current.pid, deadline);
      const processStillOwnsLock = typeof current.process_identity === "string"
        ? typeof currentIdentity === "string"
          ? currentIdentity === current.process_identity
          : await processAlive(current.pid)
        : await processAlive(current.pid);
      if (!processStillOwnsLock) {
        await quarantineStaleLock({ path, expectedToken: current.token });
        continue;
      }
    }
    if (!current && await quarantineUnownedLock({ path })) continue;
    if (Date.now() >= deadline) {
      const ownerLabel = current
        ? `pid=${current.pid ?? "unknown"}, instance=${current.instance_id ?? "unknown"}`
        : "owner metadata unavailable";
      throw new Error(`Module runtime lock ${key} nebyl získán do ${timeoutMs} ms (${ownerLabel})`);
    }
    await sleep(pollMs);
  }
}

async function claimLockFile({ path, owner }) {
  const candidate = `${path}.candidate-${owner.token}`;
  let claimed = false;
  try {
    await writeFile(candidate, `${JSON.stringify(owner, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    // A hard link publishes a fully-written owner record atomically and fails
    // with EEXIST when another Launchpad already owns the module lock.
    await link(candidate, path);
    claimed = true;
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return false;
  } finally {
    await unlink(candidate).catch((error) => {
      if (error?.code !== "ENOENT" && !claimed) throw error;
    });
  }
}

async function readLockOwner(path) {
  try {
    return normalizeLockOwner(JSON.parse(await readFile(path, "utf8")));
  } catch {
    try {
      // Compatibility with directory locks written by the initial DEV-6439
      // implementation before atomic file publication was introduced.
      return normalizeLockOwner(JSON.parse(await readFile(join(path, "owner.json"), "utf8")));
    } catch {
      return null;
    }
  }
}

function normalizeLockOwner(owner) {
  return owner?.schema_version === "lazurio.module_runtime_lock.v1"
    && typeof owner.key === "string"
    && owner.key !== ""
    && typeof owner.token === "string"
    && owner.token !== ""
    && Number.isInteger(owner.pid)
    && owner.pid > 0
    ? owner
    : null;
}

async function releaseOwnedLock({ path, token }) {
  const current = await readLockOwner(path);
  if (!current || current.token !== token) return false;
  const quarantine = `${path}.release-${token}`;
  try {
    await rename(path, quarantine);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

async function quarantineStaleLock({ path, expectedToken }) {
  const current = await readLockOwner(path);
  if (!current || current.token !== expectedToken) return false;
  const quarantine = `${path}.stale-${expectedToken}`;
  try {
    await rename(path, quarantine);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

async function quarantineUnownedLock({ path }) {
  // Atomic file claims can never expose a missing/partial owner. A path that
  // still has no valid owner after the second read is therefore stale legacy
  // state or corruption and must not wedge every future Start/Open forever.
  if (await readLockOwner(path)) return false;
  const quarantine = `${path}.stale-unowned-${randomUUID()}`;
  try {
    await rename(path, quarantine);
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error?.code)) return false;
    throw error;
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

async function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function defaultProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const command = process.platform === "win32"
    ? [
        process.env.SystemRoot
          ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
          : "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$process = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue; if ($null -eq $process) { exit 3 }; $process.CreationDate.ToUniversalTime().ToString('o')`,
      ]
    : ["ps", "-o", "lstart=", "-p", String(pid)];
  try {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore", windowsHide: true });
    const timedOut = Symbol("identity-timeout");
    let timeoutId;
    const result = await Promise.race([
      Promise.all([child.exited, new Response(child.stdout).text()]),
      new Promise((resolveTimeout) => {
        timeoutId = setTimeout(() => resolveTimeout(timedOut), defaultIdentityTimeoutMs);
      }),
    ]);
    if (timeoutId) clearTimeout(timeoutId);
    if (result === timedOut) {
      try { child.kill("SIGKILL"); } catch {}
      return null;
    }
    const [exitCode, stdout] = result;
    const identity = stdout.trim();
    return exitCode === 0 && identity !== "" ? identity : null;
  } catch {
    return null;
  }
}

async function boundedProcessIdentity(resolver, pid, deadline) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return null;
  const timeoutMs = Math.min(defaultIdentityTimeoutMs, remainingMs);
  const timedOut = Symbol("identity-timeout");
  let timeoutId;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => resolver(pid)),
      new Promise((resolveTimeout) => {
        timeoutId = setTimeout(() => resolveTimeout(timedOut), timeoutMs);
      }),
    ]);
    return result === timedOut ? null : result;
  } catch {
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
