import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const launchpadRoot = join(import.meta.dir, "..");
const repositoryRoot = join(launchpadRoot, "..");

const documents = [
  readFileSync(join(repositoryRoot, "ARCHITECTURE.md"), "utf8"),
  readFileSync(join(launchpadRoot, "README.md"), "utf8"),
  readFileSync(join(launchpadRoot, "docs", "hosted-workspace-parity-contract.md"), "utf8"),
  readFileSync(join(launchpadRoot, "docs", "launchpad-gen3-redesign-spec.md"), "utf8"),
];

test("hosted workspace docs keep development preview separate from production", () => {
  for (const document of documents) {
    expect(document).toMatch(/development workshop|vývojov\S*\s+díln\S*|vývojový preview/i);
    expect(document).toMatch(/private|privátní/);
    expect(document).toMatch(/Tailscale\/VPN/);
    expect(document).toMatch(/not (?:a )?production|ne produkční|nikoli produkční/i);
  }
});

test("runtime docs keep production delivery outside lazurio.runtime.v1", () => {
  for (const document of documents) {
    expect(document).toContain("lazurio.runtime.v1");
    expect(document).toMatch(/Launchpad\s+(?:a|and)\s+Doctor/);
    expect(document).toMatch(/protected source\/tag|chráněn\S*\s+source\/tag\S*/);
    expect(document).toMatch(/immutable artifact|immutable artefakt/);
    expect(document).toMatch(/isolated\s+production\s+runtime|izolovan\S*\s+produkční\S*\s+runtime/);
    expect(document).toMatch(/public \| authenticated \| internal/);
    expect(document).toMatch(/no T3|neobsahuje T3/);
  }
});
