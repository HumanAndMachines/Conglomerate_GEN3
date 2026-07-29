// Root-side test společného surfacu doctorů (decision 0118).
//
// Tenhle soubor je ta polovina mechanismu, bez které je surface jen próza:
// dokazuje, že ROZBITÝ POTOMEK SHODÍ AGREGÁT. Každý případ dole je jeden způsob,
// jak může podřízený doctor selhat, a u všech se ověřuje totéž — root o tom ví,
// pojmenuje to, agregát skončí `fail` a exit kód invokačního kontraktu je 1.
//
// Poslední test („bez agregace by chybějící doctor byl zelený") je kontrolní:
// hlídá, že se ta zelená varianta nedá omylem obnovit.

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAggregateReport,
  exitCodeForSummaryStatus,
  loadDoctorReportSchema,
  runChildDoctor,
  summarizeStatus,
  validateDoctorReport,
} from "./doctor-surface-lib.mjs";
import { discoverChildDoctors, runChildDoctorLane } from "./doctor-children-lib.mjs";

const schema = loadDoctorReportSchema(join(import.meta.dirname, ".."));
const bun = process.execPath;
const fixtures = [];

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "doctor-children-"));
  fixtures.push(root);
  await mkdir(join(root, "organizations"), { recursive: true });
  await mkdir(join(root, "personalspace"), { recursive: true });
  await writeFile(
    join(root, "launchpad.gen3.json"),
    JSON.stringify({
      workspace_generation: "gen3",
      organization_mountpoint: "organizations",
      personalspace_mountpoint: "personalspace",
    }),
  );
  return root;
}

/**
 * Namountuje Organizaci s deklarovaným podřízeným doctorem. `script` je obsah
 * skriptu, který root spustí jako proces; `null` znamená, že skript vůbec
 * nevznikne — přesně ten stav, kdy někdo přejmenoval soubor a zapomněl na
 * deklaraci.
 */
async function mountOrganization(root, slug, { script, declaration } = {}) {
  const mountPath = join(root, "organizations", slug);
  await mkdir(mountPath, { recursive: true });
  if (script !== null && script !== undefined) {
    await writeFile(join(mountPath, "doctor.mjs"), script);
  }
  await writeFile(
    join(mountPath, "company.gen3.json"),
    JSON.stringify({
      schema_version: "companiesascode.company.gen3.v1",
      organization: { slug },
      doctor: declaration ?? {
        schema_version: "humanandmachines.doctor.declaration.v1",
        command: [bun, "doctor.mjs"],
        timeout_ms: 4000,
      },
    }),
  );
  return mountPath;
}

function childScript({ checks, summary, scopeType = "organization", exitCode = null, schemaVersion = "companiesascode.doctor.report.v3", absolutePath = "process.cwd()" }) {
  return `const report = {
  schema_version: ${JSON.stringify(schemaVersion)},
  scope: { type: ${JSON.stringify(scopeType)}, path: ".", name: "Child", absolute_path: ${absolutePath} },
  summary: ${JSON.stringify(summary)},
  checks: ${JSON.stringify(checks)},
};
console.log(JSON.stringify(report));
${exitCode === null ? "" : `process.exitCode = ${exitCode};`}
`;
}

function okCheck(id, status = "ok") {
  return {
    id,
    status,
    severity: "required",
    title: "Vlastní kontrola mountu",
    message: "Kontrola, kterou vlastní mount, ne root.",
    paths: ["."],
    links: [],
    details: [],
  };
}

async function runLane(root) {
  const lane = await runChildDoctorLane({
    companiesRoot: root,
    companiesConfig: {
      organization_mountpoint: "organizations",
      personalspace_mountpoint: "personalspace",
    },
    schema,
  });
  const report = buildAggregateReport({
    scope: { type: "launchpad_root", path: ".", name: "Test root", absolute_path: root },
    checks: lane.checks,
    children: lane.children,
  });
  return { lane, report };
}

function expectLoudDefect(report, outcome) {
  expect(report.children).toHaveLength(1);
  expect(report.children[0].outcome).toBe(outcome);
  expect(report.children[0].failures.length).toBeGreaterThan(0);
  expect(report.children[0].report).toBeUndefined();
  const defect = report.checks.find((check) => check.id === "doctor.child.0");
  expect(defect?.status).toBe("fail");
  expect(report.summary.status).toBe("fail");
  expect(exitCodeForSummaryStatus(report.summary.status)).toBe(1);
  // Agregát musí zůstat validní i když je uvnitř vada — jinak by se rozbitý
  // potomek proměnil v rozbitý report a rodič by přestal být čitelný.
  expect(validateDoctorReport(report, { schema, label: "root" })).toEqual([]);
}

test("zdravý podřízený doctor se započítá do agregátu z VNOŘENÉHO reportu", async () => {
  const root = await createRoot();
  await mountOrganization(root, "ExampleOrg_GEN3", {
    script: childScript({
      checks: [okCheck("example.custom"), okCheck("example.other", "warn")],
      summary: { status: "warn", ok: 1, warn: 1, fail: 0, not_applicable: 0, blocked: 0 },
    }),
  });

  const { report } = await runLane(root);

  expect(report.children[0].outcome).toBe("report");
  expect(report.children[0].report.checks).toHaveLength(2);
  // Souhrn rodiče nese warn dítěte, i když ho rodič sám nikde nevyrobil.
  expect(report.summary.warn).toBe(1);
  expect(report.summary.status).toBe("warn");
  expect(exitCodeForSummaryStatus(report.summary.status)).toBe(0);
  expect(validateDoctorReport(report, { schema, label: "root" })).toEqual([]);
});

test("fail v podřízeném doctorovi shodí agregát rodiče", async () => {
  const root = await createRoot();
  await mountOrganization(root, "ExampleOrg_GEN3", {
    script: childScript({
      checks: [okCheck("example.custom", "fail")],
      summary: { status: "fail", ok: 0, warn: 0, fail: 1, not_applicable: 0, blocked: 0 },
      exitCode: 1,
    }),
  });

  const { report } = await runLane(root);

  expect(report.children[0].outcome).toBe("report");
  expect(report.summary.status).toBe("fail");
  expect(exitCodeForSummaryStatus(report.summary.status)).toBe(1);
});

test("chybějící skript podřízeného doctora je hlasitá vada, ne ticho", async () => {
  const root = await createRoot();
  await mountOrganization(root, "ExampleOrg_GEN3", { script: null });

  const { report } = await runLane(root);

  expectLoudDefect(report, "no_report");
});

test("mlčící podřízený doctor je no_report", async () => {
  const root = await createRoot();
  await mountOrganization(root, "ExampleOrg_GEN3", { script: "process.exitCode = 0;\n" });

  const { report } = await runLane(root);

  expectLoudDefect(report, "no_report");
});

test("smetí místo JSON je unparseable a payload zůstane textem", async () => {
  const root = await createRoot();
  await mountOrganization(root, "ExampleOrg_GEN3", {
    script: 'console.log("všechno je v pořádku");\n',
  });

  const { report } = await runLane(root);

  expectLoudDefect(report, "unparseable");
});

test("report mimo schéma je schema_invalid a do agregace nevstoupí", async () => {
  const root = await createRoot();
  await mountOrganization(root, "ExampleOrg_GEN3", {
    script: childScript({
      // `blocked` bez `remedy` — přesně ta tichá díra, kterou surface zakazuje.
      checks: [{
        id: "example.custom",
        status: "blocked",
        severity: "required",
        title: "Kontrola",
        message: "Nešlo změřit.",
        paths: ["."],
        links: [],
        details: [],
        blocked_reason: "gbrain CLI neodpovídá",
      }],
      summary: { status: "incomplete", ok: 0, warn: 0, fail: 0, not_applicable: 0, blocked: 1 },
      exitCode: 2,
    }),
  });

  const { report } = await runLane(root);

  expectLoudDefect(report, "schema_invalid");
  expect(report.children[0].stdout_tail).toContain("blocked_reason");
});

test("lhoucí souhrn dítěte je schema_invalid — rodič nevěří tomu, co dítě řeklo o sobě", async () => {
  const root = await createRoot();
  await mountOrganization(root, "ExampleOrg_GEN3", {
    script: childScript({
      checks: [okCheck("example.custom", "fail")],
      summary: { status: "ok", ok: 1, warn: 0, fail: 0, not_applicable: 0, blocked: 0 },
    }),
  });

  const { report } = await runLane(root);

  expectLoudDefect(report, "schema_invalid");
});

test("report o cizím scope je scope_mismatch", async () => {
  const root = await createRoot();
  await mountOrganization(root, "ExampleOrg_GEN3", {
    script: childScript({
      checks: [okCheck("example.custom")],
      summary: { status: "ok", ok: 1, warn: 0, fail: 0, not_applicable: 0, blocked: 0 },
      absolutePath: JSON.stringify("/rozhodne/jiny/mount"),
    }),
  });

  const { report } = await runLane(root);

  expectLoudDefect(report, "scope_mismatch");
});

test("deklarace nesmí přepsat lane: scope_type proti mountpointu je hlasitá vada", async () => {
  const root = await createRoot();
  await mountOrganization(root, "ExampleOrg_GEN3", {
    declaration: {
      schema_version: "humanandmachines.doctor.declaration.v1",
      command: [bun, "doctor.mjs"],
      scope_type: "personalspace",
      timeout_ms: 4000,
    },
    script: childScript({
      checks: [okCheck("example.custom")],
      summary: { status: "ok", ok: 1, warn: 0, fail: 0, not_applicable: 0, blocked: 0 },
    }),
  });

  const { report } = await runLane(root);

  expectLoudDefect(report, "spawn_failed");
  expect(report.children[0].failures.join(" ")).toContain("scope_type");
  expect(report.children[0].failures.join(" ")).toContain("organization");
});

test("report bez scope.absolute_path se nedá svázat s mountem, takže je scope_mismatch", async () => {
  const root = await createRoot();
  await mountOrganization(root, "ExampleOrg_GEN3", {
    // Deklarace nese jen `command` — přesně ten minimální tvar, u kterého se dřív
    // obě porovnání identity přeskočila a platný report o cizím checkoutu prošel.
    declaration: {
      schema_version: "humanandmachines.doctor.declaration.v1",
      command: [bun, "doctor.mjs"],
    },
    script: `const report = {
  schema_version: "companiesascode.doctor.report.v3",
  scope: { type: "organization", path: ".", name: "Child" },
  summary: { status: "ok", ok: 1, warn: 0, fail: 0, not_applicable: 0, blocked: 0 },
  checks: ${JSON.stringify([okCheck("example.custom")])},
};
console.log(JSON.stringify(report));
`,
  });

  const { report } = await runLane(root);

  expectLoudDefect(report, "scope_mismatch");
  expect(report.children[0].failures.join(" ")).toContain("scope.absolute_path");
});

test("scope.type se váže na LANE, i když deklarace mlčí", async () => {
  const root = await createRoot();
  await mountOrganization(root, "ExampleOrg_GEN3", {
    declaration: {
      schema_version: "humanandmachines.doctor.declaration.v1",
      command: [bun, "doctor.mjs"],
    },
    script: childScript({
      scopeType: "workspace",
      checks: [okCheck("example.custom")],
      summary: { status: "ok", ok: 1, warn: 0, fail: 0, not_applicable: 0, blocked: 0 },
    }),
  });

  const { report } = await runLane(root);

  expectLoudDefect(report, "scope_mismatch");
  expect(report.children[0].failures.join(" ")).toContain("workspace");
});

test("zaseknutý podřízený doctor je timeout, ne čekání donekonečna", async () => {
  const root = await createRoot();
  await mountOrganization(root, "ExampleOrg_GEN3", {
    declaration: {
      schema_version: "humanandmachines.doctor.declaration.v1",
      command: [bun, "doctor.mjs"],
      timeout_ms: 1000,
    },
    script: "await new Promise(() => {});\n",
  });

  const { report } = await runLane(root);

  expectLoudDefect(report, "timeout");
});

test("nespustitelný runtime je spawn_failed se stderrem, ne prázdné místo", async () => {
  const root = await createRoot();
  await mountOrganization(root, "ExampleOrg_GEN3", {
    declaration: {
      schema_version: "humanandmachines.doctor.declaration.v1",
      command: ["/rozhodne/neexistujici/runtime", "doctor.mjs"],
      timeout_ms: 4000,
    },
    script: "console.log('{}');\n",
  });

  const { report } = await runLane(root);

  expectLoudDefect(report, "spawn_failed");
});

test("rozbitá deklarace se neignoruje — mount, který se přihlásil, musí být svolatelný", async () => {
  const root = await createRoot();
  await mountOrganization(root, "ExampleOrg_GEN3", {
    declaration: { schema_version: "humanandmachines.doctor.declaration.v1", command: "bun doctor.mjs" },
    script: "console.log('{}');\n",
  });

  const { report } = await runLane(root);

  expectLoudDefect(report, "spawn_failed");
  expect(report.children[0].failures.join(" ")).toContain("doctor.command");
});

test("cwd mimo mount je spawn_failed — podřízený doctor běží jen ve svém repu", async () => {
  const root = await createRoot();
  await mountOrganization(root, "ExampleOrg_GEN3", {
    declaration: {
      schema_version: "humanandmachines.doctor.declaration.v1",
      command: [bun, "doctor.mjs"],
      cwd: "../..",
      timeout_ms: 4000,
    },
    script: "console.log('{}');\n",
  });

  const { report } = await runLane(root);

  expectLoudDefect(report, "spawn_failed");
  expect(report.children[0].failures.join(" ")).toContain("mimo mount");
});

test("exit kód, který neodpovídá reportu, je porušení invokačního kontraktu", async () => {
  const root = await createRoot();
  await mountOrganization(root, "ExampleOrg_GEN3", {
    script: childScript({
      checks: [okCheck("example.custom", "fail")],
      summary: { status: "fail", ok: 0, warn: 0, fail: 1, not_applicable: 0, blocked: 0 },
      exitCode: 0,
    }),
  });

  const { report } = await runLane(root);

  expect(report.children[0].outcome).toBe("report");
  expect(report.children[0].exit_code_mismatch).toBe(1);
  const mismatch = report.checks.find((check) => check.id === "doctor.child.0.exit_code");
  expect(mismatch?.status).toBe("fail");
});

test("dítě zabité signálem není report, i když stihlo vypsat platný JSON", async () => {
  const root = await createRoot();
  const mountPath = await mountOrganization(root, "ExampleOrg_GEN3", {
    script: "console.log('{}');\n",
  });
  const payload = JSON.stringify({
    schema_version: "companiesascode.doctor.report.v3",
    scope: { type: "organization", path: ".", name: "Child", absolute_path: mountPath },
    summary: { status: "ok", ok: 1, warn: 0, fail: 0, not_applicable: 0, blocked: 0 },
    checks: [okCheck("example.custom")],
  });

  // OOM killer nebo `kill -9` z jiného skriptu: status je null, signal SIGKILL a
  // stdout přesto nese konformní report. Bez kontroly signálu by tohle byl
  // `outcome: "report"` s prázdným `failures` — nedoběhlý běh vydávaný za zdraví.
  const child = runChildDoctor({
    root,
    declarationPath: join(mountPath, "company.gen3.json"),
    mountPath,
    declaration: { command: [bun, "doctor.mjs"] },
    schema,
    expectedScopeType: "organization",
    spawn: () => ({ status: null, signal: "SIGKILL", stdout: payload, stderr: "" }),
  });

  expect(child.outcome).toBe("spawn_failed");
  expect(child.report).toBeUndefined();
  expect(child.failures.join(" ")).toContain("SIGKILL");
  const report = buildAggregateReport({
    scope: { type: "launchpad_root", path: ".", name: "Test root", absolute_path: root },
    checks: [],
    children: [child],
  });
  expect(report.summary.status).toBe("fail");
  expect(exitCodeForSummaryStatus(report.summary.status)).toBe(1);
});

test("volající, který nepředá očekávaný scope_type, nedostane volnější kontrolu ale vadu", async () => {
  const root = await createRoot();
  const mountPath = await mountOrganization(root, "ExampleOrg_GEN3", {
    script: "console.log('{}');\n",
  });

  const child = runChildDoctor({
    root,
    declarationPath: join(mountPath, "company.gen3.json"),
    mountPath,
    declaration: { command: [bun, "doctor.mjs"] },
    schema,
    spawn: () => {
      throw new Error("dítě se nesmí vůbec spustit");
    },
  });

  expect(child.outcome).toBe("spawn_failed");
  expect(child.failures.join(" ")).toContain("scope.type");
});

test("dítě, které je samo rootem, se soudí podle CELÉHO reportu, ne jen podle vlastních checks", async () => {
  const root = await createRoot();
  const mountPath = join(root, "organizations", "ExampleOrg_GEN3");
  const grandchildReport = {
    schema_version: "companiesascode.doctor.report.v3",
    scope: { type: "personalspace", path: ".", name: "Vnuk", absolute_path: "/vnuk" },
    summary: { status: "incomplete", ok: 0, warn: 0, fail: 0, not_applicable: 0, blocked: 1 },
    checks: [{
      id: "vnuk.custom",
      status: "blocked",
      severity: "required",
      title: "Kontrola vnuka",
      message: "Nešlo pozorovat.",
      paths: ["."],
      links: [],
      details: [],
      blocked_reason: "Vnukův datový repozitář nebyl k dispozici.",
      remedy: "Namountuj datový repozitář a spusť doctor znovu.",
    }],
  };
  // Dítě má vlastní `ok`, ale vnořený report vnuka je `blocked`. Jeho agregát je
  // proto `incomplete` a invokační kontrakt mu ukládá skončit dvojkou.
  await mountOrganization(root, "ExampleOrg_GEN3", {
    script: `const report = {
  schema_version: "companiesascode.doctor.report.v3",
  scope: { type: "organization", path: ".", name: "Child", absolute_path: process.cwd() },
  summary: { status: "incomplete", ok: 1, warn: 0, fail: 0, not_applicable: 0, blocked: 1 },
  checks: ${JSON.stringify([okCheck("example.custom")])},
  children: [{
    declaration_path: "sub/personal.gen3.json",
    mount_path: "sub",
    invoked_command: ["bun", "doctor.mjs"],
    outcome: "report",
    failures: [],
    report: ${JSON.stringify(grandchildReport)},
  }],
};
console.log(JSON.stringify(report));
process.exitCode = 2;
`,
  });
  expect(mountPath).toContain("ExampleOrg_GEN3");

  const { report } = await runLane(root);

  expect(report.children[0].outcome).toBe("report");
  expect(report.children[0].exit_code).toBe(2);
  // Rodič nesmí dítěti vystavit falešné porušení kontraktu…
  expect(report.children[0].exit_code_mismatch).toBeUndefined();
  expect(report.checks.find((check) => check.id === "doctor.child.0.exit_code")).toBeUndefined();
  // …a `blocked` vnuka se musí propsat až do souhrnu rootu.
  expect(report.summary.blocked).toBe(1);
  expect(report.summary.status).toBe("incomplete");
  expect(exitCodeForSummaryStatus(report.summary.status)).toBe(2);
  expect(validateDoctorReport(report, { schema, label: "root" })).toEqual([]);
});

test("starší v1 dítě se čte fail-closed: skip se počítá jako blocked a rodič to přizná", async () => {
  const root = await createRoot();
  await mountOrganization(root, "ExampleOrg_GEN3", {
    script: childScript({
      schemaVersion: "companiesascode.doctor.report.v1",
      checks: [{
        id: "example.custom",
        status: "skip",
        severity: "required",
        title: "Kontrola",
        message: "Přeskočeno.",
        paths: ["."],
        links: [],
        details: [],
      }],
      summary: { status: "ok", ok: 0, warn: 0, fail: 0, skip: 1 },
    }),
  });

  const { report } = await runLane(root);

  expect(report.children[0].outcome).toBe("report");
  expect(report.summary.blocked).toBe(1);
  expect(report.summary.status).toBe("incomplete");
  // `incomplete` nikdy nesplní bránu.
  expect(exitCodeForSummaryStatus(report.summary.status)).toBe(2);
  const legacy = report.checks.find((check) => check.id === "doctor.child.0.legacy_schema");
  expect(legacy?.status).toBe("warn");
});

test("personalspace mount se svolává stejně jako Organizace", async () => {
  const root = await createRoot();
  const mountPath = join(root, "personalspace", "example-owner_GEN3");
  await mkdir(mountPath, { recursive: true });
  await writeFile(
    join(mountPath, "doctor.mjs"),
    childScript({
      scopeType: "personalspace",
      checks: [okCheck("personalspace.gbrain_mount")],
      summary: { status: "ok", ok: 1, warn: 0, fail: 0, not_applicable: 0, blocked: 0 },
    }),
  );
  await writeFile(
    join(mountPath, "personal.gen3.json"),
    JSON.stringify({
      schema_version: "humanandmachines.personal.gen3.v1",
      doctor: {
        schema_version: "humanandmachines.doctor.declaration.v1",
        command: [bun, "doctor.mjs"],
        scope_type: "personalspace",
        timeout_ms: 4000,
      },
    }),
  );

  const { report } = await runLane(root);

  expect(report.children[0].declaration_path).toBe("personalspace/example-owner_GEN3/personal.gen3.json");
  expect(report.children[0].outcome).toBe("report");
  expect(report.summary.status).toBe("ok");
});

test("root bez deklarovaných doctorů je not_applicable — fakt, ne nezměřená kontrola", async () => {
  const root = await createRoot();
  await mkdir(join(root, "organizations", "ExampleOrg_GEN3"), { recursive: true });
  await writeFile(
    join(root, "organizations", "ExampleOrg_GEN3", "company.gen3.json"),
    JSON.stringify({ schema_version: "companiesascode.company.gen3.v1" }),
  );

  const { report } = await runLane(root);

  const check = report.checks.find((item) => item.id === "doctor.children");
  expect(check?.status).toBe("not_applicable");
  expect(check?.not_applicable_reason).toBe("not_declared");
  expect(check?.owner).toBeTruthy();
  expect(report.summary.status).toBe("ok");
  expect(report.children).toBeUndefined();
});

test("nepřečtitelný manifest je blocked, protože o jeho deklaraci nevíme nic", async () => {
  const root = await createRoot();
  await mkdir(join(root, "organizations", "ExampleOrg_GEN3"), { recursive: true });
  await writeFile(join(root, "organizations", "ExampleOrg_GEN3", "company.gen3.json"), "{ tohle není JSON");

  const { report } = await runLane(root);

  const check = report.checks.find((item) => item.id === "doctor.children");
  expect(check?.status).toBe("blocked");
  expect(check?.remedy).toBeTruthy();
  expect(report.summary.status).toBe("incomplete");
});

test("vypnutá lane je blocked, ne tichý vypínač", async () => {
  const root = await createRoot();
  const lane = await runChildDoctorLane({ companiesRoot: root, schema, enabled: false });

  expect(lane.children).toEqual([]);
  expect(lane.checks[0].status).toBe("blocked");
  expect(lane.checks[0].remedy).toContain("--skip-children");
  expect(summarizeStatus(lane.checks)).toBe("incomplete");
});

test("discovery čte deklaraci z manifestu, ne z konvenční cesty", async () => {
  const root = await createRoot();
  // Mount MÁ scripts/doctor.mjs, ale nedeklaruje ho. Hádaná cesta by ho našla;
  // deklarativní discovery ho schválně nenajde (decision 0118, §4).
  const mountPath = join(root, "organizations", "ExampleOrg_GEN3");
  await mkdir(join(mountPath, "scripts"), { recursive: true });
  await writeFile(join(mountPath, "scripts", "doctor.mjs"), "console.log('{}');\n");
  await writeFile(
    join(mountPath, "company.gen3.json"),
    JSON.stringify({ schema_version: "companiesascode.company.gen3.v1" }),
  );

  const discovered = await discoverChildDoctors({ companiesRoot: root });

  expect(discovered.declarations).toEqual([]);
  expect(discovered.scannedMounts).toBe(1);
});

test("KONTROLNÍ TEST: bez agregace by chybějící podřízený doctor byl zelený", async () => {
  const root = await createRoot();
  await mountOrganization(root, "ExampleOrg_GEN3", { script: null });
  const { lane } = await runLane(root);

  // Tohle je tvar, který tenhle PR ruší: report rodiče postavený BEZ children[]
  // a bez syntetizovaných checků za rozbité potomky. Kdyby se ta varianta někdy
  // vrátila, doctor by o chybějícím dítěti mlčel a vyšel zeleně.
  const withoutAggregation = buildAggregateReport({
    scope: { type: "launchpad_root", path: ".", name: "Test root", absolute_path: root },
    checks: [],
    children: [],
  });
  expect(withoutAggregation.summary.status).toBe("ok");

  const withAggregation = buildAggregateReport({
    scope: { type: "launchpad_root", path: ".", name: "Test root", absolute_path: root },
    checks: [],
    children: lane.children,
  });
  expect(withAggregation.summary.status).toBe("fail");
});

afterAll(async () => {
  for (const root of fixtures.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
