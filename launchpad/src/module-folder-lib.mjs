import { realpath, stat } from "fs/promises";
import { isAbsolute, relative, resolve, win32 } from "path";

export class ModuleFolderActionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ModuleFolderActionError";
    this.status = status;
    this.code = code;
  }
}

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
}) {
  return {
    async open({ organization: organizationSlug, modulePath }) {
      if (typeof organizationSlug !== "string" || !organizationSlug.trim()) {
        throw new ModuleFolderActionError(400, "organization_required", "Chybí Organizace modulu.");
      }
      if (typeof modulePath !== "string" || !modulePath.trim()) {
        throw new ModuleFolderActionError(400, "module_path_required", "Chybí cesta modulu.");
      }

      const response = await getAppsResponse();
      const organizations = response.organizations ?? response.companies ?? [];
      const organization = organizations.find((item) => item.slug === organizationSlug);
      if (!organization?.path) {
        throw new ModuleFolderActionError(404, "organization_not_found", "Organizace už není v Launchpadu dostupná.");
      }
      const modules = (organization.workspaces ?? []).flatMap((workspace) => workspace.modules ?? []);
      const module = modules.find((item) => item.path === modulePath);
      if (!module) {
        throw new ModuleFolderActionError(404, "module_not_found", "Modul už není v Organizaci deklarovaný.");
      }
      if (module.status !== "available") {
        throw new ModuleFolderActionError(
          409,
          "module_folder_unavailable",
          module.status === "missing_access"
            ? "Složku modulu nelze otevřít, protože checkout není na tomto počítači dostupný."
            : "Složku modulu zatím nelze otevřít.",
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
      const result = await spawnCommand(command);
      if (!result.ok) {
        throw new ModuleFolderActionError(500, "folder_open_failed", "Systémovou složku se nepodařilo otevřít.");
      }
      return {
        action: "open_module_folder",
        organization: organization.slug,
        module: module.slug,
        module_path: module.path,
      };
    },
  };
}

export function folderOpenCommand(platform, path, env = process.env) {
  if (platform === "darwin") return ["/usr/bin/open", path];
  if (platform === "win32") {
    const systemRoot = env.SystemRoot ?? env.WINDIR;
    return [systemRoot ? win32.join(systemRoot, "explorer.exe") : "explorer.exe", path];
  }
  if (platform === "linux") return ["xdg-open", path];
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
