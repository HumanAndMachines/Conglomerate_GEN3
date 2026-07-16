// Gbrain read-only browser (CAC-0048, decision 0051).
//
// PRIVÁTNÍ HRANICE JE TVRDÁ. gbrain je privátní paměťová vrstva páru
// Kolega ↔ jeho Buddy (Obsidian-compatible markdown vault). Toto je jen
// LOKÁLNÍ, READ-ONLY lidské rozhraní k listování/čtení zápisů — obdoba
// Obsidianu ve webu jako fallback. Agenti pracují s pamětí VÝHRADNĚ přes gbrain
// MCP server, ne přes tohle API.
//
// Bezpečnostní invarianty:
//   - Server běží jen na 127.0.0.1/localhost (řeší server.mjs) → local-only.
//   - Každá cesta je BOUNDED na kořen vaultu daného prostoru; žádný path escape
//     (`..`, absolutní cesty, symlink mimo vault) není povolený → fail-closed.
//   - Čte se jen text markdownu (.md) a pár textových příloh; binární soubory ne.
//   - ŽÁDNÝ obsah zápisů se nikdy neloguje ani nepropisuje do shared/doctor
//     výstupů; API vrací obsah jen do lokálního prohlížeče na vyžádání.
//
// gbrain vault se v personalspace lane resolvuje přes discoverPersonalspace →
// space.gbrain.source_rel (canonical <space>/gbrain, nebo přechodný explicitní
// zdroj). Toto API dostává absolutní vault root a už jen bezpečně čte pod ním.

import { existsSync } from "fs";
import { readdir, readFile, realpath, stat } from "fs/promises";
import { basename, extname, join, relative, resolve, sep } from "path";

export class GbrainAccessError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "GbrainAccessError";
    this.status = status;
    this.code = code;
  }
}

// Adresáře, které v Obsidian vaultu nechceme listovat (runtime/skryté).
const ignoredDirs = new Set([".git", ".obsidian", ".trash", ".worktrees", "node_modules"]);
// Textové přípony, které umíme bezpečně vrátit pro render. Markdown je primární.
const textExtensions = new Set([".md", ".markdown", ".txt", ".canvas"]);
const maxFileBytes = 1_000_000; // 1 MB strop na jeden soubor, ať se nerenderuje nesmysl.
const maxSearchBytes = 500_000; // Fulltext čte jen do tohoto stropu na soubor.
const maxSearchResults = 100;
const maxSearchFiles = 5_000;

// Bezpečně přeloží relativní cestu (od uživatele) na absolutní cestu UVNITŘ
// vaultu. Fail-closed při jakémkoli náznaku útěku. Vrací absolutní cestu.
export function resolveInsideVault(vaultRoot, relPath = "") {
  const root = resolve(vaultRoot);
  const cleaned = String(relPath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  // Explicitní odmítnutí path-traversal segmentů ještě před resolve.
  if (cleaned.split("/").some((segment) => segment === "..")) {
    throw new GbrainAccessError(400, "path_escape", "Cesta míří mimo gbrain vault (path traversal odmítnut).");
  }
  const target = resolve(root, cleaned);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new GbrainAccessError(400, "path_escape", "Cesta míří mimo gbrain vault.");
  }
  return target;
}

// Po vyresolvování ještě ověří, že realpath (po rozbalení symlinků) zůstává
// uvnitř vaultu — brání úniku přes symlink na cizí soubor.
async function assertRealpathInside(vaultRoot, target) {
  const root = resolve(vaultRoot);
  let realRoot = root;
  let realTarget = target;
  try {
    realRoot = await realpath(root);
  } catch {
    // vault root neexistuje — ošetří volající.
  }
  try {
    realTarget = await realpath(target);
  } catch {
    // target ještě/už neexistuje; existenci řeší volající, tady jen bounding.
    return;
  }
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) {
    throw new GbrainAccessError(400, "path_escape", "Cesta se přes symlink dostává mimo gbrain vault.");
  }
}

function ensureVault(vaultRoot) {
  if (!vaultRoot || !existsSync(vaultRoot)) {
    throw new GbrainAccessError(404, "vault_not_found", "gbrain vault pro tento prostor není lokálně dostupný.");
  }
}

// Rekurzivní strom markdownových (a textových) zápisů. Vrací jen metadata
// (jména, relativní cesty, velikosti, mtime), NIKDY obsah.
export async function gbrainTree(vaultRoot, { maxDepth = 12 } = {}) {
  ensureVault(vaultRoot);
  const root = resolve(vaultRoot);

  async function walk(dirAbs, depth) {
    const children = [];
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return children;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") && ignoredDirs.has(entry.name)) continue;
      if (ignoredDirs.has(entry.name)) continue;
      const abs = join(dirAbs, entry.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (entry.isDirectory()) {
        const nested = depth < maxDepth ? await walk(abs, depth + 1) : [];
        // Ukazujeme jen složky, které někde pod sebou mají zápis.
        if (nested.length > 0) {
          children.push({ type: "dir", name: entry.name, path: rel, children: nested });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (!textExtensions.has(extname(entry.name).toLowerCase())) continue;
      let size = null;
      let mtime = null;
      try {
        const info = await stat(abs);
        size = info.size;
        mtime = info.mtimeMs;
      } catch {
        // ignoruj — jen metadata
      }
      children.push({ type: "file", name: entry.name, path: rel, size, mtime });
    }
    return children;
  }

  const tree = await walk(root, 0);
  const fileCount = countFiles(tree);
  return {
    schema_version: "companiesascode.gbrain.tree.v1",
    file_count: fileCount,
    tree,
  };
}

function countFiles(nodes) {
  let total = 0;
  for (const node of nodes) {
    if (node.type === "file") total += 1;
    else if (node.children) total += countFiles(node.children);
  }
  return total;
}

// Obsah jednoho zápisu pro client-side markdown render. BOUNDED na vault.
export async function gbrainFile(vaultRoot, relPath) {
  ensureVault(vaultRoot);
  const target = resolveInsideVault(vaultRoot, relPath);
  await assertRealpathInside(vaultRoot, target);
  if (!existsSync(target)) {
    throw new GbrainAccessError(404, "note_not_found", "Zápis v gbrainu neexistuje.");
  }
  const info = await stat(target);
  if (!info.isFile()) {
    throw new GbrainAccessError(400, "not_a_file", "Cesta neukazuje na soubor.");
  }
  if (!textExtensions.has(extname(target).toLowerCase())) {
    throw new GbrainAccessError(415, "unsupported_type", "Tento typ souboru se v gbrain browseru nezobrazuje.");
  }
  if (info.size > maxFileBytes) {
    throw new GbrainAccessError(413, "note_too_large", "Zápis je příliš velký na náhled v prohlížeči.");
  }
  const content = await readFile(target, "utf8");
  const rel = relative(resolve(vaultRoot), target).split(sep).join("/");
  return {
    schema_version: "companiesascode.gbrain.note.v1",
    path: rel,
    name: basename(target),
    size: info.size,
    mtime: info.mtimeMs,
    content,
  };
}

// Jednoduchý fulltext přes markdown zápisy. Vrací kontextové výřezy (řádky se
// shodou), NE celé soubory. Case-insensitive, BOUNDED na vault. Obsah se nikde
// neloguje — vrací se jen do lokálního prohlížeče.
export async function gbrainSearch(vaultRoot, query, { limit = maxSearchResults } = {}) {
  ensureVault(vaultRoot);
  const needle = String(query ?? "").trim();
  if (needle.length < 2) {
    throw new GbrainAccessError(400, "query_too_short", "Hledaný výraz musí mít aspoň 2 znaky.");
  }
  const root = resolve(vaultRoot);
  const lowerNeedle = needle.toLowerCase();
  const results = [];
  let scannedFiles = 0;
  let truncated = false;

  async function walk(dirAbs) {
    if (results.length >= limit || scannedFiles >= maxSearchFiles) return;
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (results.length >= limit || scannedFiles >= maxSearchFiles) return;
      if (ignoredDirs.has(entry.name)) continue;
      const abs = join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (ext !== ".md" && ext !== ".markdown" && ext !== ".txt") continue;
      scannedFiles += 1;
      let content;
      try {
        const info = await stat(abs);
        if (info.size > maxSearchBytes) {
          truncated = true;
          content = (await readFile(abs, "utf8")).slice(0, maxSearchBytes);
        } else {
          content = await readFile(abs, "utf8");
        }
      } catch {
        continue;
      }
      const rel = relative(root, abs).split(sep).join("/");
      const matches = collectMatches(content, lowerNeedle, needle);
      if (matches.length > 0) {
        results.push({
          path: rel,
          name: basename(abs),
          match_count: matches.length,
          snippets: matches.slice(0, 3),
        });
      }
    }
  }

  await walk(root);
  return {
    schema_version: "companiesascode.gbrain.search.v1",
    query: needle,
    result_count: results.length,
    scanned_files: scannedFiles,
    truncated: truncated || results.length >= limit,
    results,
  };
}

function collectMatches(content, lowerNeedle, originalNeedle) {
  const lines = content.split(/\r?\n/);
  const snippets = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.toLowerCase().includes(lowerNeedle)) {
      snippets.push({
        line: i + 1,
        text: line.length > 240 ? `${line.slice(0, 240)}…` : line,
      });
      if (snippets.length >= 25) break;
    }
  }
  return snippets;
}

// Obsidian deep link. V1 lidské rozhraní je Obsidian (desktop app, nejde
// embedovat do webu) → z Launchpadu otevřeme vault/zápis přes obsidian://open.
// Vault se v Obsidianu adresuje jménem (poslední segment cesty). Pokud vault
// v Obsidianu není zaregistrovaný, deep link nic neotevře — proto UI vždy ukáže
// i absolutní/relativní cestu jako fallback (řeší client).
export function obsidianDeepLink({ vaultName, filePath }) {
  const params = new URLSearchParams();
  if (vaultName) params.set("vault", vaultName);
  if (filePath) params.set("file", String(filePath).replace(/\.md$/i, ""));
  return `obsidian://open?${params.toString()}`;
}

export function gbrainVaultName(sourceRel) {
  const parts = String(sourceRel ?? "").split("/").filter(Boolean);
  return parts.at(-1) ?? "";
}
