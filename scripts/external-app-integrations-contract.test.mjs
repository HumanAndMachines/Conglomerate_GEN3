import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

function repoPath(relativePath) {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

const manualPath = repoPath("../manual/external-app-integrations.md");
const codexManualPath = repoPath("../manual/codex-manual-mcp-integrations.md");
const googleRunbookPath = repoPath("../manual/integrations/google-workspace.md");
const integrationSkillPath = repoPath("../.agents/skills/external-app-integrations/SKILL.md");
const smokeInstructionPaths = [
  "../manual/integrations/slack.md",
  "../manual/integrations/google-workspace.md",
  "../manual/integrations/microsoft-365.md",
  "../manual/integrations/atlassian.md",
  "../manual/integrations/canva.md",
  "../.agents/skills/external-app-integrations/SKILL.md",
].map(repoPath);

function canonicalNewlines(text) {
  return text.replace(/\r\n/g, "\n");
}

async function readPolicy(path) {
  return canonicalNewlines(await readFile(path, "utf8"));
}

test("write smoke cleanup zůstává úzce vymezenou součástí schváleného smoke", async () => {
  const manual = await readPolicy(manualPath);

  expect(manual).toContain("Výjimka pro úklid určeného smoke artefaktu");
  expect(manual).toMatch(/Principál\s+výslovně\s+schválil tento jmenovitý smoke cíl/);
  expect(manual).toContain("v tomto konkrétním smoke sám vytvořil");
  expect(manual).toMatch(/nejde o\s+samostatnou Publikaci ani o obecné oprávnění mazat/);
  expect(manual).toContain("existujícího, ostrého nebo cizího obsahu");
  expect(manual).toMatch(/vyžádej si samostatný explicitní pokyn\s+Principála/);
  expect(manual).toMatch(
    /Nevratné operace \(odeslání, zveřejnění, mazání, přepis ostrého obsahu,\s+změna oprávnění\) potvrzuje Principál per akci\./,
  );
});

test("provider runbooky a skill nesmí cleanup vydávat za obecné oprávnění mazat", async () => {
  for (const path of smokeInstructionPaths) {
    const policy = await readPolicy(path);

    expect(policy).toMatch(/Principál\s+výslovně\s+schválil\s+(?:každý použitý\s+)?jmenovitý smoke cíl/);
    expect(policy).toContain("INTEGRATIONS.md");
    expect(policy).toMatch(/tento\s+konkrétní smoke/);
    expect(policy).toMatch(/(?:artefakt|zprávu|design)\s+vytvořil\s+tento\s+konkrétní smoke/);
    expect(policy).toMatch(/artefakt\s+ponech/);
    expect(policy).toMatch(/samostatný explicitní\s+pokyn Principála/);
  }
});

test("Google smoke eviduje a schvaluje každý cleanupovaný write cíl", async () => {
  const google = await readPolicy(googleRunbookPath);

  expect(google).toMatch(/zapiš oba použité cíle/);
  expect(google).toMatch(/Drive\s+scratch cestu i jmenovitý Gmail draft cíl/);
  expect(google).toMatch(/schválil každý použitý jmenovitý smoke cíl/);
  expect(google).toMatch(/každý artefakt vytvořil tento konkrétní smoke/);
});

test("Google OAuth kontrakt drží sedmidenní provider gate a persistentní cache", async () => {
  const [google, codex, skill] = await Promise.all([
    readPolicy(googleRunbookPath),
    readPolicy(codexManualPath),
    readPolicy(integrationSkillPath),
  ]);

  expect(google).toContain("publishing statusem `Testing`");
  expect(google).toContain("audience `Internal`");
  expect(google).toMatch(/`Trusted` ale samo nemění GCP[\s\S]*expiraci režimu `External \/ Testing`[\s\S]*\*\*neruší\*\*/);
  expect(google).toContain("`In production`");
  expect(google).toContain("WORKSPACE_MCP_CREDENTIALS_DIR");
  expect(google).toMatch(
    /"WORKSPACE_MCP_CREDENTIALS_DIR": "\$\{<ORG_SLUG>_GOOGLE_MCP_CREDENTIALS_DIR\}",[\s\S]*"GOOGLE_MCP_CREDENTIALS_DIR": "\$\{<ORG_SLUG>_GOOGLE_MCP_CREDENTIALS_DIR\}"/,
  );
  expect(google).toContain("memory-only OAuth backend");
  expect(google).toMatch(/kontrola po více než sedmi dnech/);
  expect(codex).toMatch(/Codex keyring jeho interní cache\s+nenahrazuje/);
  expect(codex).toMatch(/Google OAuth se opakuje přibližně po sedmi dnech/);
  expect(codex).toMatch(
    /export WORKSPACE_MCP_CREDENTIALS_DIR="\/custody\/cesta\/google\/tokens"\s+export GOOGLE_MCP_CREDENTIALS_DIR="\/custody\/cesta\/google\/tokens"/,
  );
  expect(skill).toMatch(/Přihlášení musí přežít běžný restart/);
});

test("OAuth write scope zůstává schopností, ne souhlasem s publikací", async () => {
  const [manual, google, skill] = await Promise.all([
    readPolicy(manualPath),
    readPolicy(googleRunbookPath),
    readPolicy(integrationSkillPath),
  ]);

  expect(manual).toMatch(/Souhlas s OAuth grantem zpřístupní\s+schopnost mašině/);
  expect(manual).toContain("write agenta je Draft, ne Publikace");
  expect(google).toMatch(/Udělený OAuth grant je schopnost mašiny, ne souhlas/);
  expect(google).toContain("approval mode harnessu");
  expect(skill).toMatch(/Udělený OAuth grant je\s+schopnost mašiny, ne souhlas/);
});

test("kontraktní text se čte shodně z Windows CRLF checkoutu", () => {
  expect(canonicalNewlines("Principál výslovně\r\nschválil tento jmenovitý smoke cíl")).toBe(
    "Principál výslovně\nschválil tento jmenovitý smoke cíl",
  );
});
