import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "fs/promises";
import { join } from "path";
import { createModuleFolderOpener, folderOpenCommand } from "./module-folder-lib.mjs";

const tempRoots = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("otevře dostupný deklarovaný modul ve všech třech Organization prostorech", async () => {
  const root = join(import.meta.dir, `.tmp-module-folder-${crypto.randomUUID()}`);
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "Demo_GEN3");
  const moduleRoots = {
    root: join(organizationRoot, "infra"),
    workspace: join(organizationRoot, "workspace", "presentation"),
    productionspace: join(organizationRoot, "productionspace", "firmware"),
  };
  await Promise.all(Object.values(moduleRoots).map((path) => mkdir(path, { recursive: true })));
  const commands = [];
  const opener = createModuleFolderOpener({
    companiesRoot: root,
    platform: "darwin",
    spawnCommand: async (command) => {
      commands.push(command);
      return { ok: true };
    },
    accessExecutable: async () => {},
    getAppsResponse: async () => ({
      organizations: [{
        slug: "Demo",
        path: "organizations/Demo_GEN3",
        organization_modules: [{ slug: "infra", path: "infra", status: "available" }],
        teams: [{
          slug: "workspace",
          modules: [{ slug: "presentation", path: "workspace/presentation", status: "available" }],
        }],
        productionspace: {
          systems: [{ slug: "firmware", path: "productionspace/firmware", status: "available" }],
        },
      }],
    }),
  });

  await expect(opener.open({ organization: "Demo", modulePath: "infra", space: "root" })).resolves.toMatchObject({
    action: "open_module_folder",
    organization: "Demo",
    module: "infra",
    module_path: "infra",
    space: "root",
  });
  await expect(opener.open({ organization: "Demo", modulePath: "workspace/presentation", space: "workspace" })).resolves.toMatchObject({
    module: "presentation",
    space: "workspace",
  });
  await expect(opener.open({ organization: "Demo", modulePath: "productionspace/firmware", space: "productionspace" })).resolves.toMatchObject({
    module: "firmware",
    space: "productionspace",
  });
  expect(commands).toEqual([
    ["/usr/bin/open", moduleRoots.root],
    ["/usr/bin/open", moduleRoots.workspace],
    ["/usr/bin/open", moduleRoots.productionspace],
  ]);

  let blockedSpawnCount = 0;
  const unavailableOpener = createModuleFolderOpener({
    companiesRoot: root,
    platform: "darwin",
    getAppsResponse: async () => ({
      organizations: [{
        slug: "Demo",
        path: "organizations/Demo_GEN3",
        workspaces: [{
          slug: "workspace",
          modules: [{ slug: "presentation", path: "workspace/presentation", status: "available" }],
        }],
      }],
    }),
    accessExecutable: async () => {
      throw new Error("missing");
    },
    spawnCommand: async () => {
      blockedSpawnCount += 1;
      return { ok: true };
    },
  });
  await expect(unavailableOpener.open({
    organization: "Demo",
    modulePath: "workspace/presentation",
    space: "workspace",
  })).rejects.toMatchObject({
    status: 501,
    code: "folder_open_unavailable",
  });
  expect(blockedSpawnCount).toBe(0);
});

test("odmítne chybějící checkout a symlink mimo Organizaci", async () => {
  const root = join(import.meta.dir, `.tmp-module-folder-${crypto.randomUUID()}`);
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "Demo_GEN3");
  const outside = join(root, "outside");
  await mkdir(organizationRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(organizationRoot, "escaped"));

  const response = {
    organizations: [{
      slug: "Demo",
      path: "organizations/Demo_GEN3",
      workspaces: [{
        slug: "workspace",
        modules: [
          { slug: "missing", path: "workspace/missing", status: "missing_access" },
          { slug: "escaped", path: "escaped", status: "available" },
        ],
      }],
    }],
  };
  const opener = createModuleFolderOpener({
    companiesRoot: root,
    getAppsResponse: async () => response,
    spawnCommand: async () => ({ ok: true }),
  });

  await expect(opener.open({ organization: "Demo", modulePath: "workspace/missing" })).rejects.toMatchObject({
    status: 409,
    code: "module_folder_unavailable",
    message: "Repozitář tohoto modulu není na tomto počítači dostupný. Přístup určuje GitHub.",
  });
  await expect(opener.open({ organization: "Demo", modulePath: "escaped" })).rejects.toMatchObject({
    status: 403,
    code: "module_path_forbidden",
  });
});

test("zastaralý požadavek vysvětlí obnovu přehledu bez tvrzení, že repo opustilo Organizaci", async () => {
  const root = join(import.meta.dir, `.tmp-module-folder-${crypto.randomUUID()}`);
  tempRoots.push(root);
  await mkdir(join(root, "organizations", "Demo_GEN3"), { recursive: true });
  const opener = createModuleFolderOpener({
    companiesRoot: root,
    getAppsResponse: async () => ({
      organizations: [{ slug: "Demo", path: "organizations/Demo_GEN3", organization_modules: [] }],
    }),
  });

  await expect(opener.open({ organization: "Demo", modulePath: "infra", space: "root" })).rejects.toMatchObject({
    status: 404,
    code: "module_not_found",
    message: "Tento modul už v aktuálním přehledu není. Obnovte Launchpad a zkuste to znovu.",
  });
});

test("odmítne Organization mount, jehož realpath uniká mimo Conglomerate root", async () => {
  const root = join(import.meta.dir, `.tmp-module-folder-${crypto.randomUUID()}`);
  tempRoots.push(root);
  const companiesRoot = join(root, "conglomerate");
  const outsideOrganization = join(root, "outside-org");
  await mkdir(join(companiesRoot, "organizations"), { recursive: true });
  await mkdir(join(outsideOrganization, "workspace", "presentation"), { recursive: true });
  await symlink(outsideOrganization, join(companiesRoot, "organizations", "Escaped_GEN3"));
  let spawnCount = 0;
  const opener = createModuleFolderOpener({
    companiesRoot,
    getAppsResponse: async () => ({
      organizations: [{
        slug: "Escaped",
        path: "organizations/Escaped_GEN3",
        workspaces: [{
          slug: "workspace",
          modules: [{ slug: "presentation", path: "workspace/presentation", status: "available" }],
        }],
      }],
    }),
    spawnCommand: async () => {
      spawnCount += 1;
      return { ok: true };
    },
  });

  await expect(opener.open({ organization: "Escaped", modulePath: "workspace/presentation" })).rejects.toMatchObject({
    status: 403,
    code: "module_path_forbidden",
  });
  expect(spawnCount).toBe(0);
});

test("používá bezpečné systémové příkazy bez shellové interpolace", () => {
  expect(folderOpenCommand("darwin", "/tmp/demo")).toEqual(["/usr/bin/open", "/tmp/demo"]);
  expect(folderOpenCommand("win32", "C:\\demo", { SystemRoot: "C:\\Windows" })).toEqual([
    "C:\\Windows\\explorer.exe",
    "C:\\demo",
  ]);
  expect(() => folderOpenCommand("win32", "C:\\demo", { PATH: "C:\\fake-bin" }))
    .toThrow("SystemRoot/WINDIR");
  expect(folderOpenCommand("linux", "/tmp/demo", { PATH: "/tmp/fake-bin" })).toEqual([
    "/usr/bin/xdg-open",
    "/tmp/demo",
  ]);
  expect(folderOpenCommand("freebsd", "/tmp/demo")).toBeNull();
});
