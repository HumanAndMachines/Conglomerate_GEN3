import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "fs/promises";
import { join } from "path";
import { createModuleFolderOpener, folderOpenCommand } from "./module-folder-lib.mjs";

const tempRoots = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("otevře jen dostupný deklarovaný modul uvnitř Organizace", async () => {
  const root = join(import.meta.dir, `.tmp-module-folder-${crypto.randomUUID()}`);
  tempRoots.push(root);
  const moduleRoot = join(root, "organizations", "Demo_GEN3", "workspace", "presentation");
  await mkdir(moduleRoot, { recursive: true });
  const commands = [];
  const opener = createModuleFolderOpener({
    companiesRoot: root,
    platform: "darwin",
    spawnCommand: async (command) => {
      commands.push(command);
      return { ok: true };
    },
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
  });

  await expect(opener.open({ organization: "Demo", modulePath: "workspace/presentation" })).resolves.toMatchObject({
    action: "open_module_folder",
    organization: "Demo",
    module: "presentation",
    module_path: "workspace/presentation",
  });
  expect(commands).toEqual([["/usr/bin/open", moduleRoot]]);
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
  });
  await expect(opener.open({ organization: "Demo", modulePath: "escaped" })).rejects.toMatchObject({
    status: 403,
    code: "module_path_forbidden",
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
  expect(folderOpenCommand("win32", "C:\\demo", {})).toEqual(["explorer.exe", "C:\\demo"]);
  expect(folderOpenCommand("linux", "/tmp/demo")).toEqual(["xdg-open", "/tmp/demo"]);
  expect(folderOpenCommand("freebsd", "/tmp/demo")).toBeNull();
});
