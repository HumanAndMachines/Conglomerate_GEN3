import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

function repoPath(relativePath) {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

const manualPath = repoPath("../manual/external-app-integrations.md");
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
  expect(manual).toContain("Principál výslovně\nschválil tento jmenovitý smoke cíl");
  expect(manual).toContain("v tomto konkrétním smoke sám vytvořil");
  expect(manual).toContain("nejde o\nsamostatnou Publikaci ani o obecné oprávnění mazat");
  expect(manual).toContain("existujícího, ostrého nebo cizího obsahu");
  expect(manual).toContain("vyžádej si samostatný explicitní pokyn\nPrincipála");
});

test("provider runbooky a skill nesmí cleanup vydávat za obecné oprávnění mazat", async () => {
  for (const path of smokeInstructionPaths) {
    const policy = await readPolicy(path);

    expect(policy).toMatch(/Principál\s+výslovně\s+schválil\s+jmenovitý smoke cíl/);
    expect(policy).toContain("INTEGRATIONS.md");
    expect(policy).toMatch(/tento\s+konkrétní smoke/);
    expect(policy).toMatch(/artefakt\s+ponech/);
    expect(policy).toMatch(/samostatný explicitní\s+pokyn Principála/);
  }
});

test("kontraktní text se čte shodně z Windows CRLF checkoutu", () => {
  expect(canonicalNewlines("Principál výslovně\r\nschválil tento jmenovitý smoke cíl")).toBe(
    "Principál výslovně\nschválil tento jmenovitý smoke cíl",
  );
});
