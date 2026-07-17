import { afterAll, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import {
  buildPersonalspaceResponse,
  personalspaceDoctorCheck,
  resolveSpaceGbrainVault,
} from "./personalspace-runtime-lib.mjs";
import { GbrainAccessError } from "./gbrain-lib.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function writeJson(path, data) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function personalConfig(username) {
  return {
    schema_version: "humanandmachines.personal.gen3.v1",
    personal_generation: "gen3",
    owner: { github_username: username, display_name: username, type: "human" },
    buddy: {
      slug: `${username}-buddy`,
      path: "buddy",
      repository: {
        github_repo: `${username}/${username}-buddy`,
        visibility: "private",
        mount_strategy: "doctor-managed-nested-repo",
      },
      runtime: {
        github_repo: "HumanAndMachines/Buddy",
      },
      hermes: {
        software_repo: "NousResearch/hermes-agent",
        profile_format: "hermes-profile-distribution",
        profile_path: "buddy",
      },
      display_name: "Demo Buddy",
      application: { name: "Demo chat", type: "web", url: "https://chat.example.test/" },
      recurring_tasks: {
        "synthetic-check": { title: "Syntetická kontrola", schedule_label: "Podle testu" },
      },
      gbrain_path: "gbrain",
    },
    repository: {
      github_repo: `${username}/${username}_GEN3`,
      mount_path: `personalspace/${username}_GEN3`,
      visibility: "private",
      mount_strategy: "doctor-managed-nested-repo",
    },
    privacy: { default_share: "private", agent_boundary: "personal-context-only", shared_outputs: "metadata-only" },
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
    secrets: { path: "secrets", custody_pattern: "personalspace/<owner>_GEN3/secrets/<provider>/<scope>/<purpose>", git: "ignored" },
    shared_spaces: [],
  };
}

async function createFixture({ withGbrain = true, sharedSpace = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ps-runtime-"));
  tempRoots.push(root);
  await mkdir(join(root, "launchpad", "schemas"), { recursive: true });
  const realSchemas = join(import.meta.dirname, "..", "schemas");
  for (const name of ["personal.gen3.schema.json", "launchpad-app.schema.json"]) {
    await writeFile(join(root, "launchpad", "schemas", name), await Bun.file(join(realSchemas, name)).text(), "utf8");
  }
  await writeJson(join(root, "launchpad.gen3.json"), {
    workspace_generation: "gen3",
    organization_mountpoint: "organizations",
    personalspace_mountpoint: "personalspace",
  });
  // Scan-first: primární vlastník mašiny žije v gitignored per-machine override,
  // ne v trackovaném sdíleném configu (osobní data do shared repu nepatří).
  await writeJson(join(root, "launchpad.gen3.local.json"), { personalspace_owner: "exampleuser" });
  const dir = join(root, "personalspace", "exampleuser_GEN3");
  await mkdir(join(dir, "workspace"), { recursive: true });
  await writeJson(join(dir, "personal.gen3.json"), personalConfig("exampleuser"));
  await writeJson(join(dir, "modules.manifest.json"), { personal_generation: "gen3", owner: "exampleuser", module_slots: [] });
  if (withGbrain) {
    await mkdir(join(dir, "gbrain"), { recursive: true });
    await writeFile(join(dir, "gbrain", "index.md"), "# soukromá poznámka jen pro mě", "utf8");
  }
  // Nasdílený (ne-primární) prostor jiného Kolegy s lokálně namountovaným
  // gbrain vaultem a default_shared === false → boundary gate ho musí odmítnout.
  if (sharedSpace) {
    const otherDir = join(root, "personalspace", "kolega_GEN3");
    await mkdir(join(otherDir, "workspace"), { recursive: true });
    await writeJson(join(otherDir, "personal.gen3.json"), personalConfig("kolega"));
    await writeJson(join(otherDir, "modules.manifest.json"), { personal_generation: "gen3", owner: "kolega", module_slots: [] });
    await mkdir(join(otherDir, "gbrain"), { recursive: true });
    await writeFile(join(otherDir, "gbrain", "index.md"), "# cizí soukromá poznámka", "utf8");
  }
  return { root, dir };
}

test("buildPersonalspaceResponse vrací prostory + summary, metadata-only", async () => {
  const { root } = await createFixture();
  const response = await buildPersonalspaceResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    profileEmail: "owner@example.com",
  });
  expect(response.ok).toBe(true);
  expect(response.summary.space_count).toBe(1);
  expect(response.spaces[0].owner).toBe("exampleuser");
  expect(response.spaces[0].is_owner_primary).toBe(true);
  expect(response.spaces[0].buddy).toMatchObject({
    slug: "exampleuser-buddy",
    display_name: "Demo Buddy",
    application: { name: "Demo chat", type: "web", url: "https://chat.example.test/" },
    recurring_tasks: [{ id: "synthetic-check", title: "Syntetická kontrola", schedule_label: "Podle testu" }],
  });
  expect(response.profile).toEqual({
    display_name: "exampleuser",
    email: "owner@example.com",
    github_username: "exampleuser",
    avatar_url: "https://github.com/exampleuser.png?size=128",
    settings_url: "https://github.com/settings/profile",
  });
  // Odpověď NIKDY nenese obsah gbrain zápisů.
  expect(JSON.stringify(response)).not.toContain("soukromá poznámka");
});

test("personalspaceDoctorCheck je metadata-only a nikdy neobsahuje obsah zápisů", async () => {
  const { root } = await createFixture();
  const response = await buildPersonalspaceResponse({ companiesRoot: root, launchpadRoot: join(root, "launchpad") });
  const check = personalspaceDoctorCheck(response);
  expect(check.id).toBe("launchpad.personalspace");
  expect(["ok", "warn", "fail", "skip"]).toContain(check.status);
  // Detaily nesou jen počty/validitu/gbrain mode, ne obsah.
  expect(JSON.stringify(check)).not.toContain("soukromá poznámka");
  expect(check.details.join(" ")).toContain("primární");
});

test("personalspaceDoctorCheck = skip, když není žádný osobní prostor", async () => {
  const root = await mkdtemp(join(tmpdir(), "ps-empty-"));
  tempRoots.push(root);
  await writeJson(join(root, "launchpad.gen3.json"), { workspace_generation: "gen3", personalspace_mountpoint: "personalspace" });
  await mkdir(join(root, "launchpad", "schemas"), { recursive: true });
  const realSchemas = join(import.meta.dirname, "..", "schemas");
  for (const name of ["personal.gen3.schema.json", "launchpad-app.schema.json"]) {
    await writeFile(join(root, "launchpad", "schemas", name), await Bun.file(join(realSchemas, name)).text(), "utf8");
  }
  const response = await buildPersonalspaceResponse({ companiesRoot: root, launchpadRoot: join(root, "launchpad") });
  const check = personalspaceDoctorCheck(response);
  expect(check.status).toBe("skip");
});

test("Doctor nikdy nečte privátní Buddy presentation warnings", () => {
  const privateDetail = "buddy.recurring_tasks[0].id therapy-session je duplicitní";
  const check = personalspaceDoctorCheck({
    mountpoint: "personalspace",
    spaces: [],
    failures: [],
    warnings: [],
    presentation_warnings: [privateDetail],
    summary: { app_count: 0 },
  });

  expect(check.status).toBe("skip");
  expect(JSON.stringify(check)).not.toContain(privateDetail);
});

test("personalspace Doctor zpřístupní kanonický důvod failure pro problems panel", () => {
  const check = personalspaceDoctorCheck({
    mountpoint: "personalspace",
    spaces: [{ mount_path: "personalspace/otherowner_GEN3", config_valid: true, module_summary: {} }],
    failures: ["personal.gen3.json není validní"],
    warnings: [],
    summary: { app_count: 0 },
  });

  expect(check.status).toBe("fail");
  expect(check.details).toContain("failure: personal.gen3.json není validní");
});

test("personalspace Doctor neudělá skip při failure bez materializovaného prostoru", () => {
  const check = personalspaceDoctorCheck({
    mountpoint: "personalspace",
    spaces: [],
    failures: ["personalspace mount nejde přečíst"],
    warnings: [],
    summary: { app_count: 0 },
  });

  expect(check.status).toBe("fail");
  expect(check.details).toContain("failure: personalspace mount nejde přečíst");
});

test("resolveSpaceGbrainVault vrací vault root jen pro validní prostor s existujícím vaultem", async () => {
  const { root } = await createFixture({ withGbrain: true });
  const vault = await resolveSpaceGbrainVault({ companiesRoot: root, spaceDirName: "exampleuser_GEN3" });
  expect(vault.vaultRoot).toBe(join(root, "personalspace", "exampleuser_GEN3", "gbrain"));
  expect(vault.mode).toBe("canonical");
});

test("resolveSpaceGbrainVault odmítne neznámý prostor a chybějící vault", async () => {
  const { root } = await createFixture({ withGbrain: false });
  await expect(resolveSpaceGbrainVault({ companiesRoot: root, spaceDirName: "neexistuje_GEN3" })).rejects.toThrow(GbrainAccessError);
  // Prostor existuje, ale vault ne → vault_not_found.
  await expect(resolveSpaceGbrainVault({ companiesRoot: root, spaceDirName: "exampleuser_GEN3" })).rejects.toThrow(/vault/);
});

test("resolveSpaceGbrainVault odmítne gbrain nasdíleného prostoru s default_shared=false (decision 0051)", async () => {
  const { root } = await createFixture({ withGbrain: true, sharedSpace: true });
  // Cizí (ne-primární) prostor MÁ lokálně namountovaný vault, ale sdílení
  // super-repa nesdílí gbrain → fail-closed 403 gbrain_not_shared.
  let error;
  try {
    await resolveSpaceGbrainVault({ companiesRoot: root, spaceDirName: "kolega_GEN3" });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(GbrainAccessError);
  expect(error.status).toBe(403);
  expect(error.code).toBe("gbrain_not_shared");
  // Vlastní primární prostor zůstává přístupný.
  const vault = await resolveSpaceGbrainVault({ companiesRoot: root, spaceDirName: "exampleuser_GEN3" });
  expect(vault.vaultRoot).toBe(join(root, "personalspace", "exampleuser_GEN3", "gbrain"));
});
