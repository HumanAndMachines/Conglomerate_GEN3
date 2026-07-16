import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import matter from "gray-matter";
import { marked } from "marked";
import type {
  Cesta,
  CestaSection,
  Kviz,
  Lekce,
  LekceFrontmatter,
  Ukol,
  UkolFrontmatter,
} from "./types";

const CONTENT_ROOT = resolve(import.meta.dirname, "../../../../content");

marked.setOptions({ gfm: true, breaks: false });

function safeReadDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

function readMd(absPath: string): { data: Record<string, unknown>; content: string } | null {
  if (!existsSync(absPath)) return null;
  const raw = readFileSync(absPath, "utf-8");
  const parsed = matter(raw);
  return { data: parsed.data, content: parsed.content };
}

function renderMd(src: string): string {
  return marked.parse(src, { async: false }) as string;
}

export function contentRoot(): string {
  return CONTENT_ROOT;
}

export function contentReady(): boolean {
  return existsSync(join(CONTENT_ROOT, "cesta.json"));
}

export function loadCesta(): Cesta | null {
  const path = join(CONTENT_ROOT, "cesta.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Cesta;
  } catch {
    return null;
  }
}

function lekceDir(): string {
  return join(CONTENT_ROOT, "lekce");
}

export function loadLekce(id: string): Lekce | null {
  const dir = join(lekceDir(), id);
  const md = readMd(join(dir, "lekce.md"));
  if (!md) return null;
  const fm = md.data as Partial<LekceFrontmatter>;
  if (!fm.id || !fm.title || !fm.section) return null;
  return {
    id: fm.id,
    title: fm.title,
    section: fm.section,
    order: typeof fm.order === "number" ? fm.order : 0,
    prerequisites: Array.isArray(fm.prerequisites) ? fm.prerequisites : [],
    duration_min: typeof fm.duration_min === "number" ? fm.duration_min : 0,
    achievement_on_complete: fm.achievement_on_complete,
    quiz: Boolean(fm.quiz),
    ukol: Boolean(fm.ukol),
    bodyMd: md.content,
    bodyHtml: renderMd(md.content),
    hasKviz: existsSync(join(dir, "kviz.json")),
    hasUkol: existsSync(join(dir, "ukol.md")),
  };
}

export function loadAllLekce(): Lekce[] {
  const root = lekceDir();
  const ids = safeReadDir(root).filter((name) => {
    if (name.startsWith(".")) return false;
    const full = join(root, name);
    return statSync(full).isDirectory();
  });
  const items: Lekce[] = [];
  for (const id of ids) {
    const l = loadLekce(id);
    if (l) items.push(l);
  }
  items.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return items;
}

export function loadKviz(lekceId: string): Kviz | null {
  const path = join(lekceDir(), lekceId, "kviz.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Kviz;
  } catch {
    return null;
  }
}

export function loadUkol(lekceId: string): Ukol | null {
  const md = readMd(join(lekceDir(), lekceId, "ukol.md"));
  if (!md) return null;
  const fm = md.data as Partial<UkolFrontmatter>;
  if (!fm.title || !fm.type) return null;
  return {
    title: fm.title,
    type: fm.type,
    checklist: Array.isArray(fm.checklist) ? fm.checklist : [],
    achievement_on_complete: fm.achievement_on_complete,
    bodyMd: md.content,
    bodyHtml: renderMd(md.content),
  };
}

export function sectionForLekce(cesta: Cesta, lekceId: string): CestaSection | null {
  return cesta.sections.find((s) => s.lessons.includes(lekceId)) ?? null;
}

export function nextLekceId(cesta: Cesta, currentId: string): string | null {
  const flat = cesta.sections.flatMap((s) => s.lessons);
  const idx = flat.indexOf(currentId);
  if (idx === -1 || idx === flat.length - 1) return null;
  return flat[idx + 1] ?? null;
}

export function lekceById(items: Lekce[]): Map<string, Lekce> {
  return new Map(items.map((l) => [l.id, l]));
}

export { renderMd };
