import { afterAll, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdir, mkdtemp, rm, writeFile, symlink } from "fs/promises";
import {
  GbrainAccessError,
  gbrainFile,
  gbrainSearch,
  gbrainTree,
  gbrainVaultName,
  obsidianDeepLink,
  resolveInsideVault,
} from "./gbrain-lib.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function createVault() {
  const vault = await mkdtemp(join(tmpdir(), "gbrain-vault-"));
  tempRoots.push(vault);
  await mkdir(join(vault, "concepts"), { recursive: true });
  await mkdir(join(vault, ".obsidian"), { recursive: true });
  await writeFile(join(vault, "index.md"), "# Index\n\nOdkaz na projekt Launchpad a poznámky.", "utf8");
  await writeFile(join(vault, "concepts", "launchpad.md"), "# Launchpad\n\nToto je poznámka o Launchpadu GEN3.\nDruhý řádek se slovem tajemství.", "utf8");
  await writeFile(join(vault, ".obsidian", "app.json"), "{}", "utf8");
  await writeFile(join(vault, "photo.png"), "binarydata", "utf8");
  return vault;
}

test("gbrainTree vrací jen markdown/textové zápisy jako metadata, ignoruje .obsidian a binárky", async () => {
  const vault = await createVault();
  const tree = await gbrainTree(vault);
  expect(tree.file_count).toBe(2);
  const flat = flatten(tree.tree);
  const paths = flat.filter((n) => n.type === "file").map((n) => n.path).sort();
  expect(paths).toEqual(["concepts/launchpad.md", "index.md"]);
  // .obsidian ani photo.png se neobjeví.
  expect(JSON.stringify(tree.tree)).not.toContain(".obsidian");
  expect(JSON.stringify(tree.tree)).not.toContain("photo.png");
  // Metadata neobsahují obsah souboru.
  expect(JSON.stringify(tree.tree)).not.toContain("tajemství");
});

test("gbrainFile přečte zápis pro render (bounded na vault)", async () => {
  const vault = await createVault();
  const note = await gbrainFile(vault, "concepts/launchpad.md");
  expect(note.path).toBe("concepts/launchpad.md");
  expect(note.content).toContain("poznámka o Launchpadu");
});

test("gbrainFile odmítne path traversal (..) — fail-closed", async () => {
  const vault = await createVault();
  await expect(gbrainFile(vault, "../outside.md")).rejects.toThrow(GbrainAccessError);
  await expect(gbrainFile(vault, "../../etc/passwd")).rejects.toThrow(/mimo gbrain vault/);
});

test("gbrainFile odmítne absolutní escape (interpretuje se jako vault-relativní, ne únik)", async () => {
  const vault = await createVault();
  // /etc/passwd → uvnitř vaultu jako etc/passwd (neexistuje) → note_not_found, ne únik.
  await expect(gbrainFile(vault, "/etc/passwd")).rejects.toThrow(/neexistuje/);
});

test("resolveInsideVault drží cesty uvnitř vaultu", () => {
  const vault = join(tmpdir(), "vault");
  expect(resolveInsideVault(vault, "a/b.md")).toBe(join(vault, "a", "b.md"));
  expect(() => resolveInsideVault(vault, "../x")).toThrow(/path traversal/);
  expect(() => resolveInsideVault(vault, "a/../../x")).toThrow();
  // Absolutní se ořízne na vault-relativní (bezpečné, zůstává bounded).
  expect(resolveInsideVault(vault, "/etc/passwd")).toBe(join(vault, "etc", "passwd"));
});

test("gbrainFile odmítne symlink únik mimo vault", async () => {
  const vault = await createVault();
  const outside = await mkdtemp(join(tmpdir(), "gbrain-outside-"));
  tempRoots.push(outside);
  await writeFile(join(outside, "secret.md"), "# tajný soubor mimo vault", "utf8");
  await symlink(outside, join(vault, "escape"), process.platform === "win32" ? "junction" : "dir");
  await expect(gbrainFile(vault, "escape/secret.md")).rejects.toThrow(/symlink/);
});

test("gbrainFile odmítne nepodporovaný typ (např. .png)", async () => {
  const vault = await createVault();
  await expect(gbrainFile(vault, "photo.png")).rejects.toThrow(GbrainAccessError);
});

test("gbrainSearch dělá fulltext přes markdown a vrací kontextové výřezy, ne celé soubory", async () => {
  const vault = await createVault();
  const result = await gbrainSearch(vault, "tajemství");
  expect(result.result_count).toBe(1);
  expect(result.results[0].path).toBe("concepts/launchpad.md");
  expect(result.results[0].snippets[0].text).toContain("tajemství");
  // Snippet je jen řádek, ne celý soubor.
  expect(result.results[0].snippets[0].text).not.toContain("# Launchpad");
});

test("gbrainSearch je case-insensitive a najde napříč soubory", async () => {
  const vault = await createVault();
  const result = await gbrainSearch(vault, "LAUNCHPAD");
  // "Launchpad" je v index.md i concepts/launchpad.md.
  expect(result.result_count).toBe(2);
});

test("gbrainSearch odmítne příliš krátký dotaz", async () => {
  const vault = await createVault();
  await expect(gbrainSearch(vault, "a")).rejects.toThrow(/aspoň 2 znaky/);
});

test("gbrainTree/gbrainFile na neexistujícím vaultu → vault_not_found", async () => {
  await expect(gbrainTree("/nope/does/not/exist")).rejects.toThrow(/vault/);
  await expect(gbrainFile("/nope/does/not/exist", "a.md")).rejects.toThrow(/vault/);
});

test("obsidianDeepLink kóduje vault a soubor správně a odstřihne .md", () => {
  const link = obsidianDeepLink({ vaultName: "examplebuddy-gbrain", filePath: "concepts/launchpad.md" });
  expect(link).toBe("obsidian://open?vault=examplebuddy-gbrain&file=concepts%2Flaunchpad");
  // Bez souboru jen vault.
  expect(obsidianDeepLink({ vaultName: "examplebuddy-gbrain" })).toBe("obsidian://open?vault=examplebuddy-gbrain");
});

test("gbrainVaultName vezme poslední segment cesty (jméno vaultu pro Obsidian)", () => {
  expect(gbrainVaultName("personalspace/examplebuddy-gbrain")).toBe("examplebuddy-gbrain");
  expect(gbrainVaultName("personalspace/exampleuser_GEN3/gbrain")).toBe("gbrain");
});

function flatten(nodes) {
  const out = [];
  for (const node of nodes) {
    out.push(node);
    if (node.children) out.push(...flatten(node.children));
  }
  return out;
}
