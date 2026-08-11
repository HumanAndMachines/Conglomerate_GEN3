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
    organizations_scope: "none",
    organization_selector: null,
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
    reason: "organization_selector_not_provided",
  });
});

test("Organization selector vrátí deterministickou lokální projekci bez předstírání GitHub access", async () => {
  const root = await organizationContextFixture();

  const first = await buildLazurioContext({
    root,
    organization: "humanandmachine-ai",
  });
  const second = await buildLazurioContext({
    root,
    organization: "HumanAndMachine-ai",
  });

  expect(first).toEqual(second);
  expect(first.organizations_scope).toBe("selected");
  expect(first.organization_selector).toBe("HumanAndMachine-ai");
  expect(first.organizations_state).toEqual({
    status: "present",
    reason: "selected_organization_observed",
  });
  expect(first.organizations).toHaveLength(1);

  const [organization] = first.organizations;
  expect(organization).toMatchObject({
    slug: "HumanAndMachine-ai",
    repository: "HumanAndMachine-ai/HumanAndMachine-ai_GEN3",
    access: {
      status: "not_evaluated",
      reason: "provider_authority_not_checked",
    },
    git: {
      status: "present",
      expected_branch: "trunk",
      origin: {
        status: "present",
        repository: "HumanAndMachine-ai/HumanAndMachine-ai_GEN3",
      },
    },
  });
  expect(organization.teams.map((team) => team.slug)).toEqual(["lazurio", "rozjedeme-ai"]);
  expect(organization.teams.every((team) => team.access.status === "not_evaluated")).toBe(true);

  const modules = new Map(organization.modules.map((module) => [module.slug, module]));
  expect(modules.get("website-lazurio")).toMatchObject({
    path: "organizations/HumanAndMachine-ai_GEN3/workspace/website-lazurio",
    materialization: { status: "present", reason: "checkout_present" },
    access: { status: "not_evaluated", reason: "provider_authority_not_checked" },
    git: {
      status: "present",
      origin: {
        status: "present",
        repository: "HumanAndMachine-ai/website-lazurio",
      },
    },
  });
  expect(modules.get("design-system-lazurio")).toMatchObject({
    materialization: { status: "absent", reason: "checkout_absent" },
    access: { status: "not_evaluated", reason: "provider_authority_not_checked" },
    git: {
      status: "absent",
      reason: "checkout_absent",
    },
  });
  expect(organization.apps).toHaveLength(2);
  const websiteApp = organization.apps.find(
    (app) => app.id === "humanandmachine-ai-lazurio-website",
  );
  const rootApp = organization.apps.find((app) => app.id === "humanandmachine-ai-root-tool");
  expect(websiteApp).toMatchObject({
    id: "humanandmachine-ai-lazurio-website",
    module: "website-lazurio",
    access: { status: "not_evaluated", reason: "provider_authority_not_checked" },
  });
  expect(rootApp).toBeDefined();
  expect(rootApp.module).toBeUndefined();
  expect(organization.entrypoints).toMatchObject({
    agents: { status: "present", path: "organizations/HumanAndMachine-ai_GEN3/AGENTS.md" },
    mission_control: {
      status: "present",
      path: "organizations/HumanAndMachine-ai_GEN3/mission-control",
    },
    knowledgebase: {
      status: "present",
      path: "organizations/HumanAndMachine-ai_GEN3/workspace/knowledgebase",
    },
  });
  expect(organization.provenance.manifest_paths).toEqual([
    "organizations/HumanAndMachine-ai_GEN3/company.gen3.json",
    "organizations/HumanAndMachine-ai_GEN3/modules.manifest.json",
  ]);
  expect(organization.worktrees).toEqual([
    expect.objectContaining({
      slug: "OPS-12-context",
      workspace: "root",
      module: "root",
      branch: "main",
      plan_code: "OPS-12",
      ownership_status: "orphan_missing_file",
    }),
  ]);

  const serialized = JSON.stringify(first);
  expect(serialized).not.toContain(root);
  expect(serialized).not.toContain("missing_access");
  expect(serialized).not.toContain("OtherOrg secret");
  expect(serialized).not.toContain("OTHER_ORGANIZATION_PACKAGE_MUST_NOT_BE_READ");
  expect(serialized).not.toContain("Invalid app manifest");
  expect(serialized).not.toContain("invalid prefix-sibling manifest");
  expect(await validateLazurioContext(first)).toEqual([]);

  const projectedWorktree = structuredClone(first);
  projectedWorktree.organizations[0].worktrees.push({
    slug: "ops-review",
    path: "organizations/HumanAndMachine-ai_GEN3/.worktrees/root/ops-review",
    workspace: "root",
    module: "root",
    plan_code: "OPS-12",
    ownership_status: "resolved",
    status: "needs human review",
  });
  expect(await validateLazurioContext(projectedWorktree)).toEqual([]);

  const invalidNoneScope = structuredClone(first);
  invalidNoneScope.organizations_scope = "none";
  invalidNoneScope.organization_selector = null;
  expect((await validateLazurioContext(invalidNoneScope)).join("\n")).toContain("maximum 0");

  const sha256Context = structuredClone(first);
  sha256Context.organizations[0].git.head = "a".repeat(64);
  expect(await validateLazurioContext(sha256Context)).toEqual([]);
}, platformTestTimeout(15_000));

test("Organization selector fail-closed odmítne neznámý slug a Personalspace root", async () => {
  const root = await organizationContextFixture();
  const personalspaceRoot = await tempRoot("lazurio-context-selector-rootless-");
  await writeJson(
    join(personalspaceRoot, "personal.gen3.json"),
    personalConfig("owner-login"),
  );

  await expect(
    buildLazurioContext({ root, organization: "missing-org" }),
  ).rejects.toThrow("nebyla mezi lokálně objevenými Organizacemi");
  await expect(
    buildLazurioContext({ root, organization: "PlannedOrg" }),
  ).rejects.toThrow("nebyla mezi lokálně objevenými Organizacemi");
  await expect(
    buildLazurioContext({ root: personalspaceRoot, organization: "HumanAndMachine-ai" }),
  ).rejects.toThrow("použít pouze nad Launchpad rootem");
});

test("CLI Organization context má lidský i JSON výstup ze stejné projekce", async () => {
  const root = await organizationContextFixture();
  const human = run([
    process.execPath,
    "run",
    cliPath,
    "context",
    "--organization",
    "humanandmachine-ai",
    "--root",
    root,
  ], root);
  const json = run([
    process.execPath,
    "run",
    cliPath,
    "context",
    "--organization=HumanAndMachine-ai",
    "--json",
    "--root",
    root,
  ], root);
  const missing = run([
    process.execPath,
    "run",
    cliPath,
    "context",
    "--organization",
    "missing-org",
    "--json",
    "--root",
    root,
  ], root);

  expect(human.exitCode).toBe(0);
  expect(human.stderr).toBe("");
  expect(human.stdout).toContain("Organization: Human and Machine (HumanAndMachine-ai)");
  expect(human.stdout).toContain("access not_evaluated (provider_authority_not_checked)");
  expect(human.stdout).toContain("design-system-lazurio");
  expect(human.stdout).not.toContain(root);
  expect(JSON.parse(json.stdout).organizations[0].slug).toBe("HumanAndMachine-ai");
  expect(missing.exitCode).toBe(2);
  expect(missing.stdout).toBe("");
  expect(missing.stderr).toContain("nebyla mezi lokálně objevenými Organizacemi");
}, platformTestTimeout(15_000));

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
    const doctor = run([process.execPath, "run", cliPath, "doctor", "--json", "--root", root], root);

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
      command: [process.execPath, "run", "fixture-doctor.mjs"],
      scope_type: "personalspace",
      timeout_ms: 5_000,
    },
  }));

  const result = await buildLazurioDoctorReport({ root });

  expect(result.root_kind).toBe("personalspace");
  expect(result.exit_code).toBe(0);
  expect(result.report).toEqual(report);

  const cli = run([process.execPath, "run", cliPath, "doctor", "--json", "--root", root], root);
  expect(cli.exitCode).toBe(0);
  expect(JSON.parse(cli.stdout)).toEqual(report);
}, platformTestTimeout(5_000));

test("doctor bez deklarace vrací no_report exit 3, ne incomplete exit 2", async () => {
  const root = await tempRoot("lazurio-rootless-doctor-missing-");
  await writeJson(join(root, "personal.gen3.json"), personalConfig("owner-login"));

  const cli = run([process.execPath, "run", cliPath, "doctor", "--json", "--root", root], root);

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

  const cli = run([process.execPath, "run", cliPath, "doctor", "--json", "--root", root], root);

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
      command: [process.execPath, "run", "fixture-doctor.mjs"],
      scope_type: "personalspace",
      timeout_ms: 5_000,
    },
  }));

  const cli = run([process.execPath, "run", cliPath, "doctor", "--json", "--root", root], root);

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

  const result = run([process.execPath, "run", cliPath, "context", "--json", "--root", root], root);

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

async function organizationContextFixture() {
  const root = await tempRoot("lazurio-organization-context-");
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
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    planned_organizations: [
      {
        slug: "PlannedOrg",
        display_name: "Planned Organization",
        repository: "PlannedOrg/PlannedOrg_GEN3",
      },
    ],
  });
  await createContextOrganization({
    root,
    directory: "HumanAndMachine-ai_GEN3",
    slug: "HumanAndMachine-ai",
    displayName: "Human and Machine",
    repository: "git@github.com:HumanAndMachine-ai/HumanAndMachine-ai_GEN3.git",
    defaultBranch: "trunk",
    moduleSlots: [
      {
        path: "mission-control",
        slug: "mission-control",
        space: "root",
        git: {
          url: "git@github.com:HumanAndMachine-ai/mission-control.git",
          branch: "main",
        },
      },
      {
        path: "workspace/knowledgebase",
        slug: "knowledgebase",
        teams: ["rozjedeme-ai", "lazurio"],
        git: {
          url: "git@github.com:HumanAndMachine-ai/knowledgebase.git",
          branch: "main",
        },
      },
      {
        path: "workspace/website-lazurio",
        slug: "website-lazurio",
        teams: ["lazurio"],
        git: {
          url: "git@github.com:HumanAndMachine-ai/website-lazurio.git",
          branch: "main",
        },
      },
      {
        path: "workspace/design-system-lazurio",
        slug: "design-system-lazurio",
        teams: ["lazurio"],
        git: {
          url: "git@github.com:HumanAndMachine-ai/design-system-lazurio.git",
          branch: "main",
        },
      },
    ],
    teams: [
      { slug: "rozjedeme-ai", display_name: "Rozjedeme.ai", default: true },
      { slug: "lazurio", display_name: "Lazurio", default: false },
    ],
  });
  await createContextOrganization({
    root,
    directory: "OtherOrg_GEN3",
    slug: "OtherOrg",
    displayName: "OtherOrg secret",
    repository: "git@github.com:OtherOrg/OtherOrg_GEN3.git",
    defaultBranch: "main",
    moduleSlots: [],
    teams: [],
  });
  const otherPrivatePackage = join(
    root,
    "organizations",
    "OtherOrg_GEN3",
    "workspace",
    "private-canary",
  );
  await mkdir(otherPrivatePackage, { recursive: true });
  await writeFile(
    join(otherPrivatePackage, "package.json"),
    "{ OTHER_ORGANIZATION_PACKAGE_MUST_NOT_BE_READ",
    "utf8",
  );
  const prefixCollisionRoot = join(
    root,
    "organizations",
    "HumanAndMachine-ai_GEN3-copy",
  );
  await mkdir(join(prefixCollisionRoot, "manual"), { recursive: true });
  await mkdir(join(prefixCollisionRoot, "company", "colleagues"), { recursive: true });
  await writeFile(
    join(prefixCollisionRoot, "company.gen3.json"),
    "{ invalid prefix-sibling manifest",
    "utf8",
  );

  const organizationRoot = join(root, "organizations", "HumanAndMachine-ai_GEN3");
  const websiteRoot = join(organizationRoot, "workspace", "website-lazurio");
  await mkdir(join(websiteRoot, "app"), { recursive: true });
  await writeJson(join(websiteRoot, "app", "package.json"), {
    name: "humanandmachine-ai-lazurio-website",
    private: true,
    type: "module",
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "humanandmachine-ai-lazurio-website",
        title: "Lazurio website",
        company: "HumanAndMachine-ai",
        module: "website-lazurio",
        surface: "internal",
        port: 4310,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
        tags: ["lazurio"],
      },
    },
  });
  const modulelessApp = join(websiteRoot, "moduleless-app");
  await mkdir(modulelessApp, { recursive: true });
  await writeJson(join(modulelessApp, "package.json"), {
    name: "humanandmachine-ai-root-tool",
    private: true,
    type: "module",
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "humanandmachine-ai-root-tool",
        title: "Organization root tool",
        company: "HumanAndMachine-ai",
        surface: "internal",
        port: 4311,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
        tags: [],
      },
    },
  });
  const knowledgebaseRoot = join(organizationRoot, "workspace", "knowledgebase");
  await mkdir(join(knowledgebaseRoot, "invalid-app"), { recursive: true });
  await writeJson(join(knowledgebaseRoot, "invalid-app", "package.json"), {
    name: "invalid-app",
    private: true,
    type: "module",
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "INVALID APP",
        title: "Invalid app manifest",
        company: "HumanAndMachine-ai",
        surface: "internal",
        port: 4312,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
        tags: [],
      },
    },
  });
  await initContextGitRepo(
    websiteRoot,
    "git@github.com:HumanAndMachine-ai/website-lazurio.git",
  );
  await initContextGitRepo(
    knowledgebaseRoot,
    "git@github.com:HumanAndMachine-ai/knowledgebase.git",
  );
  await initContextGitRepo(
    join(organizationRoot, "mission-control"),
    "git@github.com:HumanAndMachine-ai/mission-control.git",
  );
  const worktreeRelativePath =
    "organizations/HumanAndMachine-ai_GEN3/.worktrees/root/OPS-12-context";
  const worktreeRoot = join(root, worktreeRelativePath);
  await initContextGitRepo(
    worktreeRoot,
    "git@github.com:HumanAndMachine-ai/HumanAndMachine-ai_GEN3.git",
  );
  await writeJson(
    join(
      organizationRoot,
      ".worktrees",
      "root",
      "OPS-12-context.worktree.json",
    ),
    {
      schema_version: "companiesascode.worktree.v1",
      organization: "HumanAndMachine-ai",
      organization_path: "organizations/HumanAndMachine-ai_GEN3",
      workspace: "root",
      module: "root",
      module_path: "organizations/HumanAndMachine-ai_GEN3",
      repo_kind: "organization_root",
      base_branch: "main",
      branch: "main",
      mission_control_plan_code: "OPS-12",
      mission_control_plan_path:
        "mission-control/db/data/mission-control/plans/2026/08/OPS-12-context.yaml",
      worktree_path: worktreeRelativePath,
      created_at: "2026-08-11T00:00:00.000Z",
      created_by: "fixture",
      status: "active",
    },
  );
  return root;
}

async function createContextOrganization({
  root,
  directory,
  slug,
  displayName,
  repository,
  defaultBranch,
  moduleSlots,
  teams,
}) {
  const organizationRoot = join(root, "organizations", directory);
  await mkdir(join(organizationRoot, "manual"), { recursive: true });
  await mkdir(join(organizationRoot, "company", "colleagues"), { recursive: true });
  await writeFile(join(organizationRoot, "AGENTS.md"), `# ${displayName}\n`, "utf8");
  await writeJson(join(organizationRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: {
      slug,
      display_name: displayName,
      github_org: slug,
      repository,
      default_branch: defaultBranch,
    },
    teams,
  });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: slug,
    github_org: slug,
    module_slots: moduleSlots,
  });
  await initContextGitRepo(organizationRoot, repository, [
    "AGENTS.md",
    "company.gen3.json",
    "modules.manifest.json",
  ]);
}

async function initContextGitRepo(path, remote, trackedFiles = ["."]) {
  await mkdir(path, { recursive: true });
  if (!existsSync(join(path, "README.md"))) {
    await writeFile(join(path, "README.md"), "# Fixture\n", "utf8");
  }
  const init = run(["git", "init", "-b", "main"], path);
  if (init.exitCode !== 0) throw new Error(init.stderr);
  for (const args of [
    ["config", "user.name", "Fixture"],
    ["config", "user.email", "fixture@example.com"],
    ["remote", "add", "origin", remote],
    ["add", ...trackedFiles, "README.md"],
    ["commit", "-m", "fixture"],
  ]) {
    const result = run(["git", ...args], path);
    if (result.exitCode !== 0) throw new Error(result.stderr);
  }
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
