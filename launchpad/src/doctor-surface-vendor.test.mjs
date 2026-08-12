// Integrity baseline sdíleného surfacu doctorů (decision 0118).
//
// PROČ. `src/doctor-surface-lib.mjs`, `src/json-schema-mini.mjs` a
// `schemas/doctor-report.schema.json` tvoří veřejný Lazurio kontrakt. Tichá změna
// jednoho z nich by mohla rozpojit producenty a konzumenty, proto každý soubor má
// v historicky pojmenovaném `schemas/doctor-surface-vendor.json` otisk a každá
// odchylka od adoption baseline musí být pojmenovaná.
//
// CO TEST NEUMÍ, a je to napsané i v samotném záznamu: nechodí na síť, takže
// nehodnotí kompatibilitu navržené změny. Pozná drift proti záznamu; kompatibilitu
// dál drží review a CI v témže veřejném Lazurio repu.
//
// SCÉNÁŘ. Za měsíc někdo opraví klasifikaci potomka rovnou tady, protože „je to
// jeden řádek". Bez tohohle testu se to tiše povede; s ním spadne
// `doctor-surface-vendor` a v hlášce stojí, který soubor a jaký otisk se rozešel
// se záznamem.

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const launchpadRoot = join(import.meta.dirname, "..");
const recordPath = join(launchpadRoot, "schemas", "doctor-surface-vendor.json");
const record = JSON.parse(readFileSync(recordPath, "utf8"));

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Vrací seznam nálezů — prázdný znamená, že záznam sedí. Je to funkce, ne
 * `expect` uvnitř cyklu, aby se dala pustit i na ZÁMĚRNĚ rozbitý záznam:
 * kontrola, která nemůže selhat, nic nedokazuje.
 */
export function vendorFindings(vendorRecord, readFile) {
  const findings = [];
  const files = Array.isArray(vendorRecord?.files) ? vendorRecord.files : [];
  if (files.length === 0) findings.push("záznam nevyjmenovává jediný kontraktní soubor");
  for (const file of files) {
    let content;
    try {
      content = readFile(file.path);
    } catch (error) {
      findings.push(`${file.path}: kontraktní soubor nejde přečíst (${error.message})`);
      continue;
    }
    const actual = sha256(content);
    if (actual !== file.current_sha256) {
      findings.push(
        `${file.path}: otisk ${actual} neodpovídá zaznamenanému ${file.current_sha256}`,
      );
    }
    const delta = Array.isArray(file.declared_delta) ? file.declared_delta : [];
    const identical = file.current_sha256 === file.baseline_sha256;
    if (identical && delta.length > 0) {
      findings.push(`${file.path}: záznam tvrdí shodu s baseline, ale vyjmenovává odchylky`);
    }
    if (!identical && delta.length === 0) {
      findings.push(
        `${file.path}: liší se od baseline, ale žádná odchylka není pojmenovaná — `
        + "nepřiznaný fork kontraktu",
      );
    }
    for (const entry of delta) {
      if (!entry?.summary || !entry?.anchor) {
        findings.push(`${file.path}: odchylka bez 'summary' nebo 'anchor'`);
        continue;
      }
      if (!content.includes(entry.anchor)) {
        findings.push(
          `${file.path}: deklarovaná odchylka „${entry.summary}" v souboru není `
          + `(kotva '${entry.anchor}' se nenašla)`,
        );
      }
    }
  }
  return findings;
}

const readVendored = (relativePath) => readFileSync(join(launchpadRoot, relativePath), "utf8");

test("sdílený surface doctorů sedí se svým integrity záznamem", () => {
  expect(vendorFindings(record, readVendored)).toEqual([]);
});

test("záznam pojmenovává veřejnou autoritu, ref i adoption commit", () => {
  expect(record.baseline?.repository).toBe("HumanAndMachines/Lazurio");
  expect(record.baseline?.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(String(record.baseline?.ref ?? "")).not.toBe("");
});

test("sdílený surface je dnes bajt na bajt shodný s adoption baseline", () => {
  // Tenhle test je záměrná past. Root si k surfacu přidává vlastní politiku
  // (povinné svázání identity dítěte s mountem, exit kód z CELÉHO reportu) — a
  // přidává si ji v `doctor-children-lib.mjs`, ne uvnitř sdílených souborů.
  // Jakmile někdo tu hranici poruší a upraví shared kontrakt, tenhle test spadne
  // a donutí ho odpovědět, proč se kontrakt mění kvůli politice jediného
  // konzumenta.
  for (const file of record.files) {
    expect(file.current_sha256).toBe(file.baseline_sha256);
    expect(file.declared_delta).toEqual([]);
  }
  expect(record.baseline_reconciliation_required).toBe(false);
});

test("KONTROLNÍ TEST: rozešlý otisk i nepřiznaná odchylka musí spadnout", () => {
  const tampered = structuredClone(record);
  tampered.files[0].current_sha256 = "0".repeat(64);
  expect(vendorFindings(tampered, readVendored).join(" ")).toContain("neodpovídá zaznamenanému");

  // Nepřiznaný fork: záznam tvrdí, že se soubor od baseline liší, ale žádnou
  // odchylku nejmenuje. Přesně tak vypadá „opravím to jen tady, je to jeden řádek".
  const undeclared = structuredClone(record);
  undeclared.files[0].baseline_sha256 = "1".repeat(64);
  undeclared.files[0].declared_delta = [];
  expect(vendorFindings(undeclared, readVendored).join(" ")).toContain("nepřiznaný fork");

  const ghostDelta = structuredClone(record);
  ghostDelta.files[1].declared_delta = [{ summary: "odchylka, která tu není", anchor: "KOTVA-KTERA-V-SOUBORU-NENI" }];
  expect(vendorFindings(ghostDelta, readVendored).join(" ")).toContain("vyjmenovává odchylky");
});
