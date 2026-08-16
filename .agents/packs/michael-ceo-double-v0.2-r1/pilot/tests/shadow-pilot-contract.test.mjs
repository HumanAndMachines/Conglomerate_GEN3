import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validateShadowPilotContract } from "../scripts/validate-shadow-pilot-contract.mjs";

const PACK_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function withPackCopy(callback) {
  const parent = mkdtempSync(join(tmpdir(), "ceo-shadow-contract-test-"));
  const copy = join(parent, "pack");
  cpSync(PACK_ROOT, copy, { recursive: true });
  try {
    return callback(copy);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function mutateJson(path, mutate) {
  const document = JSON.parse(readFileSync(path, "utf8"));
  mutate(document);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
}

describe("manual Lumbio shadow pilot contract validator", () => {
  test("přijme bezpečný design-only kontrakt bez možnosti spuštění", () => {
    const result = validateShadowPilotContract(PACK_ROOT);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary.contract_id).toBe("PILOT-LUMBIO-SHADOW-0.2-R1");
    expect(result.summary.execution_enabled).toBe(false);
    expect(result.summary.approval_status).toBe("PENDING");
  });

  test("selže zavřeně při zapnuté execution capability", () => withPackCopy((copy) => {
    mutateJson(join(copy, "pilot", "shadow-pilot-contract.json"), (contract) => {
      contract.execution.enabled = true;
    });
    const result = validateShadowPilotContract(copy);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("execution.enabled must remain false");
  }));

  test("selže zavřeně při předvyplněném pilotním objektu bez approval", () => withPackCopy((copy) => {
    mutateJson(join(copy, "pilot", "shadow-pilot-contract.json"), (contract) => {
      contract.pilot_object.object_id = "epc-hodonin";
    });
    const result = validateShadowPilotContract(copy);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pilot object identifiers must remain null before exact approval");
  }));

  test("selže zavřeně při callable toolu nebo síti", () => withPackCopy((copy) => {
    mutateJson(join(copy, "pilot", "shadow-pilot-contract.json"), (contract) => {
      contract.execution.callable_tools = ["read_live_clickup"];
      contract.execution.network_enabled = true;
    });
    const result = validateShadowPilotContract(copy);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("execution callable_tools must be an empty array");
    expect(result.errors).toContain("execution.network_enabled must remain false");
  }));

  test("selže zavřeně při oslabení retence nebo auto-promoci do GBrainu", () => withPackCopy((copy) => {
    mutateJson(join(copy, "pilot", "shadow-pilot-contract.json"), (contract) => {
      contract.retention.raw_snapshot_ttl_after_terminal = "30d";
      contract.retention.gbrain_auto_promotion = true;
    });
    const result = validateShadowPilotContract(copy);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("raw snapshot TTL must remain 24h");
    expect(result.errors).toContain("GBrain auto-promotion must remain false");
  }));

  test("selže zavřeně při approval šabloně, která už není PENDING", () => withPackCopy((copy) => {
    mutateJson(join(copy, "pilot", "templates", "exact-run-approval.pending.json"), (approval) => {
      approval.approval_status = "APPROVED";
      approval.object_id = "epc-hodonin";
    });
    const result = validateShadowPilotContract(copy);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("approval template must remain PENDING with unresolved exact fields");
  }));

  test("selže zavřeně při oslabení manifest path-traversal guardu", () => withPackCopy((copy) => {
    mutateJson(join(copy, "pilot", "schemas", "shadow-input-manifest.schema.json"), (schema) => {
      schema.properties.files.items.properties.relative_path.pattern = ".*";
    });
    const result = validateShadowPilotContract(copy);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("manifest relative_path schema must forbid absolute and traversal paths");
  }));

  test("selže zavřeně při změně pack baseline commitu", () => withPackCopy((copy) => {
    mutateJson(join(copy, "pilot", "shadow-pilot-contract.json"), (contract) => {
      contract.pack.baseline_commit = "0000000000000000000000000000000000000000";
    });
    const result = validateShadowPilotContract(copy);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pack baseline commit must match the approved inactive-pack commit");
  }));
});
