import { constants } from "fs";
import { access, realpath, stat } from "fs/promises";
import { isAbsolute, relative, resolve, win32 } from "path";

export class ModuleFolderActionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ModuleFolderActionError";
    this.status = status;
    this.code = code;
  }
}

const supportedModuleSpaces = new Set(["root", "workspace", "productionspace"]);

/**
 * Action contract:
 * - intent: otevřít lokálně dostupný checkout modulu v systémovém správci souborů;
 * - source of truth: organization/module discovery z company.gen3.json a modules.manifest.json;
 * - preconditions: Organizace i modul existují, modul je available a reálná cesta zůstává uvnitř Organizace;
 * - side effect: spustí pouze lokální Finder/Explorer/xdg-open, soubory ani Git stav nemění;
 * - failure mode: strukturovaná 4xx chyba pro neplatný/nedostupný scope, 500 při selhání systémového openeru;
 * - access boundary: server route je local-only a z klienta přijímá jen deklarované identifikátory, ne libovolnou cestu;
 * - verification: úspěšná odpověď vrací action, organization a relativní module_path.
 */
export function createModuleFolderOpener({
  companiesRoot,
  getAppsResponse,
  platform = process.platform,
  env = process.env,
  spawnCommand = runCommand,
  accessExecutable = verifyExecutable,
}) {
  return {
    async open({ organization: organizationSlug, modulePath, space = null }) {
      if (typeof organizationSlug !== "string" || !organizationSlug.trim()) {
        throw new ModuleFolderActionError(400, "organization_required", "Chybí Organizace modulu.");
      }
      if (typeof modulePath !== "string" || !modulePath.trim()) {
        throw new ModuleFolderActionError(400, "module_path_required", "Chybí cesta modulu.");
      }
      if (space !== null && !supportedModuleSpaces.has(space)) {
        throw new ModuleFolderActionError(400, "module_space_invalid", "Neplatný typ modulu.");
      }

      const response = await getAppsResponse();
      const organizations = response.organizations ?? response.companies ?? [];
      const organization = organizations.find((item) => item.slug === organizationSlug);
      if (!organization?.path) {
        throw new ModuleFolderActionError(
          404,
          "organization_not_found",
          "Tento pracovní prostor už není dostupný. Obnovte Launchpad a zkuste to znovu.",
        );
      }
      const declaredModule = declaredModules(organization).find(
        (item) => item.module.path === modulePath && (space === null || item.space === space),
      );
      if (!declaredModule) {
        throw new ModuleFolderActionError(
          404,
          "module_not_found",
          "Tento modul už v aktuálním přehledu není. Obnovte Launchpad a zkuste to znovu.",
        );
      }
      const { module, space: moduleSpace } = declaredModule;
      if (module.status !== "available") {
        throw new ModuleFolderActionError(
          409,
          "module_folder_unavailable",
          module.status === "missing_access"
            ? "Repozitář tohoto modulu není na tomto počítači dostupný. Přístup určuje GitHub."
            : module.status === "planned_slot"
              ? "Tento modul je zatím naplánovaný a nemá lokální složku."
              : "Lokální složka tohoto modulu zatím není dostupná.",
        );
      }

      const realCompaniesRoot = await realpath(companiesRoot).catch(() => null);
      const organizationRoot = await realpath(resolve(companiesRoot, organization.path)).catch(() => null);
      const organizationRelativePath = realCompaniesRoot && organizationRoot
        ? relative(realCompaniesRoot, organizationRoot)
        : "";
      if (
        !realCompaniesRoot
        || !organizationRoot
        || !organizationRelativePath
        || !isWithin(realCompaniesRoot, organizationRoot)
      ) {
        throw new ModuleFolderActionError(403, "module_path_forbidden", "Cesta Organizace není bezpečně uvnitř Conglomerate rootu.");
      }
      const moduleRoot = await realpath(resolve(organizationRoot, module.path)).catch(() => null);
      if (!moduleRoot || !isWithin(organizationRoot, moduleRoot)) {
        throw new ModuleFolderActionError(403, "module_path_forbidden", "Cesta modulu není bezpečně uvnitř Organizace.");
      }
      const moduleStats = await stat(moduleRoot).catch(() => null);
      if (!moduleStats?.isDirectory()) {
        throw new ModuleFolderActionError(409, "module_folder_unavailable", "Lokální složka modulu není dostupná.");
      }

      const command = folderOpenCommand(platform, moduleRoot, env);
      if (!command) {
        throw new ModuleFolderActionError(501, "folder_open_unsupported", "Otevírání složek na této platformě není podporované.");
      }
      try {
        await accessExecutable(command[0], platform);
      } catch {
        throw new ModuleFolderActionError(
          501,
          "folder_open_unavailable",
          "Ověřený systémový program pro otevření složky není dostupný.",
        );
      }
      const result = await spawnCommand(command);
      if (!result.ok) {
        throw new ModuleFolderActionError(500, "folder_open_failed", "Systémovou složku se nepodařilo otevřít.");
      }
      return {
        action: "open_module_folder",
        organization: organization.slug,
        module: module.slug,
        module_path: module.path,
        space: moduleSpace,
      };
    },
  };
}

function declaredModules(organization) {
  const workspaceGroups = Array.isArray(organization.teams) && organization.teams.length > 0
    ? organization.teams
    : Array.isArray(organization.workspaces)
      ? organization.workspaces
      : [];
  const entries = [
    ...(organization.organization_modules ?? []).map((module) => ({ module, space: "root" })),
    ...workspaceGroups.flatMap((workspace) =>
      (workspace.modules ?? []).map((module) => ({ module, space: "workspace" }))),
    ...(organization.productionspace?.systems ?? []).map((module) => ({ module, space: "productionspace" })),
  ];
  const unique = new Map();
  for (const entry of entries) {
    if (!entry.module?.path) continue;
    unique.set(`${entry.space}:${entry.module.path}`, entry);
  }
  return [...unique.values()];
}

export function folderOpenCommand(platform, path, env = process.env) {
  if (platform === "darwin") return ["/usr/bin/open", path];
  if (platform === "win32") {
    const systemRoot = env.SystemRoot ?? env.WINDIR;
    if (!systemRoot || !win32.isAbsolute(systemRoot)) {
      throw new Error("SystemRoot/WINDIR musí být absolutní pro bezpečné spuštění explorer.exe.");
    }
    return [win32.join(systemRoot, "explorer.exe"), path];
  }
  if (platform === "linux") return ["/usr/bin/xdg-open", path];
  return null;
}

function isWithin(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function runCommand(command) {
  try {
    const child = Bun.spawn(command, {
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
    return { ok: (await child.exited) === 0 };
  } catch {
    return { ok: false };
  }
}

async function verifyExecutable(executable, platform) {
  await access(executable, platform === "win32" ? constants.F_OK : constants.X_OK);
}
