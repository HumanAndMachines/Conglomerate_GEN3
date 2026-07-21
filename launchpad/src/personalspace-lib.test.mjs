import { afterAll, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { buddyPresentationProjection, discoverPersonalspace, personalAppRuntimeId } from "./personalspace-lib.mjs";
import { discoverLaunchpadApps } from "./discovery-lib.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("Buddy presentation projection oddělí UX metadata od kanonické technické vazby", () => {
  expect(buddyPresentationProjection({
    slug: "demobuddy",
    gbrain_path: "gbrain",
    status: "active",
    display_name: "Demo Buddy",
    application: { name: "Demo chat", type: "web" },
    runtime: {
      deployment_target: "owner-dedicated-personalspace-vps",
      local_execution: "forbidden",
    },
  })).toEqual({
    display_name: "Demo Buddy",
    application: { name: "Demo chat", type: "web" },
  });
});

async function writeJson(path, data) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function personalConfig(username, overrides = {}) {
  const base = {
    schema_version: "humanandmachines.personal.gen3.v1",
    personal_generation: "gen3",
    owner: { github_username: username, display_name: `${username} Display`, type: "human" },
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
        deployment_target: "owner-dedicated-personalspace-vps",
        local_execution: "forbidden",
      },
      hermes: {
        software_repo: "NousResearch/hermes-agent",
        profile_format: "hermes-profile-distribution",
        profile_path: "buddy",
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
  return {
    ...base,
    ...overrides,
    owner: { ...base.owner, ...(overrides.owner ?? {}) },
    buddy: overrides.buddy === undefined
      ? base.buddy
      : {
          ...base.buddy,
          ...overrides.buddy,
          repository: {
            ...base.buddy.repository,
            ...(overrides.buddy?.repository ?? {}),
            github_repo: overrides.buddy?.repository?.github_repo
              ?? `${username}/${overrides.buddy?.slug ?? base.buddy.slug}`,
          },
          runtime: {
            ...base.buddy.runtime,
            ...(overrides.buddy?.runtime ?? {}),
          },
          hermes: {
            ...base.buddy.hermes,
            ...(overrides.buddy?.hermes ?? {}),
          },
        },
    repository: { ...base.repository, ...(overrides.repository ?? {}) },
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
  };
}

function personalAppManifest(username, { id, port, module = "notes", title = "Osobní poznámky" } = {}) {
  return {
    name: `${username}-${id}`,
    version: "1.0.0",
    packageManager: "bun@1.0.0",
    scripts: { dev: "bun run server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id,
        title,
        company: username,
        module,
        surface: "internal",
        port,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
        tags: ["personal"],
      },
    },
  };
}

// Root fixture s launchpad.gen3.json + personalspace mountpointem. Vrací root path.
// Scan-first (decision 0042): trackovaný config vlastníka NEnese a sken ho nikdy
// neodvozuje (fail-closed privacy hranice). Prostor Principála určuje jen
// `localOwner`, který se zapíše do
// gitignored launchpad.gen3.local.json (per-machine override).
async function createPersonalspaceFixture({ spaces = [], localOwner = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "personalspace-"));
  tempRoots.push(root);
  // Kopie personal + app schema z reálného launchpad/schemas do fixture rootu,
  // aby discovery lane měla schémata k dispozici.
  await mkdir(join(root, "launchpad", "schemas"), { recursive: true });
  const realSchemas = join(import.meta.dirname, "..", "schemas");
  for (const name of ["personal.gen3.schema.json", "launchpad-app.schema.json"]) {
    const content = await Bun.file(join(realSchemas, name)).text();
    await writeFile(join(root, "launchpad", "schemas", name), content, "utf8");
  }
  await writeJson(join(root, "launchpad.gen3.json"), {
    workspace_generation: "gen3",
    organization_mountpoint: "organizations",
    personalspace_mountpoint: "personalspace",
  });
  if (localOwner) {
    await writeJson(join(root, "launchpad.gen3.local.json"), { personalspace_owner: localOwner });
  }
  await mkdir(join(root, "organizations"), { recursive: true });

  for (const space of spaces) {
    const dir = join(root, "personalspace", space.dirName);
    await mkdir(join(dir, "workspace"), { recursive: true });
    await writeJson(join(dir, "personal.gen3.json"), space.config);
    await writeJson(join(dir, "modules.manifest.json"), space.manifest ?? { personal_generation: "gen3", owner: space.owner, module_slots: [] });
    if (space.gbrainNotes) {
      await mkdir(join(dir, "gbrain"), { recursive: true });
      for (const [name, body] of Object.entries(space.gbrainNotes)) {
        await writeFile(join(dir, "gbrain", name), body, "utf8");
      }
    }
    for (const app of space.apps ?? []) {
      const appDir = join(dir, "workspace", app.module ?? "notes", "app", "v1");
      await mkdir(appDir, { recursive: true });
      await writeJson(join(appDir, "package.json"), app.manifest);
    }
    // Materializuj "available" moduly (jejich složka existuje).
    for (const materialized of space.materializedModules ?? []) {
      await mkdir(join(dir, materialized), { recursive: true });
      await writeFile(join(dir, materialized, ".gitkeep"), "", "utf8");
    }
  }
  return root;
}

test("personalspace lane objeví validní osobní prostor s aplikací a Private příznaky", async () => {
  const root = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [
      {
        dirName: "exampleuser_GEN3",
        owner: "exampleuser",
        config: personalConfig("exampleuser"),
        apps: [{ module: "notes", manifest: personalAppManifest("exampleuser", { id: "notes-v1", port: 41100 }) }],
      },
    ],
  });
  const result = await discoverPersonalspace(root);

  expect(result.failures).toEqual([]);
  expect(result.spaces).toHaveLength(1);
  const space = result.spaces[0];
  expect(space.owner).toBe("exampleuser");
  expect(space.is_owner_primary).toBe(true);
  expect(space.config_valid).toBe(true);
  expect(space.identity_ok).toBe(true);
  expect(result.apps).toHaveLength(1);
  const app = result.apps[0];
  expect(app.personal).toBe(true);
  expect(app.surface_scope).toBe("private");
  expect(app.space).toBe("exampleuser_GEN3");
  expect(app.id).toBe(personalAppRuntimeId("exampleuser_GEN3", "notes-v1"));
});

test("Personalspace bez Buddyho je validní a materializuje osobní aplikace i gbrain", async () => {
  const config = personalConfig("exampleuser");
  delete config.buddy;
  const root = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [{
      dirName: "exampleuser_GEN3",
      owner: "exampleuser",
      config,
      gbrainNotes: { "index.md": "# osobní paměť" },
      apps: [{ module: "notes", manifest: personalAppManifest("exampleuser", { id: "notes-v1", port: 41109 }) }],
    }],
  });

  const result = await discoverPersonalspace(root);
  expect(result.failures).toEqual([]);
  expect(result.spaces[0].config_valid).toBe(true);
  expect(result.spaces[0].buddy).toBeNull();
  expect(result.spaces[0].gbrain.exists).toBe(true);
  expect(result.apps).toHaveLength(1);
});

test("legacy neversionovaný Personalspace zůstane čitelný s migračním warningem", async () => {
  const config = personalConfig("exampleuser");
  delete config.schema_version;
  delete config.repository.mount_strategy;
  delete config.gbrain.repository;
  delete config.gbrain.software;
  config.buddy = { slug: "exampleuser-buddy", gbrain_path: "gbrain" };
  const root = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [{
      dirName: "exampleuser_GEN3",
      owner: "exampleuser",
      config,
      gbrainNotes: { "index.md": "# legacy osobní paměť" },
      apps: [{ module: "notes", manifest: personalAppManifest("exampleuser", { id: "notes-v1", port: 41109 }) }],
    }],
  });

  const result = await discoverPersonalspace(root);
  expect(result.failures).toEqual([]);
  expect(result.spaces[0].config_valid).toBe(true);
  expect(result.spaces[0].personal_schema_version).toBe("legacy-gen3-unversioned");
  expect(result.spaces[0].gbrain.repository).toBeNull();
  expect(result.warnings.some((warning) => warning.includes("migrate-personalspace-custody-v1.md"))).toBe(true);
  expect(result.apps).toHaveLength(1);
});

test("částečně migrovaný custody kontrakt failuje místo tichého defaultu", async () => {
  const config = personalConfig("exampleuser");
  delete config.gbrain.repository;
  const root = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [{
      dirName: "exampleuser_GEN3",
      owner: "exampleuser",
      config,
      gbrainNotes: {},
    }],
  });

  const result = await discoverPersonalspace(root);
  expect(result.failures.some((failure) => failure.includes("gbrain.repository"))).toBe(true);
  expect(result.spaces).toHaveLength(1);
  expect(result.spaces[0].is_owner_primary).toBe(true);
  expect(result.spaces[0].config_valid).toBe(false);
  expect(result.apps).toHaveLength(0);
});

test("versionovaný Buddy binding failuje bez private Hermes distribution kontraktu", async () => {
  const config = personalConfig("exampleuser");
  delete config.buddy.repository;
  const root = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [{
      dirName: "exampleuser_GEN3",
      owner: "exampleuser",
      config,
      gbrainNotes: {},
    }],
  });

  const result = await discoverPersonalspace(root);
  expect(result.failures.some((failure) => failure.includes("buddy.repository"))).toBe(true);
  expect(result.apps).toHaveLength(0);
});

test("versionovaný Buddy binding failuje při localhost runtime nebo povoleném local execution", async () => {
  const config = personalConfig("exampleuser", {
    buddy: {
      runtime: {
        deployment_target: "localhost",
        local_execution: "allowed",
      },
    },
  });
  const root = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [{
      dirName: "exampleuser_GEN3",
      owner: "exampleuser",
      config,
      gbrainNotes: {},
    }],
  });

  const result = await discoverPersonalspace(root);
  expect(result.failures.some((failure) => failure.includes("buddy.runtime.deployment_target"))).toBe(true);
  expect(result.failures.some((failure) => failure.includes("buddy.runtime.local_execution"))).toBe(true);
  expect(result.apps).toHaveLength(0);
});

test("gbrain data repo nesmí aliasovat owner repo", async () => {
  const config = personalConfig("exampleuser", {
    gbrain: { repository: { github_repo: "exampleuser/exampleuser_GEN3" } },
  });
  const root = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [{
      dirName: "exampleuser_GEN3",
      owner: "exampleuser",
      config,
      gbrainNotes: {},
    }],
  });

  const result = await discoverPersonalspace(root);
  expect(result.failures.some((failure) => failure.includes("jiné repo"))).toBe(true);
  expect(result.apps).toHaveLength(0);
});

test("Buddy prezentační metadata zůstanou v oddělené personalspace lane", async () => {
  const root = await createPersonalspaceFixture({
    localOwner: "otherowner",
    spaces: [{
      dirName: "otherowner_GEN3",
      owner: "otherowner",
      config: personalConfig("otherowner", {
        buddy: {
          slug: "demobuddy",
          display_name: "Demo Buddy",
          application: { name: "Demo chat", type: "web", url: "https://chat.example.test/" },
          recurring_tasks: [
            { id: "synthetic-check", title: "Syntetická kontrola", schedule_label: "Podle testu" },
          ],
          gbrain_path: "gbrain",
        },
      }),
    }],
  });

  const result = await discoverPersonalspace(root);
  expect(result.failures).toEqual([]);
  expect(result.spaces[0].buddy).toMatchObject({
    slug: "demobuddy",
    display_name: "Demo Buddy",
    application: { name: "Demo chat", type: "web" },
    recurring_tasks: [{ id: "synthetic-check", title: "Syntetická kontrola", schedule_label: "Podle testu" }],
  });
  expect(result.apps).toEqual([]);
});

test("nebezpečný odkaz skryje jen Buddy prezentaci, neplatný Personalspace z něj nevznikne", async () => {
  const root = await createPersonalspaceFixture({
    localOwner: "otherowner",
    spaces: [{
      dirName: "otherowner_GEN3",
      owner: "otherowner",
      config: personalConfig("otherowner", {
        buddy: {
          slug: "demobuddy",
          application: { name: "Demo chat", type: "web", url: "javascript:alert(1)" },
          gbrain_path: "gbrain",
        },
      }),
    }],
  });

  const result = await discoverPersonalspace(root);
  expect(result.spaces[0].config_valid).toBe(true);
  expect(result.spaces[0].buddy.application).toBeNull();
  expect(result.presentation_warnings.some((warning) => warning.includes("Buddy prezentační metadata se ignorují"))).toBe(true);
});

test("neřetězcový odkaz skryje jen Buddy prezentaci", async () => {
  const root = await createPersonalspaceFixture({
    localOwner: "otherowner",
    spaces: [{
      dirName: "otherowner_GEN3",
      owner: "otherowner",
      config: personalConfig("otherowner", {
        buddy: {
          slug: "demobuddy",
          application: { name: "Demo chat", type: "web", url: 42 },
          gbrain_path: "gbrain",
        },
      }),
    }],
  });

  const result = await discoverPersonalspace(root);
  expect(result.spaces[0].config_valid).toBe(true);
  expect(result.spaces[0].buddy.application).toBeNull();
  expect(result.presentation_warnings.some((warning) => warning.includes("buddy.application.url musí být neprázdný text"))).toBe(true);
});

test("neúplná URL skryje jen Buddy prezentaci", async () => {
  const root = await createPersonalspaceFixture({
    localOwner: "otherowner",
    spaces: [{
      dirName: "otherowner_GEN3",
      owner: "otherowner",
      config: personalConfig("otherowner", {
        buddy: {
          slug: "demobuddy",
          application: { name: "Demo chat", type: "web", url: "https://" },
          gbrain_path: "gbrain",
        },
      }),
    }],
  });

  const result = await discoverPersonalspace(root);
  expect(result.spaces[0].config_valid).toBe(true);
  expect(result.spaces[0].buddy.application).toBeNull();
  expect(result.presentation_warnings.some((warning) => warning.includes("buddy.application.url"))).toBe(true);
});

test("validní URL s query bez lomítka projde Personalspace configem", async () => {
  const root = await createPersonalspaceFixture({
    localOwner: "otherowner",
    spaces: [{
      dirName: "otherowner_GEN3",
      owner: "otherowner",
      config: personalConfig("otherowner", {
        buddy: {
          slug: "demobuddy",
          application: { name: "Demo chat", type: "web", url: "https://example.com?chat=1" },
          gbrain_path: "gbrain",
        },
      }),
    }],
  });

  const result = await discoverPersonalspace(root);
  expect(result.spaces[0].config_valid).toBe(true);
  expect(result.spaces[0].buddy.application.url).toBe("https://example.com?chat=1");
});

test("localhost Buddy odkaz se skryje bez znevalidnění Personalspace", async () => {
  for (const url of [
    "http://localhost:3000",
    "http://buddy.localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ]) {
    const root = await createPersonalspaceFixture({
      localOwner: "exampleuser",
      spaces: [{
        dirName: "exampleuser_GEN3",
        owner: "exampleuser",
        config: personalConfig("exampleuser", {
          buddy: {
            application: { name: "Zakázaný lokální Buddy", type: "web", url },
          },
        }),
      }],
    });

    const result = await discoverPersonalspace(root);
    expect(result.spaces[0].config_valid).toBe(true);
    expect(result.spaces[0].buddy.application).toBeNull();
    expect(result.presentation_warnings.some((warning) => warning.includes("buddy.application.url"))).toBe(true);
  }
});

test("neplatný port, hostname nebo URI syntax skryje jen Buddy prezentaci", async () => {
  for (const url of ["https://example.com:99999/", "http://./", "https://example.com/%zz", "https:\\example.com", "tg:resolve?domain=lumi"]) {
    const root = await createPersonalspaceFixture({
      localOwner: "otherowner",
      spaces: [{
        dirName: "otherowner_GEN3",
        owner: "otherowner",
        config: personalConfig("otherowner", {
          buddy: {
            slug: "demobuddy",
            application: { name: "Demo chat", type: "web", url },
            gbrain_path: "gbrain",
          },
        }),
      }],
    });

    const result = await discoverPersonalspace(root);
    expect(result.spaces[0].config_valid).toBe(true);
    expect(result.spaces[0].buddy.application).toBeNull();
    expect(result.presentation_warnings.some((warning) => warning.includes("buddy.application.url"))).toBe(true);
  }
});

test("starší neautoritativní status je tolerovaný, ale nedostane se do Launchpad odpovědi", async () => {
  const root = await createPersonalspaceFixture({
    localOwner: "otherowner",
    spaces: [{
      dirName: "otherowner_GEN3",
      owner: "otherowner",
      config: personalConfig("otherowner", {
        buddy: { slug: "demobuddy", status: "active", gbrain_path: "gbrain" },
      }),
    }],
  });

  const result = await discoverPersonalspace(root);
  expect(result.spaces[0].config_valid).toBe(true);
  expect(result.spaces[0].buddy.status).toBeUndefined();
});

test("neplatný identifikátor opakovaného úkolu skryje jen Buddy prezentaci", async () => {
  const root = await createPersonalspaceFixture({
    localOwner: "otherowner",
    spaces: [{
      dirName: "otherowner_GEN3",
      owner: "otherowner",
      config: personalConfig("otherowner", {
        buddy: {
          slug: "demobuddy",
          recurring_tasks: {
            "Neplatné ID": { title: "Denní kontrola", schedule_label: "Denně" },
          },
          gbrain_path: "gbrain",
        },
      }),
    }],
  });

  const result = await discoverPersonalspace(root);
  expect(result.spaces[0].config_valid).toBe(true);
  expect(result.spaces[0].buddy.recurring_tasks).toEqual([]);
  expect(result.presentation_warnings.some((warning) => warning.includes("Neplatné ID neodpovídá pattern"))).toBe(true);
});

test("duplicitní ID ve starším seznamu úkolů skryje jen Buddy prezentaci", async () => {
  const root = await createPersonalspaceFixture({
    localOwner: "otherowner",
    spaces: [{
      dirName: "otherowner_GEN3",
      owner: "otherowner",
      config: personalConfig("otherowner", {
        buddy: {
          slug: "demobuddy",
          recurring_tasks: [
            { id: "daily-check", title: "První kontrola", schedule_label: "Denně" },
            { id: "daily-check", title: "Druhá kontrola", schedule_label: "Denně" },
          ],
          gbrain_path: "gbrain",
        },
      }),
    }],
  });

  const result = await discoverPersonalspace(root);
  expect(result.spaces[0].config_valid).toBe(true);
  expect(result.spaces[0].buddy.recurring_tasks).toEqual([]);
  expect(result.presentation_warnings.some((warning) => warning.includes("daily-check je duplicitní"))).toBe(true);
});

test("cizí Personalspace se nematerializuje a vyvolá failure", async () => {
  const root = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [
      { dirName: "othercolleague_GEN3", owner: "othercolleague", config: personalConfig("othercolleague") },
      { dirName: "exampleuser_GEN3", owner: "exampleuser", config: personalConfig("exampleuser") },
    ],
  });
  const result = await discoverPersonalspace(root);

  expect(result.spaces).toHaveLength(1);
  expect(result.spaces[0].owner).toBe("exampleuser");
  expect(result.spaces[0].is_owner_primary).toBe(true);
  expect(result.failures.join(" ")).toContain("cizí Personalspace ownera othercolleague");
});

test("cizí prostor ani jeho privátní Buddy prezentace nevstoupí do odpovědi", async () => {
  const privateMarker = "synthetic-shared-private-marker";
  const root = await createPersonalspaceFixture({
    localOwner: "primary",
    spaces: [
      { dirName: "primary_GEN3", owner: "primary", config: personalConfig("primary") },
      {
        dirName: "shared_GEN3",
        owner: "shared",
        config: personalConfig("shared", {
          buddy: {
            slug: "shared-buddy",
            display_name: privateMarker,
            recurring_tasks: {
              "private-check": { title: privateMarker, schedule_label: "Soukromě" },
            },
            gbrain_path: "gbrain",
          },
        }),
      },
    ],
  });

  const result = await discoverPersonalspace(root);
  const shared = result.spaces.find((space) => space.owner === "shared");
  expect(shared).toBeUndefined();
  expect(result.failures.join(" ")).toContain("cizí Personalspace ownera shared");
  expect(JSON.stringify(result)).not.toContain(privateMarker);
});

test("bez owner override se žádný Personalspace nematerializuje", async () => {
  const root = await createPersonalspaceFixture({
    spaces: [
      { dirName: "othercolleague_GEN3", owner: "othercolleague", config: personalConfig("othercolleague") },
    ],
  });
  const result = await discoverPersonalspace(root);

  expect(result.failures).toEqual([]);
  expect(result.primary_owner).toBeNull();
  expect(result.spaces).toEqual([]);
  expect(result.apps).toEqual([]);
  expect(result.warnings.some((warning) => warning.includes("Principál mašiny není určen"))).toBe(true);
  expect(result.warnings.some((warning) => warning.includes("othercolleague"))).toBe(true);
});

test("víc prostorů bez override = žádná materializace + warning", async () => {
  const root = await createPersonalspaceFixture({
    spaces: [
      { dirName: "othercolleague_GEN3", owner: "othercolleague", config: personalConfig("othercolleague") },
      { dirName: "exampleuser_GEN3", owner: "exampleuser", config: personalConfig("exampleuser") },
    ],
  });
  const result = await discoverPersonalspace(root);

  expect(result.failures).toEqual([]);
  expect(result.primary_owner).toBeNull();
  expect(result.spaces).toEqual([]);
  expect(result.apps).toEqual([]);
  expect(result.warnings.some((warning) => warning.includes("Principál mašiny není určen"))).toBe(true);
});

test("shared_spaces musí zůstat prázdné", async () => {
  const config = personalConfig("exampleuser");
  config.shared_spaces = [{ owner: "othercolleague" }];
  const root = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [{ dirName: "exampleuser_GEN3", owner: "exampleuser", config }],
  });
  const result = await discoverPersonalspace(root);
  expect(result.spaces).toHaveLength(1);
  expect(result.spaces[0].config_valid).toBe(false);
  expect(result.failures.join(" ")).toContain("shared_spaces musí zůstat prázdné");
});

test("legacy owner manifest bez reserved shared_spaces zůstává validní", async () => {
  const config = personalConfig("exampleuser");
  delete config.shared_spaces;
  const root = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [{ dirName: "exampleuser_GEN3", owner: "exampleuser", config }],
  });
  const result = await discoverPersonalspace(root);
  expect(result.spaces).toHaveLength(1);
  expect(result.spaces[0].config_valid).toBe(true);
});

test("cizí _GEN3 checkout bez manifestu je privacy failure", async () => {
  const root = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [{ dirName: "exampleuser_GEN3", owner: "exampleuser", config: personalConfig("exampleuser") }],
  });
  await mkdir(join(root, "personalspace", "othercolleague_GEN3"), { recursive: true });
  const result = await discoverPersonalspace(root);
  expect(result.spaces).toHaveLength(1);
  expect(result.apps).toHaveLength(0);
  expect(result.failures.join(" ")).toContain("foreign_or_unrecognized_personalspace_dir");
  expect(result.failures.join(" ")).toContain("cizí Personalspace ownera othercolleague");
});

test("legacy personalspace_owner ve sdíleném configu se ignoruje s deprecation warningem (scan-first)", async () => {
  const root = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [
      { dirName: "exampleuser_GEN3", owner: "exampleuser", config: personalConfig("exampleuser") },
    ],
  });
  // Stale lokální kopie sdíleného configu ještě nese osobní data vlastníka.
  const configPath = join(root, "launchpad.gen3.json");
  const config = await Bun.file(configPath).json();
  config.personalspace_owner = "someoneelse";
  await writeJson(configPath, config);

  const result = await discoverPersonalspace(root);

  expect(result.failures).toEqual([]);
  // Legacy hodnota se NEpoužije — vlastníka drží per-machine override.
  expect(result.primary_owner).toBe("exampleuser");
  expect(result.warnings.some((warning) => warning.includes("personalspace_owner je zastaralé pole"))).toBe(true);
});

test("modul bez lokálního checkoutu s deklarovaným repo je missing_access; bez repo je planned_slot", async () => {
  const root = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [
      {
        dirName: "exampleuser_GEN3",
        owner: "exampleuser",
        config: personalConfig("exampleuser"),
        manifest: {
          personal_generation: "gen3",
          owner: "exampleuser",
          module_slots: [
            { path: "workspace/shared-todo", category: "knowledge", default_access: "private", repo: "exampleuser/shared-todo" },
            { path: "workspace/future-idea", category: "knowledge", default_access: "private" },
            { path: "workspace/present", category: "knowledge", default_access: "private" },
          ],
        },
        materializedModules: ["workspace/present"],
      },
    ],
  });
  const result = await discoverPersonalspace(root);

  expect(result.failures).toEqual([]);
  const modules = result.spaces[0].modules;
  const byPath = Object.fromEntries(modules.map((m) => [m.path, m.status]));
  expect(byPath["workspace/shared-todo"]).toBe("missing_access");
  expect(byPath["workspace/future-idea"]).toBe("planned_slot");
  expect(byPath["workspace/present"]).toBe("available");
  expect(result.spaces[0].module_summary).toEqual({ available: 1, missing_access: 1, planned_slot: 1 });
});

test("nevalidní osobní app manifest izoluje jen sebe (prostor zůstává validní)", async () => {
  const badManifest = personalAppManifest("exampleuser", { id: "broken", port: 41102 });
  // Rozbij surface na nepovolenou hodnotu.
  badManifest.companyascode.app.surface = "not-a-surface";
  const root = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [
      {
        dirName: "exampleuser_GEN3",
        owner: "exampleuser",
        config: personalConfig("exampleuser"),
        apps: [
          { module: "good", manifest: personalAppManifest("exampleuser", { id: "good-v1", port: 41101, module: "good" }) },
          { module: "bad", manifest: badManifest },
        ],
      },
    ],
  });
  const result = await discoverPersonalspace(root);

  // Prostor je pořád validní, jedna appka platná, jedna izolovaná jako invalid.
  expect(result.spaces[0].config_valid).toBe(true);
  expect(result.apps.map((a) => a.app_id)).toContain("good-v1");
  expect(result.apps.map((a) => a.app_id)).not.toContain("broken");
  expect(result.invalid_apps).toHaveLength(1);
  expect(result.invalid_apps[0].manifest_state).toBe("invalid_manifest");
});

test("porušený identity invariant → prostor se NEmaterializuje (fail-closed), žádné appky", async () => {
  // owner ≠ dir name (mount adresář lže o vlastníkovi).
  const root = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [
      {
        dirName: "someoneelse_GEN3",
        owner: "exampleuser",
        // config tvrdí exampleuser, ale adresář je someoneelse_GEN3 → invariant fail
        config: personalConfig("exampleuser"),
        apps: [{ module: "notes", manifest: personalAppManifest("exampleuser", { id: "notes-v1", port: 41103 }) }],
      },
    ],
  });
  const result = await discoverPersonalspace(root);

  expect(result.failures.length).toBeGreaterThan(0);
  expect(result.failures.join(" ")).toContain("neodpovídá owner.github_username");
  // Prostor je viditelný jako nevalidní, ale bez materializace appek/gbrainu.
  expect(result.spaces).toHaveLength(1);
  expect(result.spaces[0].config_valid).toBe(false);
  expect(result.spaces[0].identity_ok).toBe(false);
  expect(result.apps).toHaveLength(0);
});

test("nevalidní privacy const (shared_outputs) selže — tvrdá hranice", async () => {
  const leaky = personalConfig("exampleuser");
  leaky.privacy.shared_outputs = "everything"; // musí být metadata-only
  const root = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [{ dirName: "exampleuser_GEN3", owner: "exampleuser", config: leaky }],
  });
  const result = await discoverPersonalspace(root);

  expect(result.failures.join(" ")).toContain("privacy.shared_outputs");
  expect(result.spaces[0].config_valid).toBe(false);
});

test("ORG discovery NIKDY nevidí personalspace (oddělené lane)", async () => {
  const root = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [
      {
        dirName: "exampleuser_GEN3",
        owner: "exampleuser",
        config: personalConfig("exampleuser"),
        apps: [{ module: "notes", manifest: personalAppManifest("exampleuser", { id: "notes-v1", port: 41104 }) }],
      },
    ],
  });
  // Org lane nad stejným rootem: nesmí objevit žádnou osobní aplikaci ani prostor.
  const org = await discoverLaunchpadApps(root, { allowMissingOrganizations: true });
  expect(org.apps).toHaveLength(0);
  expect(org.organizations).toHaveLength(0);
  // Žádný org výstup nesmí odkazovat personalspace mountpoint jako cestu ani
  // osobní app id (personal--). (Pozn.: temp fixture root se náhodou jmenuje
  // "personalspace-…", proto porovnáváme mountpoint cestu, ne holý substring.)
  const orgText = [...org.failures, ...org.warnings, JSON.stringify(org.apps)].join(" ");
  expect(orgText).not.toContain("personalspace/exampleuser_GEN3");
  expect(orgText).not.toContain("personal--");

  // Personalspace lane naopak prostor vidí.
  const personal = await discoverPersonalspace(root);
  expect(personal.spaces).toHaveLength(1);
  expect(personal.apps).toHaveLength(1);
});

test("cizí adresář bez _GEN3 názvu a manifestu je Doctor failure a nematerializuje se", async () => {
  const root = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [{ dirName: "exampleuser_GEN3", owner: "exampleuser", config: personalConfig("exampleuser") }],
  });
  await mkdir(join(root, "personalspace", "just-a-vault"), { recursive: true });
  await writeFile(join(root, "personalspace", "just-a-vault", "note.md"), "# ahoj", "utf8");
  const result = await discoverPersonalspace(root);
  expect(result.failures.join(" ")).toContain("foreign_or_unrecognized_personalspace_dir");
  expect(result.failures.join(" ")).toContain("personalspace/just-a-vault");
  expect(result.failures.join(" ")).toContain("není deklarovaný Personalspace Principála exampleuser");
  expect(result.spaces.map((space) => space.dir_name)).toEqual(["exampleuser_GEN3"]);
  expect(result.apps).toHaveLength(0);
});

test("gbrain transitional_source_path uvnitř rootu se použije; útěk mimo root se odmítne na canonical", async () => {
  const root = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [
      {
        dirName: "exampleuser_GEN3",
        owner: "exampleuser",
        config: personalConfig("exampleuser", {
          gbrain: { path: "gbrain", default_shared: false, human_editor: "obsidian", agent_access: "mcp-only", transitional_source_path: "../live-vault" },
        }),
      },
    ],
  });
  // Vytvoř živý vault vedle prostoru (uvnitř personalspace/, tedy uvnitř rootu).
  await mkdir(join(root, "personalspace", "live-vault"), { recursive: true });
  await writeFile(join(root, "personalspace", "live-vault", "index.md"), "# live", "utf8");
  const result = await discoverPersonalspace(root);
  const gbrain = result.spaces[0].gbrain;
  expect(gbrain.mode).toBe("transitional");
  expect(gbrain.exists).toBe(true);
  expect(gbrain.source_rel).toBe("personalspace/live-vault");

  // Teď útěk mimo root:
  const root2 = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [
      {
        dirName: "exampleuser_GEN3",
        owner: "exampleuser",
        config: personalConfig("exampleuser", {
          gbrain: { path: "gbrain", default_shared: false, human_editor: "obsidian", agent_access: "mcp-only", transitional_source_path: "../../../../etc" },
        }),
        gbrainNotes: { "canonical.md": "# canonical" },
      },
    ],
  });
  const result2 = await discoverPersonalspace(root2);
  expect(result2.spaces[0].gbrain.mode).toBe("canonical");
  expect(result2.warnings.join(" ")).toContain("mimo personalspace mountpoint");
});

test("gbrain transitional_source_path mířící do organizations/ se odmítne (privátní hranice)", async () => {
  const root = await createPersonalspaceFixture({
    localOwner: "exampleuser",
    spaces: [
      {
        dirName: "exampleuser_GEN3",
        owner: "exampleuser",
        config: personalConfig("exampleuser", {
          gbrain: { path: "gbrain", default_shared: false, human_editor: "obsidian", agent_access: "mcp-only", transitional_source_path: "../../organizations/SomeOrg_GEN3" },
        }),
        gbrainNotes: { "canonical.md": "# canonical" },
      },
    ],
  });
  // I kdyby ta org složka existovala, přechodný zdroj mimo personalspace/ se odmítne.
  await mkdir(join(root, "organizations", "SomeOrg_GEN3"), { recursive: true });
  await writeFile(join(root, "organizations", "SomeOrg_GEN3", "secret.md"), "# org tajemství", "utf8");
  const result = await discoverPersonalspace(root);
  expect(result.spaces[0].gbrain.mode).toBe("canonical");
  expect(result.spaces[0].gbrain.source_rel).toContain("exampleuser_GEN3/gbrain");
  expect(result.warnings.join(" ")).toContain("mimo personalspace mountpoint");
});
