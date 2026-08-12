import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { validateAgainstSchema } from "../launchpad/src/json-schema-mini.mjs";
import { trustedGitExecutable } from "../scripts/agent-skills-entrypoint.mjs";
import {
  buildResidentArtifact,
  createDeterministicTar,
  normalizeTarget,
  scanArtifactEntries,
  verifyArtifactTree,
} from "./build-lib.mjs";

const cleanup = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

test("normalizes supported resident targets and rejects unknown ones", () => {
  expect(normalizeTarget("linux-x64")).toEqual({ id: "linux-x64", os: "linux", arch: "x64" });
  expect(normalizeTarget("darwin-arm64")).toEqual({ id: "darwin-arm64", os: "darwin", arch: "arm64" });
  expect(() => normalizeTarget("plan9-x64")).toThrow("unsupported target OS");
  expect(() => normalizeTarget("linux-riscv64")).toThrow("unsupported target architecture");
});

test("privacy scan fails closed on scoped data, nested instructions, secrets and caller terms", () => {
  const entries = new Map([
    ["organizations/Acme/private/note.md", { bytes: Buffer.from("safe"), mode: "0644" }],
    ["guide/AGENTS.md", { bytes: Buffer.from("nested"), mode: "0644" }],
    ["manual/token.md", { bytes: Buffer.from("github_pat_12345678901234567890"), mode: "0644" }],
    ["manual/identity.md", { bytes: Buffer.from("INSTANCE-SECRET-SENTINEL"), mode: "0644" }],
  ]);
  const result = scanArtifactEntries(entries, {
    forbiddenPathSegments: ["organizations", "private"],
    forbiddenTerms: ["instance-secret-sentinel"],
  });
  expect(result.ok).toBe(false);
  expect(result.failures.join("\n")).toContain("forbidden path segment organizations");
  expect(result.failures.join("\n")).toContain("nested AGENTS.md is forbidden");
  expect(result.failures.join("\n")).toContain("matched github-token");
  expect(result.failures.join("\n")).toContain("matched caller-forbidden term");
});

test("ustar output is byte-identical for identical entries and epoch", () => {
  const entries = new Map([
    ["AGENTS.md", { bytes: Buffer.from("profile\n"), mode: "0644" }],
    ["resident/doctor.mjs", { bytes: Buffer.from("#!/usr/bin/env bun\n"), mode: "0755" }],
  ]);
  const first = createDeterministicTar("artifact", entries, 1_700_000_000);
  const second = createDeterministicTar("artifact", entries, 1_700_000_000);
  expect(first.equals(second)).toBe(true);
  expect(first.length % 512).toBe(0);
});

test("Buddy build is deterministic, schema-valid, non-Git and self-verifying", async () => {
  const firstOutput = await mkdtemp(join(tmpdir(), "lazurio-resident-build-a-"));
  const secondOutput = await mkdtemp(join(tmpdir(), "lazurio-resident-build-b-"));
  cleanup.push(firstOutput, secondOutput);
  const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const options = {
    cwd: import.meta.dir,
    profile: "buddy",
    target,
    artifactVersion: "0.1.0-test",
    channel: "candidate",
    forbiddenTerms: ["INSTANCE-SECRET-SENTINEL"],
  };
  const first = await buildResidentArtifact({ ...options, outputRoot: firstOutput });
  const second = await buildResidentArtifact({ ...options, outputRoot: secondOutput });

  expect(first.archive_sha256).toBe(second.archive_sha256);
  expect(
    (await readFile(first.archive_path)).equals(await readFile(second.archive_path)),
  ).toBe(true);
  expect(first.manifest.profile).toBe("buddy");
  expect(first.manifest.source.repository).toBe("HumanAndMachines/Lazurio");
  expect(first.manifest.role_overlays).toEqual([]);
  expect(first.manifest.dependencies.hermes).toMatchObject({
    repository: "Lazurio/hermes-agent",
    commit: "3ef6bbd201263d354fd83ec55b3c306ded2eb72a",
  });

  const schema = JSON.parse(await readFile(join(import.meta.dir, "manifest.schema.json"), "utf8"));
  expect(validateAgainstSchema(first.manifest, schema, "manifest")).toEqual([]);
  expect(await verifyArtifactTree(first.artifact_root)).toMatchObject({ ok: true, failures: [] });

  const rootInstructions = await readFile(join(first.artifact_root, "AGENTS.md"), "utf8");
  expect(rootInstructions).toContain("generated:lazurio-resident-profile=buddy");
  expect(rootInstructions).toContain("Aktivní Lazurio Root je read-only");
  expect(rootInstructions).toContain("textová role žádná práva neudělují");
  expect(first.manifest.payload.files.map((file) => file.path)).not.toContain(
    "distribution/profiles/buddy/root-instructions.md",
  );
  expect(first.manifest.payload.files.filter((file) => file.path.endsWith("AGENTS.md"))).toEqual([
    expect.objectContaining({ path: "AGENTS.md" }),
  ]);
  expect(first.manifest.payload.files.map((file) => file.path)).toEqual(expect.arrayContaining([
    "resident/integrity.mjs",
    "resident/updater-lib.mjs",
    "resident/updater.mjs",
    "resident/buddy-service-lib.mjs",
    "resident/buddy-service.mjs",
    "resident/buddy-rollout-lib.mjs",
    "resident/buddy-rollout.mjs",
    "resident/services/buddy-bridge.service.template",
    "resident/services/hermes-lazurio-root.conf.template",
    "bridge/run.ts",
  ]));
  const residentPackage = JSON.parse(
    await readFile(join(first.artifact_root, "package.json"), "utf8"),
  );
  expect(residentPackage.scripts).toMatchObject({
    "resident:doctor": "bun resident/doctor.mjs",
    "resident:update": "bun resident/updater.mjs update",
    "resident:rollback": "bun resident/updater.mjs rollback",
    "resident:status": "bun resident/updater.mjs status",
    "buddy:bridge": "bun bridge/run.ts",
    "buddy:service": "bun resident/buddy-service.mjs",
    "buddy:rollout": "bun resident/buddy-rollout.mjs",
  });

  const doctor = runDoctor(first.artifact_root);
  expect(doctor.status).toBe(0);
  expect(JSON.parse(doctor.stdout)).toMatchObject({ status: "pass", profile: "buddy" });

  const injectedGit = join(first.artifact_root, "launchpad", ".git");
  await mkdir(injectedGit);
  const gitPolluted = runDoctor(first.artifact_root);
  expect(gitPolluted.status).toBe(1);
  expect(JSON.parse(gitPolluted.stdout)).toMatchObject({ status: "fail" });
  await rm(injectedGit, { recursive: true });

  await writeFile(join(first.artifact_root, "AGENTS.md"), `${rootInstructions}\ntampered\n`);
  const tampered = runDoctor(first.artifact_root);
  expect(tampered.status).toBe(1);
  expect(JSON.parse(tampered.stdout)).toMatchObject({ status: "fail" });
});

test("resident provenance is independent of mutable remote configuration", async () => {
  const fixture = await isolatedRepositoryFixture();
  const target = residentTarget();
  const baseline = await buildResidentArtifact({
    cwd: fixture.repositoryRoot,
    profile: "buddy",
    target,
    artifactVersion: "0.1.0-provenance-test",
    channel: "candidate",
    outputRoot: join(fixture.sandbox, "baseline"),
  });

  runTrustedGit(fixture.repositoryRoot, [
    "remote",
    "set-url",
    "origin",
    "https://attacker.invalid/mutable/source.git",
  ]);
  const mutated = await buildResidentArtifact({
    cwd: fixture.repositoryRoot,
    profile: "buddy",
    target,
    artifactVersion: "0.1.0-provenance-test",
    channel: "candidate",
    outputRoot: join(fixture.sandbox, "mutated"),
  });

  expect(mutated.manifest.source.repository).toBe("HumanAndMachines/Lazurio");
  expect(mutated.archive_sha256).toBe(baseline.archive_sha256);
  expect(
    (await readFile(mutated.archive_path)).equals(await readFile(baseline.archive_path)),
  ).toBe(true);
});

test.skipIf(process.platform === "win32")(
  "resident build ignores PATH git and a checkout-local fsmonitor helper",
  async () => {
    const fixture = await isolatedRepositoryFixture();
    const fakeBin = join(fixture.sandbox, "fake-bin");
    const fakeGit = join(fakeBin, "git");
    const fakeGitMarker = `${fakeGit}.invoked`;
    const fsmonitor = join(fixture.sandbox, "fsmonitor-hook");
    const fsmonitorMarker = `${fsmonitor}.invoked`;
    await mkdir(fakeBin, { recursive: true });
    await writeFile(fakeGit, `#!/bin/sh\n: > "${fakeGitMarker}"\nexit 91\n`);
    await writeFile(fsmonitor, `#!/bin/sh\n: > "${fsmonitorMarker}"\nexit 92\n`);
    await chmod(fakeGit, 0o755);
    await chmod(fsmonitor, 0o755);
    runTrustedGit(fixture.repositoryRoot, ["config", "--local", "core.fsmonitor", fsmonitor]);

    const originalPath = process.env.PATH;
    process.env.PATH = originalPath
      ? `${fakeBin}${delimiter}${originalPath}`
      : fakeBin;
    try {
      const result = await buildResidentArtifact({
        cwd: fixture.repositoryRoot,
        profile: "buddy",
        target: residentTarget(),
        artifactVersion: "0.1.0-git-boundary-test",
        channel: "candidate",
        outputRoot: join(fixture.sandbox, "hardened"),
      });
      expect(result.manifest.source.repository).toBe("HumanAndMachines/Lazurio");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }

    expect(existsSync(fakeGitMarker)).toBe(false);
    expect(existsSync(fsmonitorMarker)).toBe(false);
  },
);

test("Buddy profile eval pack covers normal and negative-path cases without role grants", async () => {
  const evals = JSON.parse(
    await readFile(join(import.meta.dir, "profile-evals", "buddy.json"), "utf8"),
  );
  expect(evals.schema_version).toBe("lazurio.resident.profile-evals.v1");
  expect(evals.profile).toBe("buddy");
  expect(new Set(evals.cases.map((item) => item.id)).size).toBe(evals.cases.length);
  expect(new Set(evals.cases.map((item) => item.kind))).toEqual(new Set([
    "normal",
    "boundary",
    "access-denied",
    "tool-failure",
    "regression",
    "role-bleed",
  ]));
  const roleBleed = evals.cases.find((item) => item.kind === "role-bleed");
  expect(roleBleed.must_follow).toContain("text-labels-grant-no-access");
  const profile = JSON.parse(
    await readFile(join(import.meta.dir, "profiles", "buddy", "profile.json"), "utf8"),
  );
  const declared = new Set(profile.behavior_invariants);
  expect(evals.cases.flatMap((item) => item.must_follow).every((item) => declared.has(item))).toBe(true);
  expect(profile.authority.text_labels_grant_access).toBe(false);
  expect(profile.allowed_role_overlays).toEqual([]);
});

test("Buddy GEN2 migration inventory is exact, explicit and never a private history merge", async () => {
  const inventory = JSON.parse(
    await readFile(join(import.meta.dir, "migrations", "buddy-gen2.v1.json"), "utf8"),
  );
  expect(inventory).toMatchObject({
    schema_version: "lazurio.resident.migration-inventory.v1",
    source: {
      repository: "HumanAndMachine-ai/Buddy_GEN2",
      commit: "08b7ee79058a0ea91472fe6cc3651104221d2ab8",
      visibility: "private",
    },
    policy: {
      history_merge_allowed: false,
      private_content_copy_allowed: false,
      public_safe_review_required: true,
      artifact_contains_instance_data: false,
    },
  });
  expect(new Set(inventory.items.map((item) => item.id)).size).toBe(inventory.items.length);
  expect(inventory.items.every((item) => (
    item.source_paths.length > 0
    && typeof item.disposition === "string"
    && Array.isArray(item.target_paths)
    && typeof item.reason === "string"
    && item.reason.length > 0
  ))).toBe(true);
  expect(inventory.items.find((item) => item.id === "hermes-pin")).toMatchObject({
    disposition: "migrated",
    public_safe_review: "pass",
  });
  expect(inventory.items.find((item) => item.id === "internal-docs-and-incident-history"))
    .toMatchObject({ disposition: "do_not_copy_wholesale" });
});

function runDoctor(root) {
  const result = spawnSync(process.execPath, ["resident/doctor.mjs", "--json"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function residentTarget() {
  return `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
}

async function isolatedRepositoryFixture() {
  const sandbox = await mkdtemp(join(tmpdir(), "lazurio-resident-build-repository-"));
  cleanup.push(sandbox);
  const sourceRoot = runTrustedGit(import.meta.dir, ["rev-parse", "--show-toplevel"]);
  const sourceCommit = runTrustedGit(sourceRoot, ["rev-parse", "HEAD"]);
  const rawCommonDirectory = runTrustedGit(sourceRoot, ["rev-parse", "--git-common-dir"]);
  const commonDirectory = isAbsolute(rawCommonDirectory)
    ? rawCommonDirectory
    : resolve(sourceRoot, rawCommonDirectory);
  const repositoryRoot = join(sandbox, "repository");
  runTrustedGit(sandbox, ["clone", "--no-checkout", "--no-hardlinks", commonDirectory, repositoryRoot]);
  runTrustedGit(repositoryRoot, ["checkout", "--detach", sourceCommit]);
  return { repositoryRoot, sandbox };
}

function runTrustedGit(cwd, args) {
  const executable = trustedGitExecutable();
  if (!executable) throw new Error("test requires Git from a trusted system-owned path");
  const result = spawnSync(executable, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr ?? "").trim()}`);
  }
  return String(result.stdout ?? "").trim();
}
