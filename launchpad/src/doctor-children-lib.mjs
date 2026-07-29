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
// PROČ TU BYDLÍ SVÁZÁNÍ IDENTITY. Vendorovaný surface je bajt na bajt kopie
// z HumanAndMachines (`schemas/doctor-surface-vendor.json`) a musí vyhovět i
// doctorovi, který běží SÁM — na Buddy VPS nad personalspace doctorem žádný
// rodič není, takže po něm nikdo nemůže chtít, aby dokazoval, čí zdraví hlásí.
// Root ale dítě spustil kvůli konkrétnímu mountu, takže si tu povinnost přidává
// sám: `runBoundChildDoctor` níž. Je to politika rootu, ne kontrakt všech
// doctorů; kdyby seděla ve vendorované kopii, byl by z ní fork surfacu.
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
  DOCTOR_REPORT_SCHEMA_VERSION_V3,
  exitCodeForSummaryStatus,
  flattenChecks,
  readDoctorDeclaration,
  runChildDoctor,
  summarizeStatus,
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

function tail(text, limit = 2000) {
  const value = String(text ?? "");
  return value.length > limit ? value.slice(value.length - limit) : value;
}

function demoteToScopeMismatch(child, failure) {
  const evidence = child.report === undefined ? "" : tail(JSON.stringify(child.report));
  delete child.report;
  child.outcome = "scope_mismatch";
  if (evidence !== "") child.stdout_tail = evidence;
  child.failures.push(failure);
  return child;
}

/**
 * ROOT-SIDE VÁZÁNÍ IDENTITY. Surface povinně porovnává jen to, co dítě samo
 * nabídlo: když `scope.absolute_path` chybí, není co porovnat, a dokud deklarace
 * mlčí o `scope_type`, není proti čemu vázat druh scope. To je pro samostatně
 * běžícího doctora správně — na Buddy VPS nad ním žádný rodič není a nemá koho
 * přesvědčovat. Root ho ale spustil KVŮLI KONKRÉTNÍMU MOUNTU, takže si tu
 * povinnost přidává sám, a přidává si ji tady: je to jeho politika, ne kontrakt
 * všech doctorů, a ve vendorované kopii surfacu by z ní byl fork.
 *
 * Bez téhle vazby stačí vrátit platný v3 report o ČEMKOLI a root pod tímhle
 * mountem ohlásí zdraví cizího checkoutu. Druh scope proto určuje LANE, ve které
 * mount leží (`organizations/` → `organization`, `personalspace/` →
 * `personalspace`); deklarace ho smí potvrdit, nikdy přepsat.
 */
export function bindChildScope(child, { expectedScopeType } = {}) {
  if (child?.outcome !== "report") return child;
  const scope = child.report?.scope ?? {};
  const reportedPath = scope.absolute_path;
  if (typeof reportedPath !== "string" || reportedPath.trim() === "") {
    return demoteToScopeMismatch(
      child,
      "Podřízený doctor nehlásí 'scope.absolute_path', takže jeho report se nedá svázat s "
      + "mountem, ve kterém ho root spustil. Nevázaný report se do agregace nepočítá.",
    );
  }
  if (scope.type !== expectedScopeType) {
    return demoteToScopeMismatch(
      child,
      `Mount leží v lane '${expectedScopeType}', ale report hlásí scope.type '${scope.type}'.`,
    );
  }
  return child;
}

/**
 * Očekávaný exit kód se počítá z CELÉHO reportu, tedy i z checks vnořených vnuků.
 * Surface ho počítá z `report.checks`, protože sám o vnucích nic netvrdí; dítě,
 * které je samo rootem, ale končí podle svého AGREGÁTU — vlastní `ok` s
 * zablokovaným vnukem je `incomplete` a dvojka je správně. Bez tohohle přepočtu
 * by mu rodič za správný exit kód vystavil falešný `doctor.child.N.exit_code`.
 */
export function rebindChildExitExpectation(child) {
  if (child?.outcome !== "report") return child;
  if (child.report?.schema_version !== DOCTOR_REPORT_SCHEMA_VERSION_V3) return child;
  const expected = exitCodeForSummaryStatus(summarizeStatus(flattenChecks(child.report)));
  if (Number.isInteger(child.exit_code) && child.exit_code !== expected) {
    child.exit_code_mismatch = expected;
  } else {
    delete child.exit_code_mismatch;
  }
  return child;
}

/**
 * Spustí jeden podřízený doctor přes surface a sváže ho s mountem, ve kterém ho
 * root našel. Volající, který očekávaný druh scope nepředá, nedostane volnější
 * kontrolu, ale vadu — a dítě se ANI NESPUSTÍ: nevázaný report je horší než
 * žádný, protože vypadá jako pozorování.
 */
export function runBoundChildDoctor({
  root,
  declarationPath,
  mountPath,
  declaration,
  schema,
  expectedScopeType,
  declarationLabel = declarationPath,
  mountLabel = mountPath,
  runChild = runChildDoctor,
}) {
  const refuse = (failure) => ({
    declaration_path: declarationLabel,
    mount_path: mountLabel,
    invoked_command: Array.isArray(declaration?.command) && declaration.command.length > 0
      ? [...declaration.command]
      : ["<nespuštěno>"],
    outcome: "spawn_failed",
    failures: [failure],
  });

  if (typeof expectedScopeType !== "string" || expectedScopeType.trim() === "") {
    return refuse(
      "Root nedostal očekávaný scope.type mountu, takže by report dítěte neměl proti čemu "
      + "vázat identitu. Nespouštíme nic — nevázaný report je horší než žádný.",
    );
  }
  // Deklarace smí očekávaný typ POTVRDIT, nikdy ho přepsat. Mount pod
  // `organizations/`, který si do manifestu napíše `scope_type: "personalspace"`,
  // je rozbitá deklarace, ne jiný lane.
  if (typeof declaration?.scope_type === "string" && declaration.scope_type !== expectedScopeType) {
    return refuse(
      `Deklarace tvrdí scope_type '${declaration.scope_type}', ale mount leží v lane `
      + `'${expectedScopeType}'. Deklarace očekávaný typ potvrzuje, nepřepisuje ho.`,
    );
  }

  const child = runChild({ root, declarationPath, mountPath, declaration, schema });
  return rebindChildExitExpectation(bindChildScope(child, { expectedScopeType }));
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
      runBoundChildDoctor({
        root: companiesRoot,
        declarationPath: entry.declarationPath,
        mountPath: entry.mountPath,
        declaration: entry.declaration,
        schema,
        // Očekávaný druh scope určuje lane, ve které mount leží, ne dítě a ne jeho
        // manifest. Bez tohohle svázání by mount pod `organizations/` mohl vrátit
        // platný v3 report typu `workspace` a root by ho přijal jako svůj.
        expectedScopeType: entry.scopeKind,
        declarationLabel: entry.relativeDeclarationPath,
        mountLabel: entry.relativeMountPath,
        runChild,
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
