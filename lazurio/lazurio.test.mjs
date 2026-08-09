import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildLaunchpadDoctorReport } from "../launchpad/src/diagnostics-lib.mjs";
import { buildAggregateReport } from "../launchpad/src/doctor-surface-lib.mjs";
import { platformTestTimeout } from "../launchpad/src/test-platform-setup.mjs";
import {
  buildLazurioContext,
  buildLazurioDoctorReport,
  detectLazurioRoot,
  validateLazurioContext,
} from "./lib.mjs";

const tempRoots = [];
const cliPath = join(import.meta.dirname, "cli.mjs");

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("rootless context je deterministický allowlist bez Residentova obsahu", async () => {
  const root = await tempRoot("lazurio-personalspace-");
  await writeJson(join(root, "personal.gen3.json"), personalConfig("owner-login", {
    owner: {
      display_name: "Owner Name",
      private_note: "CANARY_OWNER_PRIVATE",
    },
    soul: "CANARY_SOUL",
    gbrain: { content: "CANARY_GBRAIN" },
    secrets: { token: "CANARY_SECRET" },
    mandates: ["CANARY_MANDATE"],
    chat: "CANARY_CHAT",
    sessions: ["CANARY_SESSION"],
  }));

  const options = { root };
  const first = await buildLazurioContext(options);
  const second = await buildLazurioContext(options);
  const serialized = JSON.stringify(first, null, 2);

  expect(serialized).toBe(JSON.stringify(second, null, 2));
  expect(first).toEqual({
    schema_version: "lazurio.context.v0",
    unstable: true,
    root: { kind: "personalspace" },
    principal: {
      status: "present",
      reason: "personalspace_manifest_owner",
      github_username: "owner-login",
      display_name: "Owner Name",
      type: "human",
    },
    machine: {
      status: "present",
      reason: "runtime_observed",
      platform: process.platform,
      architecture: process.arch,
    },
    personalspace: {
      mount: { status: "present", reason: "personalspace_is_root", path: "." },
      manifest: { status: "present", reason: "personalspace_root_manifest", path: "personal.gen3.json" },
      readiness: { status: "not_evaluated", reason: "doctor_not_run" },
      access: { status: "not_evaluated", reason: "provider_authority_not_checked" },
    },
    organizations: [],
    organizations_state: { status: "absent", reason: "rootless_mode" },
    provenance: {
      context_sources: ["personal.gen3.json"],
      machine_sources: ["process.platform", "process.arch"],
    },
  });
  for (const canary of [
    "CANARY_OWNER_PRIVATE",
    "CANARY_SOUL",
    "CANARY_GBRAIN",
    "CANARY_SECRET",
    "CANARY_MANDATE",
    "CANARY_CHAT",
    "CANARY_SESSION",
  ]) {
    expect(serialized).not.toContain(canary);
  }
  expect(serialized).not.toContain(root);
  expect(await validateLazurioContext(first)).toEqual([]);
});

test("schema-nevalidní rootless manifest není autoritativní context source", async () => {
  const root = await tempRoot("lazurio-invalid-rootless-manifest-");
  await writeJson(join(root, "personal.gen3.json"), personalConfig("owner-login", {
    gbrain: { repository: { github_repo: 42 } },
  }));

  const context = await buildLazurioContext({ root });

  expect(context.principal).toEqual({
    status: "not_evaluated",
    reason: "personalspace_manifest_invalid",
  });
  expect(context.personalspace.mount.status).toBe("present");
  expect(context.personalspace.manifest).toEqual({
    status: "not_evaluated",
    reason: "personalspace_manifest_invalid",
    path: "personal.gen3.json",
  });
  expect(context.provenance.context_sources).toEqual([]);
});

test("legacy custody výjimka zůstává čitelná stejně jako v Personalspace lane", async () => {
  const root = await tempRoot("lazurio-legacy-rootless-manifest-");
  await writeJson(join(root, "personal.gen3.json"), legacyPersonalConfig("owner-login", {
    buddy: { slug: "owner-buddy", gbrain_path: "gbrain" },
  }));

  const context = await buildLazurioContext({ root });

  expect(context.principal).toMatchObject({
    status: "present",
    reason: "personalspace_manifest_owner",
    github_username: "owner-login",
  });
  expect(context.personalspace.manifest.status).toBe("present");
  expect(context.provenance.context_sources).toEqual(["personal.gen3.json"]);
});

test("chybějící mount je absent, ale provider access zůstává not_evaluated", async () => {
  const root = await tempRoot("lazurio-launchpad-missing-personalspace-");
  await writeJson(join(root, "launchpad.gen3.json"), {
    personalspace_mountpoint: "personalspace",
  });
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    personalspace_owner: "owner-login",
  });

  const context = await buildLazurioContext({ root });

  expect(context.personalspace.mount).toEqual({
    status: "absent",
    reason: "configured_mount_absent",
    path: "personalspace/owner-login_GEN3",
  });
  expect(context.personalspace.access).toEqual({
    status: "not_evaluated",
    reason: "provider_authority_not_checked",
  });
  expect(JSON.stringify(context)).not.toContain("missing_access");
  expect(context.organizations).toEqual([]);
  expect(context.organizations_state).toEqual({
    status: "not_evaluated",
    reason: "organization_context_deferred_cac_0093",
  });
});

test("přítomný mount se hledá case-insensitive a manifest potvrzuje ownera", async () => {
  const root = await tempRoot("lazurio-launchpad-present-personalspace-");
  await writeJson(join(root, "launchpad.gen3.json"), {
    personalspace_mountpoint: "personalspace",
  });
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    personalspace_owner: "owner-login",
  });
  const mount = join(root, "personalspace", "Owner-Login_GEN3");
  await mkdir(mount, { recursive: true });
  await writeJson(
    join(mount, "personal.gen3.json"),
    personalConfig("Owner-Login", { owner: { display_name: "Owner Name" } }),
  );

  const context = await buildLazurioContext({ root });

  expect(context.principal).toEqual({
    status: "present",
    reason: "personalspace_manifest_owner",
    github_username: "Owner-Login",
    display_name: "Owner Name",
    type: "human",
  });
  expect(context.personalspace.mount).toEqual({
    status: "present",
    reason: "configured_mount_present",
    path: "personalspace/Owner-Login_GEN3",
  });
  expect(context.provenance.context_sources).toEqual([
    "launchpad.gen3.json",
    "launchpad.gen3.local.json",
    "personalspace/Owner-Login_GEN3/personal.gen3.json",
  ]);
});

test("case-insensitive lookup najde mount, ale casing identity drift zůstane nevalidní", async () => {
  const root = await tempRoot("lazurio-mounted-casing-drift-");
  await writeJson(join(root, "launchpad.gen3.json"), {
    personalspace_mountpoint: "personalspace",
  });
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    personalspace_owner: "owner-login",
  });
  const mount = join(root, "personalspace", "Owner-Login_GEN3");
  await mkdir(mount, { recursive: true });
  await writeJson(join(mount, "personal.gen3.json"), personalConfig("owner-login"));

  const context = await buildLazurioContext({ root });

  expect(context.principal).toEqual({
    status: "not_evaluated",
    reason: "personalspace_manifest_invalid",
  });
  expect(context.personalspace.mount.path).toBe("personalspace/Owner-Login_GEN3");
  expect(context.provenance.context_sources).not.toContain(
    "personalspace/Owner-Login_GEN3/personal.gen3.json",
  );
});

test("schema-nevalidní namountovaný manifest nepotvrdí Principála ani provenienci", async () => {
  const root = await tempRoot("lazurio-invalid-mounted-manifest-");
  await writeJson(join(root, "launchpad.gen3.json"), {
    personalspace_mountpoint: "personalspace",
  });
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    personalspace_owner: "owner-login",
  });
  const mount = join(root, "personalspace", "owner-login_GEN3");
  await mkdir(mount, { recursive: true });
  await writeJson(join(mount, "personal.gen3.json"), personalConfig("bob", {
    secrets: { custody_pattern: "wrong" },
  }));

  const context = await buildLazurioContext({ root });

  expect(context.principal).toEqual({
    status: "not_evaluated",
    reason: "personalspace_manifest_invalid",
  });
  expect(context.personalspace.mount).toEqual({
    status: "present",
    reason: "configured_mount_present",
    path: "personalspace/owner-login_GEN3",
  });
  expect(context.personalspace.manifest.reason).toBe("personalspace_manifest_invalid");
  expect(context.provenance.context_sources).toEqual([
    "launchpad.gen3.json",
    "launchpad.gen3.local.json",
  ]);
});

test("manifest s jiným ownerem nevydá cizí Personalspace za present", async () => {
  const root = await tempRoot("lazurio-launchpad-owner-mismatch-");
  await writeJson(join(root, "launchpad.gen3.json"), {
    personalspace_mountpoint: "personalspace",
  });
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    personalspace_owner: "alice",
  });
  const mount = join(root, "personalspace", "alice_GEN3");
  await mkdir(mount, { recursive: true });
  await writeJson(join(mount, "personal.gen3.json"), personalConfig("bob"));

  const context = await buildLazurioContext({ root });

  expect(context.principal).toEqual({
    status: "not_evaluated",
    reason: "personalspace_owner_mismatch",
  });
  expect(context.personalspace.mount.status).toBe("not_evaluated");
  expect(context.personalspace.manifest.status).toBe("not_evaluated");
  expect(context.principal.github_username).toBeUndefined();
  expect(JSON.stringify(context)).not.toContain("bob");
});

test("root detection odmítá neznámý i nejednoznačný root", async () => {
  const unknown = await tempRoot("lazurio-unknown-");
  expect(() => detectLazurioRoot(unknown)).toThrow("Root nelze rozpoznat");

  const ambiguous = await tempRoot("lazurio-ambiguous-");
  await writeJson(join(ambiguous, "launchpad.gen3.json"), {});
  await writeJson(join(ambiguous, "personal.gen3.json"), {});
  expect(() => detectLazurioRoot(ambiguous)).toThrow("Root je nejednoznačný");
});

test("symlink není kanonický mount a neumožní rozporně načíst manifest", async () => {
  const root = await tempRoot("lazurio-launchpad-symlink-personalspace-");
  const target = await tempRoot("lazurio-personalspace-symlink-target-");
  await writeJson(join(root, "launchpad.gen3.json"), {
    personalspace_mountpoint: "personalspace",
  });
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    personalspace_owner: "owner-login",
  });
  await writeJson(join(target, "personal.gen3.json"), {
    owner: { github_username: "owner-login" },
  });
  await mkdir(join(root, "personalspace"), { recursive: true });
  await symlink(
    target,
    join(root, "personalspace", "owner-login_GEN3"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const context = await buildLazurioContext({ root });

  expect(context.personalspace.mount).toEqual({
    status: "not_evaluated",
    reason: "personalspace_mount_non_canonical",
    path: "personalspace/owner-login_GEN3",
  });
  expect(context.personalspace.manifest.status).toBe("not_evaluated");
  expect(context.provenance.context_sources).not.toContain(
    "personalspace/owner-login_GEN3/personal.gen3.json",
  );
});

test("symlinkovaný mountpoint mimo root se nikdy neprochází", async () => {
  const root = await tempRoot("lazurio-symlinked-personalspace-mountpoint-");
  const outside = await tempRoot("lazurio-personalspace-mountpoint-target-");
  await writeJson(join(root, "launchpad.gen3.json"), {
    personalspace_mountpoint: "personalspace",
  });
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    personalspace_owner: "owner-login",
  });
  const outsideMount = join(outside, "owner-login_GEN3");
  await mkdir(outsideMount, { recursive: true });
  await writeJson(join(outsideMount, "personal.gen3.json"), {
    owner: { github_username: "owner-login", display_name: "PRIVATE_PARENT_LINK_CANARY" },
  });
  await symlink(
    outside,
    join(root, "personalspace"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const context = await buildLazurioContext({ root });

  expect(context.personalspace.mount.status).toBe("not_evaluated");
  expect(context.personalspace.mount.reason).toBe("personalspace_mount_non_canonical");
  expect(JSON.stringify(context)).not.toContain("PRIVATE_PARENT_LINK_CANARY");
});

test.skipIf(process.platform === "win32")(
  "nečitelný mountpoint degraduje jen Personalspace větev",
  async () => {
    const root = await tempRoot("lazurio-unreadable-personalspace-mountpoint-");
    await writeJson(join(root, "launchpad.gen3.json"), {
      personalspace_mountpoint: "personalspace",
    });
    await writeJson(join(root, "launchpad.gen3.local.json"), {
      personalspace_owner: "owner-login",
    });
    const mountRoot = join(root, "personalspace");
    const mount = join(mountRoot, "owner-login_GEN3");
    await mkdir(mount, { recursive: true });
    await writeJson(join(mount, "personal.gen3.json"), {
      owner: { github_username: "owner-login" },
    });
    await chmod(mountRoot, 0o000);

    let context;
    try {
      context = await buildLazurioContext({ root });
    } finally {
      await chmod(mountRoot, 0o700);
    }

    expect(context.root).toEqual({ kind: "launchpad_root" });
    expect(context.machine.status).toBe("present");
    expect(context.personalspace.mount.status).toBe("not_evaluated");
    expect(context.personalspace.mount.reason).toBe("personalspace_mountpoint_unreadable");
  },
);

test("nevalidní local override není vydaný za použitý context source", async () => {
  const root = await tempRoot("lazurio-invalid-local-provenance-");
  await writeJson(join(root, "launchpad.gen3.json"), {});
  await writeFile(join(root, "launchpad.gen3.local.json"), "{broken", "utf8");

  const context = await buildLazurioContext({ root });

  expect(context.principal.reason).toBe("local_override_invalid");
  expect(context.provenance.context_sources).toEqual(["launchpad.gen3.json"]);
});

test("nastavený nevalidní owner se neplete s chybějící konfigurací", async () => {
  const root = await tempRoot("lazurio-invalid-personalspace-owner-");
  await writeJson(join(root, "launchpad.gen3.json"), {});
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    personalspace_owner: "Owner Login!",
  });

  const context = await buildLazurioContext({ root });

  expect(context.principal).toEqual({
    status: "not_evaluated",
    reason: "personalspace_owner_invalid",
  });
});

test("nečitelný Personalspace manifest degraduje jen jeho metadata", async () => {
  const root = await tempRoot("lazurio-unreadable-personalspace-manifest-");
  await writeJson(join(root, "launchpad.gen3.json"), {
    personalspace_mountpoint: "personalspace",
  });
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    personalspace_owner: "owner-login",
  });
  const mount = join(root, "personalspace", "owner-login_GEN3");
  await mkdir(mount, { recursive: true });
  await writeFile(
    join(mount, "personal.gen3.json"),
    '{"owner":"PRIVATE_BROKEN_CANARY"',
    "utf8",
  );

  const context = await buildLazurioContext({ root });

  expect(context.root).toEqual({ kind: "launchpad_root" });
  expect(context.machine.status).toBe("present");
  expect(context.principal).toEqual({
    status: "not_evaluated",
    reason: "personalspace_manifest_unreadable",
  });
  expect(context.personalspace.mount).toEqual({
    status: "present",
    reason: "configured_mount_present",
    path: "personalspace/owner-login_GEN3",
  });
  expect(context.personalspace.manifest).toEqual({
    status: "not_evaluated",
    reason: "personalspace_manifest_unreadable",
    path: "personalspace/owner-login_GEN3/personal.gen3.json",
  });
  expect(context.provenance.context_sources).toEqual([
    "launchpad.gen3.json",
    "launchpad.gen3.local.json",
  ]);
  expect(JSON.stringify(context)).not.toContain("PRIVATE_BROKEN_CANARY");
});

test("Personalspace manifest s JSON null je nevalidní metadata, ne pád CLI", async () => {
  const root = await tempRoot("lazurio-null-personalspace-manifest-");
  await writeJson(join(root, "launchpad.gen3.json"), {
    personalspace_mountpoint: "personalspace",
  });
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    personalspace_owner: "owner-login",
  });
  const mount = join(root, "personalspace", "owner-login_GEN3");
  await mkdir(mount, { recursive: true });
  await writeFile(join(mount, "personal.gen3.json"), "null\n", "utf8");

  const context = await buildLazurioContext({ root });

  expect(context.personalspace.mount.status).toBe("present");
  expect(context.personalspace.manifest.status).toBe("not_evaluated");
  expect(context.personalspace.manifest.reason).toBe("personalspace_manifest_unreadable");
});

test("mountpoint traversal degraduje bez čtení mimo Lazurio root", async () => {
  const root = await tempRoot("lazurio-mountpoint-traversal-");
  await writeJson(join(root, "launchpad.gen3.json"), {
    personalspace_mountpoint: "../PRIVATE_TRAVERSAL_CANARY",
  });
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    personalspace_owner: "owner-login",
  });

  const context = await buildLazurioContext({ root });

  expect(context.personalspace.mount).toEqual({
    status: "not_evaluated",
    reason: "personalspace_mountpoint_invalid",
  });
  expect(JSON.stringify(context)).not.toContain("PRIVATE_TRAVERSAL_CANARY");
});

test("mountpoint mimo portable schema abecedu degraduje před sestavením path", async () => {
  const root = await tempRoot("lazurio-mountpoint-nonportable-");
  await writeJson(join(root, "launchpad.gen3.json"), {
    personalspace_mountpoint: "osobní prostor",
  });
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    personalspace_owner: "owner-login",
  });

  const context = await buildLazurioContext({ root });

  expect(context.personalspace.mount).toEqual({
    status: "not_evaluated",
    reason: "personalspace_mountpoint_invalid",
  });
  expect(await validateLazurioContext(context)).toEqual([]);
});

test.skipIf(process.platform === "win32")(
  "symlinkovaný Personalspace manifest se nečte ani nevydá za lokální provenienci",
  async () => {
  const root = await tempRoot("lazurio-symlinked-personalspace-manifest-");
  await writeJson(join(root, "launchpad.gen3.json"), {
    personalspace_mountpoint: "personalspace",
  });
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    personalspace_owner: "owner-login",
  });
  const mount = join(root, "personalspace", "owner-login_GEN3");
  await mkdir(mount, { recursive: true });
  const outsideManifest = join(root, "outside-personal.json");
  await writeJson(outsideManifest, {
    owner: { github_username: "owner-login", display_name: "PRIVATE_LINK_CANARY" },
  });
  await symlink(outsideManifest, join(mount, "personal.gen3.json"));

  const context = await buildLazurioContext({ root });

  expect(context.personalspace.mount.status).toBe("present");
  expect(context.personalspace.manifest).toEqual({
    status: "not_evaluated",
    reason: "personalspace_manifest_unreadable",
    path: "personalspace/owner-login_GEN3/personal.gen3.json",
  });
  expect(context.provenance.context_sources).not.toContain(
    "personalspace/owner-login_GEN3/personal.gen3.json",
  );
  expect(JSON.stringify(context)).not.toContain("PRIVATE_LINK_CANARY");
  },
);

test.skipIf(process.platform === "win32")(
  "rootless režim nečte symlinkovaný manifest ani jeho Doctor deklaraci",
  async () => {
    const root = await tempRoot("lazurio-rootless-symlinked-manifest-");
    const targetRoot = await tempRoot("lazurio-rootless-manifest-target-");
    const executed = join(root, "doctor-must-not-run");
    await writeJson(join(targetRoot, "personal.gen3.json"), {
      owner: { github_username: "foreign-owner", display_name: "PRIVATE_ROOT_LINK_CANARY" },
      doctor: {
        schema_version: "humanandmachines.doctor.declaration.v1",
        command: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(executed)}, '')`],
        scope_type: "personalspace",
      },
    });
    await symlink(join(targetRoot, "personal.gen3.json"), join(root, "personal.gen3.json"));

    const context = await buildLazurioContext({ root });
    const doctor = run([process.execPath, cliPath, "doctor", "--json", "--root", root], root);

    expect(context.root).toEqual({ kind: "personalspace" });
    expect(context.principal.status).toBe("not_evaluated");
    expect(context.personalspace.manifest.reason).toBe("personalspace_manifest_unreadable");
    expect(JSON.stringify(context)).not.toContain("PRIVATE_ROOT_LINK_CANARY");
    expect(doctor.exitCode).toBe(3);
    expect(doctor.stderr).toContain("není kanonický čitelný soubor");
    expect(existsSync(executed)).toBe(false);
  },
);

test.skipIf(process.platform === "win32")(
  "nepřístupný Personalspace manifest není mylně absent",
  async () => {
    const root = await tempRoot("lazurio-inaccessible-personalspace-manifest-");
    await writeJson(join(root, "launchpad.gen3.json"), {
      personalspace_mountpoint: "personalspace",
    });
    await writeJson(join(root, "launchpad.gen3.local.json"), {
      personalspace_owner: "owner-login",
    });
    const mount = join(root, "personalspace", "owner-login_GEN3");
    await mkdir(mount, { recursive: true });
    await writeJson(join(mount, "personal.gen3.json"), {
      owner: { github_username: "owner-login" },
    });
    await chmod(mount, 0o000);

    let context;
    try {
      context = await buildLazurioContext({ root });
    } finally {
      await chmod(mount, 0o700);
    }

    expect(context.personalspace.mount.status).toBe("present");
    expect(context.personalspace.manifest.status).toBe("not_evaluated");
    expect(context.personalspace.manifest.reason).toBe("personalspace_manifest_unreadable");
  },
);

test("schema odmítne access verdikt mimo stavový slovník v0", async () => {
  const root = await tempRoot("lazurio-context-schema-");
  await writeJson(join(root, "personal.gen3.json"), personalConfig("owner-login"));
  const context = await buildLazurioContext({ root });
  context.personalspace.access.status = "missing_access";

  expect((await validateLazurioContext(context)).join("\n")).toContain("missing_access");
});

test("rootless doctor spouští deklarovaný Personalspace doctor a propustí report", async () => {
  const root = await tempRoot("lazurio-rootless-doctor-");
  const report = buildAggregateReport({
    scope: {
      type: "personalspace",
      path: ".",
      name: "Fixture Personalspace",
      absolute_path: root,
    },
    checks: [{
      id: "fixture.ready",
      status: "warn",
      severity: "recommended",
      title: "Fixture",
      message: "Fixture warning",
      paths: [],
      links: [],
      details: [],
    }],
    generatedAt: "2026-08-09T00:00:00.000Z",
  });
  await writeFile(
    join(root, "fixture-doctor.mjs"),
    `process.stdout.write(${JSON.stringify(JSON.stringify(report))});\nprocess.exitCode = 0;\n`,
    "utf8",
  );
  await writeJson(join(root, "personal.gen3.json"), personalConfig("owner-login", {
    doctor: {
      schema_version: "humanandmachines.doctor.declaration.v1",
      command: [process.execPath, "fixture-doctor.mjs"],
      scope_type: "personalspace",
      timeout_ms: 5_000,
    },
  }));

  const result = await buildLazurioDoctorReport({ root });

  expect(result.root_kind).toBe("personalspace");
  expect(result.exit_code).toBe(0);
  expect(result.report).toEqual(report);

  const cli = run([process.execPath, cliPath, "doctor", "--json", "--root", root], root);
  expect(cli.exitCode).toBe(0);
  expect(JSON.parse(cli.stdout)).toEqual(report);
}, platformTestTimeout(5_000));

test("doctor bez deklarace vrací no_report exit 3, ne incomplete exit 2", async () => {
  const root = await tempRoot("lazurio-rootless-doctor-missing-");
  await writeJson(join(root, "personal.gen3.json"), personalConfig("owner-login"));

  const cli = run([process.execPath, cliPath, "doctor", "--json", "--root", root], root);

  expect(cli.exitCode).toBe(3);
  expect(cli.stdout).toBe("");
  expect(cli.stderr).toContain("nedeklaruje doctor");
}, platformTestTimeout(5_000));

test("schema-nevalidní manifest nespustí deklarovaný rootless Doctor", async () => {
  const root = await tempRoot("lazurio-rootless-invalid-doctor-");
  const executed = join(root, "doctor-must-not-run");
  await writeJson(join(root, "personal.gen3.json"), personalConfig("owner-login", {
    doctor: {
      command: [
        process.execPath,
        "-e",
        `require('fs').writeFileSync(${JSON.stringify(executed)}, '')`,
      ],
      scope_type: "personalspace",
    },
  }));

  const cli = run([process.execPath, cliPath, "doctor", "--json", "--root", root], root);

  expect(cli.exitCode).toBe(3);
  expect(cli.stdout).toBe("");
  expect(cli.stderr).toContain("Personalspace manifest není validní");
  expect(existsSync(executed)).toBe(false);
}, platformTestTimeout(5_000));

test("doctor s validním reportem a chybným exit kódem vrací incomplete 2", async () => {
  const root = await tempRoot("lazurio-rootless-doctor-exit-mismatch-");
  const report = buildAggregateReport({
    scope: {
      type: "personalspace",
      path: ".",
      name: "Fixture Personalspace",
      absolute_path: root,
    },
    checks: [{
      id: "fixture.ready",
      status: "ok",
      severity: "required",
      title: "Fixture",
      message: "Fixture ready",
      paths: [],
      links: [],
      details: [],
    }],
    generatedAt: "2026-08-09T00:00:00.000Z",
  });
  await writeFile(
    join(root, "fixture-doctor.mjs"),
    `process.stdout.write(${JSON.stringify(JSON.stringify(report))});\nprocess.exitCode = 1;\n`,
    "utf8",
  );
  await writeJson(join(root, "personal.gen3.json"), personalConfig("owner-login", {
    doctor: {
      schema_version: "humanandmachines.doctor.declaration.v1",
      command: [process.execPath, "fixture-doctor.mjs"],
      scope_type: "personalspace",
      timeout_ms: 5_000,
    },
  }));

  const cli = run([process.execPath, cliPath, "doctor", "--json", "--root", root], root);

  expect(cli.exitCode).toBe(2);
  expect(cli.stdout).toBe("");
  expect(cli.stderr).toContain("report vyžaduje 0");
}, platformTestTimeout(5_000));

test("Lazurio doctor drží identity a výsledky existujícího root Doctor core", async () => {
  const root = await launchpadFixture();
  const existing = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
  });
  const lazurio = await buildLazurioDoctorReport({ root });

  expect(lazurio.root_kind).toBe("launchpad_root");
  expect(lazurio.report.scope).toEqual(existing.scope);
  expect(lazurio.report.summary).toEqual(existing.summary);
  expect(lazurio.report.checks.map(({ id, status }) => ({ id, status }))).toEqual(
    existing.checks.map(({ id, status }) => ({ id, status })),
  );
}, platformTestTimeout(15_000));

test("CLI context --json funguje z čisté Agent session bez privátního obsahu", async () => {
  const root = await tempRoot("lazurio-cli-context-");
  await writeJson(join(root, "personal.gen3.json"), personalConfig("owner-login", {
    owner: { display_name: "Owner" },
    gbrain: { content: "CLI_PRIVATE_CANARY" },
  }));

  const result = run([process.execPath, cliPath, "context", "--json", "--root", root], root);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).principal.github_username).toBe("owner-login");
  expect(result.stdout).not.toContain("CLI_PRIVATE_CANARY");
}, platformTestTimeout(5_000));

async function launchpadFixture() {
  const root = await tempRoot("lazurio-doctor-parity-");
  for (const directory of ["launchpad", "guide", "manual", "organizations"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "fixture-root",
      display_name: "Fixture root",
      root_role: "companies-root",
    },
  });
  await writeFile(
    join(root, ".gitignore"),
    "launchpad/runtime/\nlaunchpad/logs/\nlogs/\n",
    "utf8",
  );
  run(["git", "init"], root);
  run(["git", "add", "."], root);
  run([
    "git",
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "fixture",
  ], root);
  return root;
}

async function tempRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function personalConfig(username, overrides = {}) {
  const base = {
    schema_version: "humanandmachines.personal.gen3.v1",
    personal_generation: "gen3",
    owner: {
      github_username: username,
      display_name: `${username} Display`,
      type: "human",
    },
    repository: {
      github_repo: `${username}/${username}_GEN3`,
      mount_path: `personalspace/${username}_GEN3`,
      visibility: "private",
      mount_strategy: "doctor-managed-nested-repo",
    },
    privacy: {
      default_share: "private",
      agent_boundary: "personal-context-only",
      shared_outputs: "metadata-only",
    },
    modules_manifest_path: "modules.manifest.json",
    workspace_path: "workspace",
    gbrain: {
      path: "gbrain",
      repository: {
        github_repo: `${username}/${username}-gbrain`,
        visibility: "private",
        mount_strategy: "doctor-managed-nested-repo",
      },
      software: {
        github_repo: "garrytan/gbrain",
        install_source: "github:garrytan/gbrain",
      },
      default_shared: false,
      human_editor: "obsidian",
      agent_access: "mcp-only",
    },
    secrets: {
      path: "secrets",
      custody_pattern: "personalspace/<owner>_GEN3/secrets/<provider>/<scope>/<purpose>",
      git: "ignored",
    },
    shared_spaces: [],
  };
  return {
    ...base,
    ...overrides,
    owner: { ...base.owner, ...(overrides.owner ?? {}) },
    repository: { ...base.repository, ...(overrides.repository ?? {}) },
    privacy: { ...base.privacy, ...(overrides.privacy ?? {}) },
    gbrain: {
      ...base.gbrain,
      ...(overrides.gbrain ?? {}),
      repository: {
        ...base.gbrain.repository,
        ...(overrides.gbrain?.repository ?? {}),
      },
      software: {
        ...base.gbrain.software,
        ...(overrides.gbrain?.software ?? {}),
      },
    },
    secrets: { ...base.secrets, ...(overrides.secrets ?? {}) },
  };
}

function legacyPersonalConfig(username, overrides = {}) {
  const config = personalConfig(username, overrides);
  delete config.schema_version;
  delete config.repository.mount_strategy;
  delete config.gbrain.repository;
  delete config.gbrain.software;
  return config;
}

function run(command, cwd) {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}
