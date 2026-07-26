import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const manualPath = fileURLToPath(
  new URL("../manual/external-app-integrations.md", import.meta.url),
);

test("write smoke cleanup zůstává úzce vymezenou součástí schváleného smoke", async () => {
  const manual = await readFile(manualPath, "utf8");

  expect(manual).toContain("Výjimka pro úklid určeného smoke artefaktu");
  expect(manual).toContain("Principál výslovně\nschválil tento jmenovitý smoke cíl");
  expect(manual).toContain("v tomto konkrétním smoke sám vytvořil");
  expect(manual).toContain("nejde o\nsamostatnou Publikaci ani o obecné oprávnění mazat");
  expect(manual).toContain("existujícího, ostrého nebo cizího obsahu");
  expect(manual).toContain("vyžádej si samostatný explicitní pokyn\nPrincipála");
});
