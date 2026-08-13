import { existsSync } from "node:fs";
import { readFile, readlink, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";

import { buildLaunchpadDoctorReport } from "./diagnostics-lib.mjs";
import { discoverLaunchpadApps } from "./discovery-lib.mjs";

const schemaVersion = "lazurio.workspace_machine_parity.v1";
const externalAssertions = [
  "authenticated Team HTTPS/WSS ingress on 443 reaches only the expected app origin",
  "internal module-owned ports are unreachable directly from Tailnet/VPN clients",
  "another Team Workspace cannot reach this Workspace filesystem, processes or ingress",
  "server-side broker denies repositories outside the generated Team allowlist",
  "host reboot restores the work container before the post-restart phase runs",
];

if (import.meta.main) {
  const options = parseArgs(Bun.argv.slice(2));
  if (options.help) {
    console.log(helpText());
  } else {
    const report = await runWorkspaceParity(options);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.summary.failed > 0 ? 1 : 0;
  }
}

export async function runWorkspaceParity(options) {
  const checkedAt = new Date().toISOString();
  const checks = [];
  const add = (id, ok, evidence = {}) => checks.push({ id, status: ok ? "pass" : "fail", ...evidence });
  const home = process.env.HOME ?? "";
  const lazurioRoot = resolve(options.root ?? join(home, "Lazurio"));
  const canonicalRoot = existsSync(lazurioRoot) ? await realpath(lazurioRoot) : lazurioRoot;
  const expectedRoot = join(home, "Lazurio");
  add("filesystem.lazurio_root", canonicalRoot === expectedRoot, {
    expected: expectedRoot,
    observed: canonicalRoot,
  });
  add("identity.home", Boolean(home) && isAbsolute(home), { home });
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  add("identity.non_root", options.profile !== "hosted" || (Number.isInteger(uid) && uid !== 0), { uid });

  const organizationRoot = resolve(lazurioRoot, "organizations", options.organization);
  const organizationBoundary = relative(lazurioRoot, organizationRoot);
  add("filesystem.organization_mount", existsSync(organizationRoot)
    && organizationBoundary !== ""
    && !organizationBoundary.startsWith("..")
    && !isAbsolute(organizationBoundary), { organization_root: organizationRoot });
  for (const file of ["company.gen3.json", "modules.manifest.json"]) {
    add(`manifest.${file}`, existsSync(join(organizationRoot, file)), { path: join(organizationRoot, file) });
  }

  const commands = {
    bun: Bun.which("bun"),
    git: Bun.which("git"),
    codex: Bun.which("codex"),
    t3: Bun.which(options.t3Command),
  };
  for (const [command, path] of Object.entries(commands)) add(`toolchain.${command}`, Boolean(path), { command, path });

  let discovery = null;
  try {
    discovery = await discoverLaunchpadApps(lazurioRoot);
    add("launchpad.discovery", discovery.failures.length === 0, {
      app_count: discovery.apps.length,
      failures: discovery.failures,
    });
  } catch (error) {
    add("launchpad.discovery", false, { error: error.message });
  }
  const app = discovery?.apps.find((candidate) => candidate.id === options.appId) ?? null;
  add("launchpad.app_discovered", Boolean(app), { app_id: options.appId });
  if (app) {
    const staticListeners = (app.listeners ?? []).length > 0
      && app.listeners.every((listener) => listener.allocation === "static" && Number.isInteger(listener.port));
    add("launchpad.module_lease", app.module_contract?.schema_version === "lazurio.module.v1"
      && app.runtime_contract?.schema_version === "lazurio.runtime.v1"
      && staticListeners, {
      module_lease_key: `${app.company}/${app.module}`,
      listeners: (app.listeners ?? []).map((listener) => ({ id: listener.id, host: listener.host, port: listener.port })),
    });
  }

  if (!options.skipDoctor) {
    try {
      const doctor = await buildLaunchpadDoctorReport({
        companiesRoot: lazurioRoot,
        launchpadRoot: join(lazurioRoot, "launchpad"),
        allowMissingOrganizations: false,
        runChildDoctors: true,
      });
      add("launchpad.doctor", ["ok", "warn"].includes(doctor.summary.status), {
        doctor_status: doctor.summary.status,
      });
    } catch (error) {
      add("launchpad.doctor", false, { error: error.message });
    }
  }

  await appendNegativeSecurityChecks({ add });
  const runtimeEvidence = app ? await appendRuntimeChecks({ add, app, options }) : null;
  await appendNamespaceChecks({ add, options, home, runtimeEvidence });

  const summary = {
    passed: checks.filter((check) => check.status === "pass").length,
    failed: checks.filter((check) => check.status === "fail").length,
  };
  return {
    schema_version: schemaVersion,
    profile: options.profile,
    phase: options.phase,
    checked_at: checkedAt,
    root: canonicalRoot,
    organization: options.organization,
    app_id: options.appId,
    worktree_slug: options.worktreeSlug,
    summary,
    checks,
    external_assertions_required: externalAssertions,
  };
}

async function appendRuntimeChecks({ add, app, options }) {
  let moduleProcess = null;
  const base = new URL(options.launchpadUrl);
  try {
    const worktreesUrl = new URL("/api/git/worktrees", base);
    worktreesUrl.searchParams.set("organization", app.company);
    worktreesUrl.searchParams.set("module", app.module);
    const worktrees = await fetchJson(worktreesUrl);
    const worktree = (worktrees.worktrees ?? []).find((candidate) => candidate.slug === options.worktreeSlug);
    add("worktree.launchpad_visible", Boolean(worktree) && worktree.ownership_status === "owned", {
      worktree_slug: options.worktreeSlug,
      ownership_status: worktree?.ownership_status ?? "missing",
    });
    add("worktree.t3_provenance", worktreeProvenanceMatches(worktree, options.expectedWorktreeCreatedBy), {
      created_by: worktree?.metadata?.created_by ?? null,
      expected_created_by: options.expectedWorktreeCreatedBy,
    });
  } catch (error) {
    add("worktree.launchpad_visible", false, { error: error.message });
    add("worktree.t3_provenance", false, { error: error.message });
  }

  if (options.phase === "expect-disabled") {
    try {
      const health = await runtimeRequest(base, app.id, "health", worktreeSource(options.worktreeSlug));
      const listenerHost = app.entrypoint_listener?.host ?? app.host;
      const listenerPort = app.entrypoint_listener?.port ?? app.port;
      const probeHosts = parityLoopbackProbeHosts(listenerHost);
      const probeResults = Number.isInteger(listenerPort)
        ? await Promise.all(probeHosts.map(async (host) => ({
            host,
            reachable: await tcpReachable(host, listenerPort),
          })))
        : [{ host: listenerHost, reachable: true }];
      const rawTcpReachable = probeResults.some((result) => result.reachable);
      add("runtime.module_port_vacant", rawTcpReachable === false, {
        port: listenerPort,
        probes: probeResults,
        raw_tcp_reachable: rawTcpReachable,
      });
      add("runtime.no_resurrection", noResurrectionProofAccepted(
        health,
        options.worktreeSlug,
        { rawTcpReachable },
      ), {
        runtime_status: health.status,
        managed: health.managed,
        runtime_source: health.runtime_source,
        desired: health.desired,
      });
      add("runtime.external_url", navigationMatchesProfile(health.url, options), {
        observed: health.url,
        expected: options.profile === "hosted" ? options.expectedOrigin : "loopback",
      });
    } catch (error) {
      add("runtime.no_resurrection", false, { error: error.message });
    }
    return { moduleProcess: null, moduleExpected: false };
  }

  if (options.phase === "post-restart") {
    try {
      const health = await runtimeRequest(base, app.id, "health", worktreeSource(options.worktreeSlug));
      add("runtime.boot_reconcile", bootReconcileProofAccepted(health, options.worktreeSlug), {
        runtime_status: health.status,
        managed: health.managed,
        runtime_source: health.runtime_source,
        desired: health.desired,
      });
      add("runtime.external_url", navigationMatchesProfile(health.url, options), {
        observed: health.url,
        expected: options.profile === "hosted" ? options.expectedOrigin : "loopback",
      });
      moduleProcess = await captureModuleProcessEvidence(health, options);
      if (options.stopAfter) {
        const stopped = await runtimeRequest(base, app.id, "stop", worktreeSource(options.worktreeSlug));
        appendExplicitStopCheck(add, stopped);
      }
    } catch (error) {
      add("runtime.boot_reconcile", false, { error: error.message });
    }
    return { moduleProcess, moduleExpected: true };
  }

  try {
    const mainOne = await runtimeRequest(base, app.id, "open", { source: { type: "main" } });
    const worktreeOne = await runtimeRequest(base, app.id, "open", worktreeSource(options.worktreeSlug));
    const mainTwo = await runtimeRequest(base, app.id, "open", { source: { type: "main" } });
    const worktreeTwo = await runtimeRequest(base, app.id, "open", worktreeSource(options.worktreeSlug));
    const ports = [mainOne, worktreeOne, mainTwo, worktreeTwo].map((result) => result.runtime?.port);
    add("runtime.main_worktree_takeover", runtimePortsMatchModuleLease(ports, app.port)
      && mainOne.runtime_source?.type === "main"
      && worktreeOne.runtime_source?.slug === options.worktreeSlug
      && mainTwo.runtime_source?.type === "main"
      && worktreeTwo.runtime_source?.slug === options.worktreeSlug, {
      ports,
      final_source: worktreeTwo.runtime_source,
      desired: worktreeTwo.desired,
    });
    add("runtime.external_url", navigationMatchesProfile(worktreeTwo.url, options), {
      observed: worktreeTwo.url,
      expected: options.profile === "hosted" ? options.expectedOrigin : "loopback",
    });
    moduleProcess = await captureModuleProcessEvidence(worktreeTwo.runtime, options);
    if (options.stopAfter) {
      const stopped = await runtimeRequest(base, app.id, "stop", worktreeSource(options.worktreeSlug));
      appendExplicitStopCheck(add, stopped);
    }
  } catch (error) {
    add("runtime.main_worktree_takeover", false, { error: error.message });
  }
  return { moduleProcess, moduleExpected: true };
}

export function parityLoopbackProbeHosts(declaredHost) {
  const normalized = String(declaredHost ?? "").replace(/^\[(.*)\]$/, "$1");
  return [...new Set([normalized, "127.0.0.1", "::1"].filter(Boolean))];
}

export function worktreeProvenanceMatches(worktree, expectedCreatedBy) {
  return Boolean(worktree)
    && typeof expectedCreatedBy === "string"
    && expectedCreatedBy !== ""
    && worktree.metadata?.created_by === expectedCreatedBy;
}

export function bootReconcileProofAccepted(health, worktreeSlug) {
  return health?.status === "healthy"
    && health.managed === true
    && health.runtime_source?.type === "worktree"
    && health.runtime_source?.slug === worktreeSlug
    && health.desired?.enabled === true
    && health.desired?.status === "active"
    && health.desired?.source?.type === "worktree"
    && health.desired?.source?.slug === worktreeSlug;
}

function appendExplicitStopCheck(add, stopped) {
  add("runtime.explicit_stop", explicitStopResponseAccepted(stopped), {
    response: stopped,
  });
}

export function explicitStopResponseAccepted(stopped) {
  return stopped?.action === "stop"
    && stopped.desired?.enabled === false
    && stopped.desired?.status === "disabled"
    && stopped.runtime?.managed === false;
}

export function noResurrectionProofAccepted(health, worktreeSlug, { rawTcpReachable = true } = {}) {
  return health?.managed === false
    && health.status === "stopped"
    && health.owner === "none"
    && health.port_owner == null
    && health.probe?.reachable === false
    && rawTcpReachable === false
    && health.desired?.enabled === false
    && health.desired?.status === "disabled"
    && health.desired?.source?.type === "worktree"
    && health.desired?.source?.slug === worktreeSlug;
}

async function captureModuleProcessEvidence(runtime, options) {
  if (options.profile !== "hosted") return null;
  if (!Number.isInteger(runtime?.pid) || runtime.pid <= 0) {
    return {
      pid: runtime?.pid ?? null,
      error: "healthy managed module runtime did not expose a positive integer child PID",
    };
  }
  try {
    return await processEvidence(runtime.pid);
  } catch (error) {
    return { pid: runtime.pid, error: error.message };
  }
}

export function runtimePortsMatchModuleLease(ports, modulePort) {
  return Number.isInteger(modulePort)
    && modulePort > 0
    && ports.length > 0
    && ports.every((port) => Number.isInteger(port) && port === modulePort);
}

async function appendNamespaceChecks({ add, options, home, runtimeEvidence }) {
  if (options.profile !== "hosted") {
    add("topology.shared_namespaces", true, { evidence: "not-required-in-local-profile" });
    return;
  }
  if (![options.t3Pid, options.codexPid, options.launchpadPid].every((pid) => Number.isInteger(pid) && pid > 0)) {
    add("topology.shared_namespaces", false, {
      error: "hosted profile requires positive --t3-pid, --codex-pid and --launchpad-pid",
    });
    return;
  }
  try {
    const [runner, t3, codex, launchpad] = await Promise.all([
      processEvidence(process.pid),
      processEvidence(options.t3Pid),
      processEvidence(options.codexPid),
      processEvidence(options.launchpadPid),
    ]);
    const moduleProcess = runtimeEvidence?.moduleProcess ?? null;
    const moduleEvidenceValid = runtimeEvidence?.moduleExpected === false
      ? moduleProcess === null
      : validProcessEvidence(moduleProcess);
    const processes = [t3, codex, launchpad, ...(validProcessEvidence(moduleProcess) ? [moduleProcess] : [])];
    add("topology.shared_namespaces", moduleEvidenceValid && processes.every((item) =>
      item.uid === runner.uid
      && item.home === home
      && item.pid_namespace === runner.pid_namespace
      && item.net_namespace === runner.net_namespace
    ), {
      runner,
      t3,
      codex,
      launchpad,
      module_child: moduleProcess ?? (runtimeEvidence?.moduleExpected === false ? "expected-absent" : "missing"),
    });
  } catch (error) {
    add("topology.shared_namespaces", false, { error: error.message });
  }
}

function validProcessEvidence(value) {
  return value
    && Number.isInteger(value.pid)
    && Number.isInteger(value.uid)
    && typeof value.home === "string"
    && typeof value.pid_namespace === "string"
    && typeof value.net_namespace === "string";
}

async function appendNegativeSecurityChecks({ add }) {
  const forbiddenPaths = [
    "/var/run/docker.sock",
    "/run/docker.sock",
    "/run/tailscale/tailscaled.sock",
    "/var/run/tailscale/tailscaled.sock",
    "/run/caddy/admin.sock",
    "/run/secrets/github_app_private_key",
    "/host",
    "/mnt/host",
  ];
  for (const path of forbiddenPaths) add(`security.absent:${path}`, !existsSync(path), { path });
  const secretEnvNames = Object.keys(process.env).filter((name) => /GITHUB.*(?:APP)?.*PRIVATE.*KEY/i.test(name));
  add("security.github_private_key_absent", secretEnvNames.length === 0, { matching_env_names: secretEnvNames });
  if (process.platform === "linux") {
    const status = await readFile("/proc/self/status", "utf8");
    const capabilities = status.match(/^CapEff:\s*([0-9a-f]+)$/mi)?.[1] ?? null;
    add("security.no_effective_capabilities", capabilities === "0000000000000000", { cap_eff: capabilities });
  } else {
    add("security.no_effective_capabilities", true, { evidence: "not-linux-local-profile" });
  }
  const sudo = Bun.which("sudo");
  if (!sudo) {
    add("security.no_passwordless_sudo", true, { sudo: "absent" });
  } else {
    const child = Bun.spawn([sudo, "-n", "true"], { stdout: "ignore", stderr: "ignore" });
    add("security.no_passwordless_sudo", await child.exited !== 0, { sudo: "present-but-not-authorized" });
  }
  add("security.caddy_admin_unreachable", !(await tcpReachable("127.0.0.1", 2019)), { endpoint: "127.0.0.1:2019" });
}

async function processEvidence(pid) {
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
  const environment = await readFile(`/proc/${pid}/environ`, "utf8");
  const home = environment.split("\0").find((item) => item.startsWith("HOME="))?.slice(5) ?? null;
  return {
    pid,
    uid,
    home,
    pid_namespace: await readlink(`/proc/${pid}/ns/pid`),
    net_namespace: await readlink(`/proc/${pid}/ns/net`),
  };
}

async function runtimeRequest(base, appId, action, payload) {
  return fetchJson(new URL(`/api/apps/${encodeURIComponent(appId)}/${action}`, base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${payload.error ?? "request_failed"}: ${payload.message ?? url}`);
  return payload;
}

function navigationMatchesProfile(value, options) {
  if (options.profile === "hosted") return value === options.expectedOrigin;
  try {
    const url = new URL(value);
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function worktreeSource(slug) {
  return { source: { type: "worktree", slug } };
}

async function tcpReachable(host, port) {
  return new Promise((resolveReachable) => {
    const socket = createConnection({ host, port });
    const finish = (value) => {
      socket.destroy();
      resolveReachable(value);
    };
    socket.setTimeout(300, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export function parseArgs(args) {
  const options = {
    profile: "local",
    phase: "live",
    launchpadUrl: "http://127.0.0.1:4174",
    t3Command: "t3",
    skipDoctor: false,
    stopAfter: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help") options.help = true;
    else if (arg === "--skip-doctor") options.skipDoctor = true;
    else if (arg === "--stop-after") options.stopAfter = true;
    else if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2);
      const value = inline ?? args[++index];
      const key = {
        profile: "profile",
        phase: "phase",
        root: "root",
        organization: "organization",
        "app-id": "appId",
        "worktree-slug": "worktreeSlug",
        "launchpad-url": "launchpadUrl",
        "expected-origin": "expectedOrigin",
        "expected-worktree-created-by": "expectedWorktreeCreatedBy",
        "t3-command": "t3Command",
        "t3-pid": "t3Pid",
        "codex-pid": "codexPid",
        "launchpad-pid": "launchpadPid",
      }[name];
      if (!key || value === undefined) throw new Error(`Unknown or incomplete option: ${arg}`);
      options[key] = ["t3Pid", "codexPid", "launchpadPid"].includes(key) ? Number(value) : value;
    } else throw new Error(`Unknown positional argument: ${arg}`);
  }
  if (options.help) return options;
  for (const key of ["organization", "appId", "worktreeSlug", "expectedWorktreeCreatedBy"]) {
    if (!options[key]) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  if (!["local", "hosted"].includes(options.profile)) throw new Error("--profile must be local or hosted");
  if (!["live", "post-restart", "expect-disabled"].includes(options.phase)) {
    throw new Error("--phase must be live, post-restart or expect-disabled");
  }
  if (options.phase === "expect-disabled" && options.stopAfter) {
    throw new Error("--stop-after is not valid with --phase expect-disabled");
  }
  if (options.profile === "hosted" && !options.expectedOrigin) throw new Error("--expected-origin is required for hosted profile");
  if (options.profile === "hosted") {
    for (const key of ["t3Pid", "codexPid", "launchpadPid"]) {
      if (!Number.isInteger(options[key]) || options[key] <= 0) {
        throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required for hosted profile`);
      }
    }
  }
  return options;
}

function helpText() {
  return `Usage: bun run parity:workspace -- --profile local|hosted --phase live|post-restart|expect-disabled \\
  --organization <filesystem-dir> --app-id <id> --worktree-slug <slug> \\
  --expected-worktree-created-by <t3-creation-identity> [options]

Hosted additionally requires --expected-origin, --t3-pid, --codex-pid and --launchpad-pid.
Run live, restart the work container (and separately reboot the host), then run
post-restart with the same arguments. After continuity evidence, run post-restart
with --stop-after, restart the container and finish with expect-disabled. The
report lists infra-owned external assertions that the Iotor lane must prove
outside the work container.`;
}
