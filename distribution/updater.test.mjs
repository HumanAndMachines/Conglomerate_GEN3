import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  lstat,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createDeterministicTar } from "./build-lib.mjs";
import { digestInventory, sha256 } from "./runtime/integrity.mjs";
import {
  currentResidentTarget,
  installResidentArtifact,
  parseResidentArchive,
  residentStatus,
  revertResidentActivation,
  rollbackResidentArtifact,
  runResidentDoctor,
} from "./runtime/updater-lib.mjs";

const cleanup = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

test("assisted updater installs, no-ops, upgrades and rolls back without moving mutable data", async () => {
  if (process.platform === "win32") return;
  const fixtureRoot = await temporary("lazurio-updater-fixtures-");
  const installRoot = join(await temporary("lazurio-updater-install-parent-"), "lazurio");
  const first = await buildFixture(fixtureRoot, "0.1.0-candidate.1");
  const second = await buildFixture(fixtureRoot, "0.1.0-candidate.2");

  const installed = await install(first, installRoot);
  expect(installed).toMatchObject({
    status: "installed",
    active: first.artifactId,
    previous: null,
    last_known_good: first.artifactId,
    profile: "buddy",
  });
  expect(await readlink(join(installRoot, "active"))).toBe(`versions/${first.artifactId}`);

  await writeFile(join(installRoot, "state", "organizations", "org-sentinel.txt"), "org stays\n");
  await writeFile(join(installRoot, "state", "personalspace", "personal-sentinel.txt"), "private stays\n");

  const noop = await install(first, installRoot);
  expect(noop.status).toBe("noop");
  expect(noop.active).toBe(first.artifactId);

  const updated = await install(second, installRoot);
  expect(updated).toMatchObject({
    status: "updated",
    active: second.artifactId,
    previous: first.artifactId,
    last_known_good: first.artifactId,
  });
  expect(await readFile(join(installRoot, "active", "organizations", "org-sentinel.txt"), "utf8"))
    .toBe("org stays\n");
  expect(await readFile(join(installRoot, "active", "personalspace", "personal-sentinel.txt"), "utf8"))
    .toBe("private stays\n");

  const status = await residentStatus({ installRoot, expectedProfile: "buddy" });
  expect(status).toMatchObject({
    active: second.artifactId,
    previous: first.artifactId,
    last_known_good: first.artifactId,
    profile: "buddy",
    health: { status: "pass", artifact_id: second.artifactId },
  });
  expect(status.installed).toEqual([first.artifactId, second.artifactId]);

  const activeOrganizations = join(installRoot, "active", "organizations");
  await unlink(activeOrganizations);
  await symlink("../../state/personalspace", activeOrganizations, "dir");
  const redirected = await residentStatus({ installRoot, expectedProfile: "buddy" });
  expect(redirected.health).toMatchObject({ status: "fail" });
  expect(redirected.health.error).toContain("mutable mount link must target");
  await unlink(activeOrganizations);
  await symlink("../../state/organizations", activeOrganizations, "dir");

  const rolledBack = await rollbackResidentArtifact({
    installRoot,
    expectedProfile: "buddy",
  });
  expect(rolledBack).toMatchObject({
    status: "rolled_back",
    active: first.artifactId,
    previous: second.artifactId,
    last_known_good: second.artifactId,
  });
  expect(await readFile(join(installRoot, "active", "organizations", "org-sentinel.txt"), "utf8"))
    .toBe("org stays\n");
});

test("checksum, interrupted archive, incompatibility and health failures leave active unchanged", async () => {
  if (process.platform === "win32") return;
  const fixtureRoot = await temporary("lazurio-updater-failures-");
  const installRoot = join(await temporary("lazurio-updater-failure-install-parent-"), "lazurio");
  const baseline = await buildFixture(fixtureRoot, "0.2.0-candidate.1");
  await install(baseline, installRoot);
  await writeFile(join(installRoot, "state", "personalspace", "sentinel.txt"), "unchanged\n");

  const corrupt = await buildFixture(fixtureRoot, "0.2.0-corrupt");
  const corruptBytes = await readFile(corrupt.archivePath);
  corruptBytes[600] ^= 0xff;
  await writeFile(corrupt.archivePath, corruptBytes);
  await expect(install(corrupt, installRoot)).rejects.toThrow("SHA-256");
  await expectActive(installRoot, baseline.artifactId);

  const interrupted = await buildFixture(fixtureRoot, "0.2.0-interrupted");
  const truncated = (await readFile(interrupted.archivePath)).subarray(0, 1024);
  await writeFile(interrupted.archivePath, truncated);
  await writeChecksum(interrupted.archivePath, interrupted.checksumPath, truncated);
  await expect(install(interrupted, installRoot)).rejects.toThrow("complete 512-byte-aligned USTAR");
  await expectActive(installRoot, baseline.artifactId);

  const incompatible = await buildFixture(
    fixtureRoot,
    "0.2.0-wrong-target",
    currentResidentTarget().startsWith("linux-") ? "darwin-x64" : "linux-x64",
  );
  await expect(install(incompatible, installRoot)).rejects.toThrow("incompatible");
  await expectActive(installRoot, baseline.artifactId);

  const tamperedPayload = await buildFixture(fixtureRoot, "0.2.0-payload-tamper");
  const tamperedBytes = await readFile(tamperedPayload.archivePath);
  const marker = Buffer.from("0.2.0-payload-tamper\n");
  const markerOffset = tamperedBytes.indexOf(marker);
  expect(markerOffset).toBeGreaterThan(0);
  tamperedBytes[markerOffset] = "X".charCodeAt(0);
  await writeFile(tamperedPayload.archivePath, tamperedBytes);
  await writeChecksum(tamperedPayload.archivePath, tamperedPayload.checksumPath, tamperedBytes);
  await expect(install(tamperedPayload, installRoot)).rejects.toThrow("integrity failed");
  await expectActive(installRoot, baseline.artifactId);

  const failedHealth = await buildFixture(fixtureRoot, "0.2.0-health-fail");
  const failAfterSwitch = async (root) => {
    if (basename(root) === failedHealth.artifactId) {
      return { ok: false, stderr: "injected post-switch failure" };
    }
    return runResidentDoctor(root);
  };
  await expect(installResidentArtifact({
    archivePath: failedHealth.archivePath,
    checksumPath: failedHealth.checksumPath,
    installRoot,
    expectedProfile: "buddy",
    expectedChannel: "candidate",
    healthRunner: failAfterSwitch,
  })).rejects.toThrow("active was restored");
  await expectActive(installRoot, baseline.artifactId);
  expect(await readFile(join(installRoot, "state", "personalspace", "sentinel.txt"), "utf8"))
    .toBe("unchanged\n");
});

test("first install can adopt an existing Personalspace without copying or retargeting it", async () => {
  if (process.platform === "win32") return;
  const fixtureRoot = await temporary("lazurio-updater-adopt-fixtures-");
  const installRoot = join(await temporary("lazurio-updater-adopt-parent-"), "lazurio");
  const personalspace = await temporary("lazurio-existing-personalspace-");
  const otherPersonalspace = await temporary("lazurio-other-personalspace-");
  await writeFile(join(personalspace, "existing-private-sentinel.txt"), "stays in place\n");
  const first = await buildFixture(fixtureRoot, "0.3.0-candidate.1");
  const second = await buildFixture(fixtureRoot, "0.3.0-candidate.2");
  const resolvedPersonalspace = await realpath(personalspace);

  const installed = await install(first, installRoot, {
    personalspace,
  });
  expect(installed.mutable_mounts).toEqual([
    { name: "organizations", kind: "managed-directory" },
    { name: "personalspace", kind: "external-symlink", target: resolvedPersonalspace },
  ]);
  expect(await readlink(join(installRoot, "state", "personalspace"))).toBe(resolvedPersonalspace);
  expect((await lstat(join(installRoot, "state"))).mode & 0o777).toBe(0o711);
  expect((await lstat(join(installRoot, "state", "organizations"))).mode & 0o777).toBe(0o755);
  expect(await readFile(
    join(installRoot, "active", "personalspace", "existing-private-sentinel.txt"),
    "utf8",
  )).toBe("stays in place\n");
  expect((await lstat(join(installRoot, "state", "mounts.v1.json"))).mode & 0o777).toBe(0o600);

  const updated = await install(second, installRoot);
  expect(updated.status).toBe("updated");
  expect(await readlink(join(installRoot, "state", "personalspace"))).toBe(resolvedPersonalspace);
  expect(await readFile(join(personalspace, "existing-private-sentinel.txt"), "utf8"))
    .toBe("stays in place\n");

  await expect(install(second, installRoot, {
    personalspace: otherPersonalspace,
  })).rejects.toThrow("does not match");
  await expectActive(installRoot, second.artifactId);

  await unlink(join(installRoot, "state", "personalspace"));
  await symlink(await realpath(otherPersonalspace), join(installRoot, "state", "personalspace"), "dir");
  const status = await residentStatus({ installRoot, expectedProfile: "buddy" });
  expect(status.health).toMatchObject({ status: "fail" });
  expect(status.health.error).toContain("declared target");
});

test("an explicitly declared source can replace only an empty managed mount", async () => {
  if (process.platform === "win32") return;
  const fixtureRoot = await temporary("lazurio-updater-late-adopt-fixtures-");
  const installRoot = join(await temporary("lazurio-updater-late-adopt-parent-"), "lazurio");
  const personalspace = await temporary("lazurio-late-personalspace-");
  const fixture = await buildFixture(fixtureRoot, "0.3.1-candidate.1");
  await writeFile(join(personalspace, "external-sentinel.txt"), "external stays\n");
  await install(fixture, installRoot);

  const adopted = await install(fixture, installRoot, { personalspace });
  expect(adopted.status).toBe("noop");
  expect(await readFile(
    join(installRoot, "active", "personalspace", "external-sentinel.txt"),
    "utf8",
  )).toBe("external stays\n");

  const secondInstallRoot = join(await temporary("lazurio-updater-nonempty-adopt-parent-"), "lazurio");
  await install(fixture, secondInstallRoot);
  await writeFile(join(secondInstallRoot, "state", "personalspace", "local.txt"), "must not hide\n");
  await expect(install(fixture, secondInstallRoot, { personalspace }))
    .rejects.toThrow("not empty");
  expect(await readFile(join(secondInstallRoot, "state", "personalspace", "local.txt"), "utf8"))
    .toBe("must not hide\n");
});

test("Buddy profile refuses an external organizations mount", async () => {
  if (process.platform === "win32") return;
  const fixtureRoot = await temporary("lazurio-updater-org-boundary-fixtures-");
  const installRoot = join(await temporary("lazurio-updater-org-boundary-parent-"), "lazurio");
  const organizations = await temporary("lazurio-external-organizations-");
  const fixture = await buildFixture(fixtureRoot, "0.3.2-candidate.1");
  await expect(install(fixture, installRoot, { organizations }))
    .rejects.toThrow("cannot adopt an organizations mount");
});

test("rollout compensation can revert an initial or updated activation without deleting versions", async () => {
  if (process.platform === "win32") return;
  const fixtureRoot = await temporary("lazurio-updater-compensation-fixtures-");
  const first = await buildFixture(fixtureRoot, "0.3.3-candidate.1");
  const second = await buildFixture(fixtureRoot, "0.3.3-candidate.2");

  const initialRoot = join(await temporary("lazurio-updater-initial-revert-parent-"), "lazurio");
  await install(first, initialRoot);
  const initialRevert = await revertResidentActivation({
    installRoot: initialRoot,
    expectedProfile: "buddy",
    failedArtifactId: first.artifactId,
  });
  expect(initialRevert).toMatchObject({ status: "initial_activation_reverted", active: null });
  expect(await lstat(join(initialRoot, "active")).catch((error) => error.code)).toBe("ENOENT");
  const initialStatus = await residentStatus({ installRoot: initialRoot, expectedProfile: "buddy" });
  expect(initialStatus.active).toBeNull();
  expect(initialStatus.installed).toEqual([first.artifactId]);

  const updateRoot = join(await temporary("lazurio-updater-update-revert-parent-"), "lazurio");
  await install(first, updateRoot);
  await install(second, updateRoot);
  const updateRevert = await revertResidentActivation({
    installRoot: updateRoot,
    expectedProfile: "buddy",
    failedArtifactId: second.artifactId,
  });
  expect(updateRevert).toMatchObject({
    status: "activation_reverted",
    active: first.artifactId,
    previous: second.artifactId,
    last_known_good: first.artifactId,
  });
  await expectActive(updateRoot, first.artifactId);
});

test("archive parser rejects traversal and non-regular TAR entry types", () => {
  const traversal = createDeterministicTar(
    "resident",
    new Map([["../escape", { bytes: Buffer.from("no\n"), mode: "0644" }]]),
    1_700_000_000,
  );
  expect(() => parseResidentArchive(traversal)).toThrow("not canonical");

  const unsafeType = Buffer.from(createDeterministicTar(
    "resident",
    new Map([["payload", { bytes: Buffer.from("no\n"), mode: "0644" }]]),
    1_700_000_000,
  ));
  const payloadHeader = unsafeType.indexOf(Buffer.from("resident/payload"));
  const headerOffset = payloadHeader - (payloadHeader % 512);
  unsafeType[headerOffset + 156] = "2".charCodeAt(0);
  rewriteHeaderChecksum(unsafeType, headerOffset);
  expect(() => parseResidentArchive(unsafeType)).toThrow("unsupported TAR entry type");
});

test("Windows resident lifecycle remains fail-closed until its atomic pointer adapter exists", async () => {
  if (process.platform !== "win32") return;
  await expect(installResidentArtifact({})).rejects.toThrow("POSIX atomic-symlink adapter");
  await expect(rollbackResidentArtifact({})).rejects.toThrow("POSIX atomic-symlink adapter");
});

async function install(fixture, installRoot, mutableMountSources = {}) {
  return installResidentArtifact({
    archivePath: fixture.archivePath,
    checksumPath: fixture.checksumPath,
    installRoot,
    expectedProfile: "buddy",
    expectedChannel: "candidate",
    mutableMountSources,
  });
}

async function buildFixture(root, version, target = currentResidentTarget()) {
  const [os, arch] = target.split("-");
  const artifactId = `lazurio-resident-buddy-${version}-${target}`;
  const [hermesPinBytes, gbrainPinBytes, toolchainPinBytes] = await Promise.all([
    readFile(join(import.meta.dir, "dependencies", "hermes.json")),
    readFile(join(import.meta.dir, "dependencies", "gbrain.json")),
    readFile(join(import.meta.dir, "dependencies", "toolchain.json")),
  ]);
  const hermesPin = JSON.parse(hermesPinBytes.toString("utf8"));
  const gbrainPin = JSON.parse(gbrainPinBytes.toString("utf8"));
  const toolchainPin = JSON.parse(toolchainPinBytes.toString("utf8"));
  const entries = new Map([
    ["AGENTS.md", { bytes: Buffer.from("<!-- generated:lazurio-resident-profile=buddy -->\n# Buddy\n"), mode: "0644" }],
    ["package.json", { bytes: Buffer.from("{\"private\":true,\"type\":\"module\"}\n"), mode: "0644" }],
    ["resident/doctor.mjs", { bytes: await readFile(join(import.meta.dir, "runtime", "doctor.mjs")), mode: "0755" }],
    ["resident/integrity.mjs", { bytes: await readFile(join(import.meta.dir, "runtime", "integrity.mjs")), mode: "0644" }],
    ["resident/profile.json", { bytes: Buffer.from(`${JSON.stringify({ schema_version: "lazurio.resident.profile.v1", id: "buddy" }, null, 2)}\n`), mode: "0644" }],
    ["resident/dependencies/hermes.json", { bytes: hermesPinBytes, mode: "0644" }],
    ["resident/dependencies/gbrain.json", { bytes: gbrainPinBytes, mode: "0644" }],
    ["resident/dependencies/toolchain.json", { bytes: toolchainPinBytes, mode: "0644" }],
    ["resident/services/buddy-bridge.service.template", {
      bytes: Buffer.from("[Service]\nUser=buddy-bridge\nRestartPreventExitStatus=78\n"),
      mode: "0644",
    }],
    ["resident/services/hermes-lazurio-root.conf.template", {
      bytes: Buffer.from("[Service]\nEnvironment=TERMINAL_CWD=/opt/lazurio/active\n"),
      mode: "0644",
    }],
    ["resident/buddy-service-lib.mjs", { bytes: Buffer.from("export {};\n"), mode: "0644" }],
    ["resident/buddy-service.mjs", { bytes: Buffer.from("#!/usr/bin/env bun\n"), mode: "0755" }],
    ["resident/buddy-rollout-lib.mjs", { bytes: Buffer.from("export {};\n"), mode: "0644" }],
    ["resident/buddy-rollout.mjs", { bytes: Buffer.from("#!/usr/bin/env bun\n"), mode: "0755" }],
    ["bridge/run.ts", { bytes: Buffer.from("export const fixtureBridge = true;\n"), mode: "0644" }],
    ["fixture/version.txt", { bytes: Buffer.from(`${version}\n`), mode: "0644" }],
  ]);
  const payload = [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, entry]) => ({
      path,
      mode: entry.mode,
      size: entry.bytes.length,
      sha256: sha256(entry.bytes),
    }));
  const manifest = {
    schema_version: "lazurio.resident.manifest.v1",
    artifact_id: artifactId,
    artifact_version: version,
    channel: "candidate",
    profile: "buddy",
    role_overlays: [],
    target: { os, arch },
    source: {
      repository: "HumanAndMachines/Lazurio",
      commit: "1".repeat(40),
      commit_epoch: 1_700_000_000,
    },
    build_contract: 1,
    compatibility: { resident_root: 1, rollback_from: [1] },
    dependencies: {
      hermes: {
        repository: hermesPin.repository,
        release_tag: hermesPin.release_tag,
        commit: hermesPin.commit,
        lock_sha256: hermesPin.lock_sha256,
      },
      gbrain: {
        repository: gbrainPin.repository,
        release_tag: gbrainPin.release_tag,
        version: gbrainPin.version,
        commit: gbrainPin.commit,
        lock_sha256: gbrainPin.lock_sha256,
        engine: gbrainPin.runtime.engine,
        transport: gbrainPin.runtime.transport,
      },
      toolchain: {
        bun: toolchainPin.tools.bun.version,
        uv: toolchainPin.tools.uv.version,
      },
    },
    mutable_mounts: ["organizations", "personalspace"],
    payload: {
      hash_algorithm: "sha256",
      digest: digestInventory(payload),
      manifest_excluded_from_inventory: true,
      files: payload,
    },
  };
  entries.set("lazurio.resident.json", {
    bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    mode: "0644",
  });
  const archive = createDeterministicTar(artifactId, entries, 1_700_000_000);
  const archivePath = join(root, `${artifactId}.tar`);
  const checksumPath = `${archivePath}.sha256`;
  await writeFile(archivePath, archive);
  await writeChecksum(archivePath, checksumPath, archive);
  return { artifactId, archivePath, checksumPath, manifest };
}

async function writeChecksum(archivePath, checksumPath, bytes) {
  await writeFile(checksumPath, `${sha256(bytes)}  ${basename(archivePath)}\n`);
}

async function expectActive(installRoot, artifactId) {
  expect(await readlink(join(installRoot, "active"))).toBe(`versions/${artifactId}`);
}

async function temporary(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

function rewriteHeaderChecksum(archive, offset) {
  const header = archive.subarray(offset, offset + 512);
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const text = checksum.toString(8).padStart(6, "0");
  Buffer.from(text).copy(header, 148);
  header[154] = 0;
  header[155] = 0x20;
}
