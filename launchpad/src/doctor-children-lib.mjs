// Root-side lane společného surfacu doctorů (decision 0118 v
// Rozjedeme-ai/HumanAndMachines).
//
// PROČ TENHLE SOUBOR EXISTUJE. Doctor není jeden program. Root doctor v kořeni
// Conglomerate nese *standardizované* kontroly, které platí pro každý checkout;
// každé namountované repo — Organizace, Personalspace — si nese **vlastní
// nezávislý doctor**, který root najde a zavolá. Důvod je vlastnický, ne
// technický: pull sdíleného rootu nesmí rozbít Organizaci, která má vlastní
// konfiguraci. Vlastní kontrola patří do vlastního repa, standardizovaná do
// standardizovaného kořene (totéž pravidlo drží decision 0018 a 0031).
//
// CO TAHLE LANE DĚLÁ. Projde mountpointy `organizations/` a `personalspace/`,
// přečte v jejich manifestu blok `doctor`, spustí každý deklarovaný doctor jako
// PROCES a klasifikuje, co rodič skutečně dostal. Agregace pak počítá z
// **vnořených reportů**, nikdy z toho, co dítě řeklo o sobě ve vlastním souhrnu.
//
// CO TAHLE LANE NEDĚLÁ. Nehádá cestu. Konvenční `scripts/doctor.mjs` by
// nefungovala pro mount, který není Node projekt, a z chybějícího doctora by
// udělala ticho místo vady — proto discovery jede z deklarace v manifestu.
//
// KONKRÉTNÍ SCÉNÁŘ. Organizace si do `company.gen3.json` napíše vlastní doctor,
// který hlídá její vlastní datový repozitář. Za měsíc někdo přejmenuje skript a
// deklaraci zapomene. Bez téhle lane by `bun run doctor` v rootu doběhl zeleně —
// root o té kontrole nikdy nevěděl, takže by nemohl ani zmlknout. S ní vznikne
// `doctor.child.0` s `fail`, konec stderru dítěte a přesné argv, kterým to root
// zkusil: „Podřízený doctor deklarovaný v organizations/ExampleOrg_GEN3/
// company.gen3.json nevrátil žádný report."

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { readJson } from "./discovery-lib.mjs";
import {
  DOCTOR_DECLARATION_SCHEMA_VERSION,
  readDoctorDeclaration,
  runChildDoctor,
} from "./doctor-surface-lib.mjs";

const DEFAULT_ORGANIZATION_MOUNTPOINT = "organizations";
const DEFAULT_PERSONALSPACE_MOUNTPOINT = "personalspace";

// Adresáře, které nejsou mount. `.worktrees` schválně: worktree je druhý checkout
// TÉHOŽ repa a jeho doctor by se spustil podruhé na stejný manifest.
const IGNORED_MOUNT_DIRS = new Set([
  ".git",
  ".worktrees",
  "node_modules",
  "backups",
  "secrets",
]);

export const CHILDREN_CHECK_ID = "doctor.children";

// Shodné s `doctor.timeout_ms.minimum` v `schemas/personal.gen3.schema.json`.
// `company.gen3.json` se v tomhle repu proti schématu nevaliduje (jeho schéma
// vlastní HumanAndMachines), takže pro org mounty je tahle mez JEDINÝ vynucený
// zdroj — proto se kontroluje tady, ne jen v manifestovém schématu.
export const MIN_CHILD_TIMEOUT_MS = 1000;

/**
 * Najde deklarované podřízené doctory. Vrací i mounty, jejichž manifest se
 * nepodařilo přečíst — nepřečtený manifest není „žádná deklarace", je to
 * nepozorování a lane ho hlásí jako `blocked`.
 */
export async function discoverChildDoctors({ companiesRoot, companiesConfig = null } = {}) {
  const organizationMountpoint =
    companiesConfig?.organization_mountpoint ?? DEFAULT_ORGANIZATION_MOUNTPOINT;
  const personalspaceMountpoint =
    companiesConfig?.personalspace_mountpoint ?? DEFAULT_PERSONALSPACE_MOUNTPOINT;

  const declarations = [];
  const unreadableManifests = [];
  const invalidDeclarations = [];
  let scannedMounts = 0;

  const lanes = [
    { mountpoint: organizationMountpoint, manifest: "company.gen3.json", scopeKind: "organization" },
    { mountpoint: personalspaceMountpoint, manifest: "personal.gen3.json", scopeKind: "personalspace" },
  ];

  for (const lane of lanes) {
    const laneRoot = join(companiesRoot, lane.mountpoint);
    if (!existsSync(laneRoot)) continue;
    let entries;
    try {
      entries = await readdir(laneRoot, { withFileTypes: true });
    } catch (error) {
      unreadableManifests.push(`${lane.mountpoint}: mountpoint nejde přečíst (${error.message})`);
      continue;
    }
    const dirNames = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !IGNORED_MOUNT_DIRS.has(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const dirName of dirNames) {
      const mountPath = join(laneRoot, dirName);
      const declarationPath = join(mountPath, lane.manifest);
      if (!existsSync(declarationPath)) continue;
      scannedMounts += 1;
      let manifest;
      try {
        manifest = await readJson(declarationPath);
      } catch (error) {
        unreadableManifests.push(
          `${lane.mountpoint}/${dirName}/${lane.manifest}: nejde přečíst (${error.message})`,
        );
        continue;
      }
      const declaration = readDoctorDeclaration(manifest);
      if (!declaration) continue;
      const issues = declarationIssues(declaration);
      if (issues.length > 0) {
        invalidDeclarations.push({
          declarationPath,
          mountPath,
          relativeDeclarationPath: `${lane.mountpoint}/${dirName}/${lane.manifest}`,
          relativeMountPath: `${lane.mountpoint}/${dirName}`,
          issues,
        });
        continue;
      }
      declarations.push({
        declarationPath,
        mountPath,
        relativeDeclarationPath: `${lane.mountpoint}/${dirName}/${lane.manifest}`,
        relativeMountPath: `${lane.mountpoint}/${dirName}`,
        scopeKind: lane.scopeKind,
        declaration,
      });
    }
  }

  return { declarations, invalidDeclarations, unreadableManifests, scannedMounts };
}

/**
 * Tvar deklarace. Rozbitá deklarace se NEIGNORUJE — mount, který si napsal
 * `doctor` blok, chtěl být svolán, a tichý přeskok by z jeho překlepu udělal
 * zelenou.
 */
export function declarationIssues(declaration) {
  const issues = [];
  if (
    declaration.schema_version !== undefined
    && declaration.schema_version !== DOCTOR_DECLARATION_SCHEMA_VERSION
  ) {
    issues.push(
      `doctor.schema_version musí být "${DOCTOR_DECLARATION_SCHEMA_VERSION}", je `
      + `${JSON.stringify(declaration.schema_version)}`,
    );
  }
  if (!Array.isArray(declaration.command) || declaration.command.length === 0) {
    issues.push("doctor.command musí být neprázdné pole argv (argv[0] je spustitelný soubor)");
  } else if (declaration.command.some((item) => typeof item !== "string" || item.trim() === "")) {
    issues.push("doctor.command smí obsahovat jen neprázdné texty");
  }
  if (declaration.cwd !== undefined && (typeof declaration.cwd !== "string" || declaration.cwd.trim() === "")) {
    issues.push("doctor.cwd musí být neprázdný text relativní k mountu");
  }
  // Dolní mez je stejná jako v manifestovém schématu: timeout pod sekundu by
  // vypršel dřív, než se stihne nastartovat runtime, a z každého potomka by
  // udělal `timeout` — tedy vadu tam, kde žádná není.
  if (
    declaration.timeout_ms !== undefined
    && (!Number.isInteger(declaration.timeout_ms) || declaration.timeout_ms < MIN_CHILD_TIMEOUT_MS)
  ) {
    issues.push(`doctor.timeout_ms musí být celé číslo alespoň ${MIN_CHILD_TIMEOUT_MS}`);
  }
  if (
    declaration.scope_type !== undefined
    && (typeof declaration.scope_type !== "string" || declaration.scope_type.trim() === "")
  ) {
    issues.push("doctor.scope_type musí být neprázdný text");
  }
  return issues;
}

/**
 * Spustí všechny deklarované podřízené doctory a vrátí `children[]` v tvaru
 * surfacu plus jednu vlastní kontrolu rodiče o tom, jak lane dopadla.
 *
 * `enabled: false` NENÍ tichý vypínač: lane se ohlásí jako `blocked`, protože
 * nespuštěný doctor je nepozorování, ne fakt. Zelenou proto pokazí vždy.
 */
export async function runChildDoctorLane({
  companiesRoot,
  companiesConfig = null,
  schema,
  enabled = true,
  runChild = runChildDoctor,
} = {}) {
  if (!enabled) {
    return {
      children: [],
      checks: [
        {
          id: CHILDREN_CHECK_ID,
          status: "blocked",
          severity: "required",
          title: "Podřízené doctory",
          message: "Podřízené doctory se v tomhle běhu nespouštěly.",
          paths: ["organizations", "personalspace"],
          links: [],
          details: [],
          blocked_reason:
            "Lane podřízených doctorů byla pro tenhle běh vypnutá, takže o mountech nevíme nic.",
          remedy: "Spusť `bun run doctor` bez přepínače `--skip-children`.",
        },
      ],
    };
  }

  const discovered = await discoverChildDoctors({ companiesRoot, companiesConfig });
  const children = [];

  for (const invalid of discovered.invalidDeclarations) {
    children.push({
      declaration_path: invalid.relativeDeclarationPath,
      mount_path: invalid.relativeMountPath,
      invoked_command: ["<nespuštěno>"],
      outcome: "spawn_failed",
      failures: [
        `Blok 'doctor' v manifestu není validní deklarace: ${invalid.issues.join("; ")}`,
      ],
    });
  }

  for (const entry of discovered.declarations) {
    children.push(
      runChild({
        root: companiesRoot,
        declarationPath: entry.declarationPath,
        mountPath: entry.mountPath,
        declaration: entry.declaration,
        schema,
        // Očekávaný druh scope určuje lane, ve které mount leží, ne dítě a ne jeho
        // manifest. Bez tohohle svázání by mount pod `organizations/` mohl vrátit
        // platný v3 report typu `workspace` a root by ho přijal jako svůj.
        expectedScopeType: entry.scopeKind,
      }),
    );
  }

  return {
    children,
    checks: [childrenLaneCheck({ discovered, children })],
  };
}

function childrenLaneCheck({ discovered, children }) {
  const paths = ["organizations", "personalspace"];
  const declaredCount = discovered.declarations.length + discovered.invalidDeclarations.length;
  const reportingCount = children.filter((child) => child.outcome === "report").length;
  const details = [
    `scanned_mounts: ${discovered.scannedMounts}`,
    `declared_doctors: ${declaredCount}`,
    `reported: ${reportingCount}`,
    `defective: ${children.length - reportingCount}`,
    ...children.map(
      (child) => `${child.outcome}: ${child.declaration_path} (${child.invoked_command.join(" ")})`,
    ),
  ];

  // Nepřečtený manifest je nepozorování, ne fakt: nevíme, jestli deklaraci nese.
  // Musí proto kazit zelenou i tehdy, když všechny ostatní mounty odpověděly.
  if (discovered.unreadableManifests.length > 0) {
    return {
      id: CHILDREN_CHECK_ID,
      status: "blocked",
      severity: "required",
      title: "Podřízené doctory",
      message:
        `${discovered.unreadableManifests.length} manifestů nejde přečíst, takže o jejich `
        + "podřízeném doctorovi nevíme nic.",
      paths,
      links: [],
      details: [...discovered.unreadableManifests, ...details],
      blocked_reason: "Manifest mountu nejde přečíst, deklarace 'doctor' se z něj nedá zjistit.",
      remedy: "Oprav JSON manifestu mountu a spusť doctor znovu.",
    };
  }

  if (declaredCount === 0) {
    return {
      id: CHILDREN_CHECK_ID,
      status: "not_applicable",
      severity: "required",
      title: "Podřízené doctory",
      message: `Žádný z ${discovered.scannedMounts} mountů nedeklaruje vlastní doctor.`,
      paths,
      links: [],
      details: [
        ...details,
        "Deklarace se píše do bloku 'doctor' v company.gen3.json / personal.gen3.json.",
        "Kontrakt: launchpad/schemas/doctor-report.schema.json",
      ],
      not_applicable_reason: "not_declared",
      owner: "namountovaná repa (vlastní doctor deklaruje jejich manifest, ne root)",
    };
  }

  return {
    id: CHILDREN_CHECK_ID,
    status: "ok",
    severity: "required",
    title: "Podřízené doctory",
    message:
      `${reportingCount} z ${declaredCount} deklarovaných podřízených doctorů vrátilo `
      + "validní report.",
    paths,
    links: [],
    details,
  };
}
