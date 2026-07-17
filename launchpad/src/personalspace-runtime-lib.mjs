// Personalspace runtime + API response (CAC-0048).
//
// Spojuje personalspace discovery lane (personalspace-lib.mjs) s runtime
// engine (runtime-lib.mjs) přes injektovanou discovery funkci a produkuje
// odpověď pro /api/personalspace. Osobní aplikace tak dostanou stejné runtime
// akce jako firemní (install/start/stop/restart/logs), ale zůstávají v úplně
// oddělené lane a nesou Private surface příznaky.
//
// PRIVÁTNÍ HRANICE: tato odpověď je určená jen lokálnímu Launchpad UI. Nikdy se
// nesmí propsat do org discovery (/api/apps), doctor shared reportu ani templates.
// Doctor personalspace check reportuje jen METADATA (počty, validitu), nikdy obsah.

import { join } from "path";
import { discoverPersonalspace } from "./personalspace-lib.mjs";
import { GbrainAccessError } from "./gbrain-lib.mjs";
import { createRuntimeManager } from "./runtime-lib.mjs";

// Bezpečně vyresolvuje absolutní cestu ke gbrain vaultu daného prostoru přes
// discovery (žádná cesta z klienta se nedůvěřuje — space se hledá podle
// dir_name v objevených prostorech). Vrací i metadata o zdroji (mode, name).
// Fail-closed: neznámý/nevalidní prostor nebo chybějící vault → GbrainAccessError.
export async function resolveSpaceGbrainVault({ companiesRoot, spaceDirName }) {
  const discovery = await discoverPersonalspace(companiesRoot);
  const space = discovery.spaces.find((item) => item.dir_name === spaceDirName);
  if (!space) {
    throw new GbrainAccessError(404, "space_not_found", "Osobní prostor nebyl nalezen.");
  }
  if (!space.config_valid) {
    throw new GbrainAccessError(409, "space_invalid", "Osobní prostor má nevalidní config nebo porušený identity invariant; gbrain je nedostupný.");
  }
  // Boundary gate per decision 0051: sdílení super-repa NEsdílí gbrain. Gbrain je
  // defaultně privátní (access jen pár Kolega ↔ jeho Buddy) a nasdílení jinému
  // člověku je vědomé explicitní rozhodnutí vlastníka. Nasdílený (ne-primární)
  // prostor s default_shared === false proto browse API odmítá fail-closed —
  // i kdyby jeho vault byl lokálně namountovaný. Tuto hranici vynucuje kód, ne
  // jen informativní UI hláška.
  if (!space.is_owner_primary && space.gbrain?.default_shared === false) {
    throw new GbrainAccessError(
      403,
      "gbrain_not_shared",
      "gbrain tohoto nasdíleného prostoru není sdílený; procházení vyžaduje vědomé explicitní rozhodnutí vlastníka (decision 0051).",
    );
  }
  if (!space.gbrain?.exists) {
    throw new GbrainAccessError(404, "vault_not_found", "gbrain vault pro tento prostor není lokálně dostupný.");
  }
  return {
    vaultRoot: join(companiesRoot, space.gbrain.source_rel),
    source_rel: space.gbrain.source_rel,
    mode: space.gbrain.mode,
    default_shared: space.gbrain.default_shared,
    human_editor: space.gbrain.human_editor,
  };
}

// Adaptér: discovery ve tvaru, který runtime-lib očekává
// ({ apps, invalid_apps, failures }). Apps mají id = personal runtime id.
function personalspaceDiscoveryAdapter(companiesRoot) {
  return async () => {
    const discovery = await discoverPersonalspace(companiesRoot);
    return {
      apps: discovery.apps,
      invalid_apps: discovery.invalid_apps,
      failures: discovery.failures,
      warnings: discovery.warnings,
    };
  };
}

// Sdílený personalspace runtime manager per companiesRoot. Používá stejné
// runtime/logs adresáře jako org lane — díky prefixovanému id (personal--…) se
// stav/logy nekříží.
export function createPersonalspaceRuntimeManager({ companiesRoot, launchpadRoot }) {
  return createRuntimeManager({
    companiesRoot,
    launchpadRoot,
    discover: personalspaceDiscoveryAdapter(companiesRoot),
  });
}

export async function buildPersonalspaceResponse({
  companiesRoot = join(import.meta.dirname, "..", ".."),
  launchpadRoot = join(import.meta.dirname, ".."),
  runtimeManager = createPersonalspaceRuntimeManager({ companiesRoot, launchpadRoot }),
  profileEmail = null,
} = {}) {
  const discovery = await discoverPersonalspace(companiesRoot);

  const appsWithRuntime = await runtimeManager.appsWithRuntime(
    discovery.apps.map((app) => ({
      ...app,
      url: app.host && app.port ? `http://${app.host}:${app.port}` : null,
      health_url: app.host && app.port && app.health_path ? `http://${app.host}:${app.port}${app.health_path}` : null,
    })),
  );
  const appsBySpace = new Map();
  for (const app of appsWithRuntime) {
    if (!appsBySpace.has(app.space)) appsBySpace.set(app.space, []);
    appsBySpace.get(app.space).push(app);
  }

  const invalidApps = (discovery.invalid_apps ?? []).map((app) => ({
    ...app,
    url: null,
    health_url: null,
    dependencies: {
      state: "invalid_manifest",
      message: `Manifest osobní aplikace není validní: ${(app.manifest_issues ?? []).join("; ")}`,
      can_start: false,
      can_install: false,
    },
    dependency_status: "invalid_manifest",
    runtime: {
      status: "stopped",
      message: "Osobní aplikace s nevalidním manifestem se nespouští; oprav companyascode.app manifest.",
    },
    runtime_status: "stopped",
  }));
  for (const app of invalidApps) {
    if (!appsBySpace.has(app.space)) appsBySpace.set(app.space, []);
    appsBySpace.get(app.space).push(app);
  }

  const spaces = discovery.spaces.map((space) => ({
    ...space,
    apps: appsBySpace.get(space.dir_name) ?? [],
  }));

  const totalApps = appsWithRuntime.length;
  const primarySpace = spaces.find((space) => space.is_owner_primary && space.config_valid);
  return {
    schema_version: "companiesascode.launchpad.personalspace.v1",
    generated_at: new Date().toISOString(),
    mountpoint: discovery.mountpoint,
    primary_owner: discovery.primary_owner,
    ok: discovery.failures.length === 0,
    summary: {
      space_count: spaces.length,
      valid_space_count: spaces.filter((space) => space.config_valid).length,
      app_count: totalApps,
      invalid_app_count: invalidApps.length,
      failure_count: discovery.failures.length,
      warning_count: discovery.warnings.length,
    },
    profile: primarySpace
      ? {
          display_name: primarySpace.display_name,
          email: normalizeProfileEmail(profileEmail),
          github_username: primarySpace.owner,
          avatar_url: `https://github.com/${encodeURIComponent(primarySpace.owner)}.png?size=128`,
          settings_url: "https://github.com/settings/profile",
        }
      : null,
    spaces,
    failures: discovery.failures,
    warnings: discovery.warnings,
    // Privátní UX-only diagnostika. Doctor ji záměrně nikdy nečte.
    presentation_warnings: discovery.presentation_warnings ?? [],
  };
}

function normalizeProfileEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim();
  if (email.length === 0 || email.length > 254 || /\s/.test(email) || !email.includes("@")) return null;
  return email;
}

// Doctor check pro personalspace — METADATA ONLY. Nikdy nečte obsah osobních
// modulů ani gbrain zápisů; reportuje jen počty prostorů/aplikací, validitu
// configu, identity invariant a gbrain mount stav. Chybějící personalspace =
// skip (ne každá mašina má osobní prostor namountovaný).
export function personalspaceDoctorCheck(personalspaceResponse) {
  const spaces = personalspaceResponse.spaces ?? [];
  const failures = personalspaceResponse.failures ?? [];
  const warnings = personalspaceResponse.warnings ?? [];
  if (spaces.length === 0 && failures.length === 0 && warnings.length === 0) {
    return {
      id: "launchpad.personalspace",
      status: "skip",
      severity: "local-state",
      title: "Personalspace",
      message: "Na této mašině není namountovaný žádný osobní prostor.",
      paths: [personalspaceResponse.mountpoint ?? "personalspace"],
      links: [],
      details: [],
    };
  }
  const invalidSpaces = spaces.filter((space) => !space.config_valid);
  const details = [];
  for (const space of spaces) {
    const role = space.is_owner_primary ? "primární" : "nasdílený";
    if (!space.config_valid) {
      details.push(`${space.mount_path}: NEVALIDNÍ (${(space.config_issues ?? []).join("; ")})`);
      continue;
    }
    const summary = space.module_summary ?? {};
    const gbrain = space.gbrain?.exists ? `gbrain ${space.gbrain.mode}` : "gbrain nedostupný";
    const gbrainCustody = space.gbrain?.repository?.visibility === "private"
      ? "gbrain repo deklarováno private"
      : "gbrain repo privacy neověřena";
    details.push(
      `${space.mount_path}: ${role}, aplikací ${space.apps?.length ?? 0}, moduly available ${summary.available ?? 0}/missing_access ${summary.missing_access ?? 0}/planned_slot ${summary.planned_slot ?? 0}, ${gbrain}, ${gbrainCustody}`,
    );
  }
  if (warnings.length) {
    details.push(...warnings.map((warning) => `warning: ${warning}`));
  }
  if (failures.length) {
    details.push(...failures.map((failure) => `failure: ${failure}`));
  }
  const status = failures.length > 0 || invalidSpaces.length > 0
    ? "fail"
    : warnings.length > 0
      ? "warn"
      : "ok";
  return {
    id: "launchpad.personalspace",
    status,
    severity: "local-state",
    title: "Personalspace",
    message:
      status === "ok"
        ? `Personalspace: ${spaces.length} prostor(ů), ${personalspaceResponse.summary?.app_count ?? 0} osobních aplikací (jen metadata).`
        : status === "warn"
          ? `Personalspace má ${warnings.length} varování (jen metadata).`
          : `Personalspace má nevalidní prostor nebo porušený identity invariant.`,
    paths: [personalspaceResponse.mountpoint ?? "personalspace"],
    links: [],
    details,
  };
}
