import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import matter from "gray-matter";
import type {
  GratulaceEntry,
  TeamMember,
  UnlockedAchievement,
} from "./types";
import { getAchievement } from "./achievements";

// Najdi nejbližšího předka, který obsahuje company/team/. Spouští se z app/dist
// (build) i z app/ (dev), takže jdeme nahoru dokud nenajdeme.
function findCompanyRoot(): string {
  let dir = resolve(import.meta.dirname);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "company", "team"))) return join(dir, "company");
    dir = resolve(dir, "..");
  }
  // Fallback: relative to this file (guide/app/src/lib → ../../../company)
  return resolve(import.meta.dirname, "../../../../company");
}

const COMPANY_ROOT = findCompanyRoot();
const TEAM_ROOT = join(COMPANY_ROOT, "team");

function safeReadDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

function extractField(body: string, re: RegExp): string | undefined {
  const m = re.exec(body);
  return m?.[1]?.trim().replace(/^`|`$/g, "");
}

function extractH1(body: string): string | undefined {
  const m = /^#\s+(.+)$/m.exec(body);
  return m?.[1]?.trim();
}

export function listTeam(): TeamMember[] {
  const slugs = safeReadDir(TEAM_ROOT).filter((name) => {
    if (name.startsWith(".") || name.startsWith("_")) return false;
    if (name.endsWith(".md")) return false;
    const full = join(TEAM_ROOT, name);
    return existsSync(full) && statSync(full).isDirectory();
  });
  const out: TeamMember[] = [];
  for (const slug of slugs) {
    const readme = join(TEAM_ROOT, slug, "README.md");
    if (!existsSync(readme)) continue;
    try {
      const raw = readFileSync(readme, "utf-8");
      const parsed = matter(raw);
      const data = parsed.data as Record<string, unknown>;
      const body = parsed.content;
      const jmeno =
        (data.jmeno as string) ??
        (data.name as string) ??
        extractField(body, /\*\*Jméno:\*\*\s*(.+)/) ??
        extractH1(body) ??
        slug;
      const email =
        (data.email as string) ??
        extractField(body, /\*\*[^*]*e-?mail[^*]*:\*\*\s*`?([^`\s]+@[^`\s]+)`?/i) ??
        undefined;
      out.push({ slug, jmeno, email });
    } catch {
      out.push({ slug, jmeno: slug });
    }
  }
  out.sort((a, b) => a.jmeno.localeCompare(b.jmeno, "cs"));
  return out;
}

export function gitEmail(): string | null {
  try {
    const out = execSync("git config user.email", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function gitName(): string | null {
  try {
    const out = execSync("git config user.name", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export interface WhoAmI {
  slug: string | null;
  jmeno?: string;
  email?: string | null;
  candidates?: TeamMember[];
}

export function whoami(): WhoAmI {
  const email = gitEmail();
  const name = gitName();
  const team = listTeam();
  if (email) {
    const match = team.find((m) => m.email && m.email.toLowerCase() === email.toLowerCase());
    if (match) return { slug: match.slug, jmeno: match.jmeno, email: match.email };
  }
  if (name) {
    const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const target = norm(name);
    const match = team.find((m) => norm(m.jmeno) === target || norm(m.jmeno).startsWith(target));
    if (match) return { slug: match.slug, jmeno: match.jmeno, email: match.email };
  }
  return { slug: null, email, candidates: team };
}

function achievementsDir(slug: string): string {
  return join(TEAM_ROOT, slug, "guide", "achievements");
}

function parseAchievementFile(absPath: string): UnlockedAchievement | null {
  if (!existsSync(absPath)) return null;
  try {
    const raw = readFileSync(absPath, "utf-8");
    const parsed = matter(raw);
    const data = parsed.data as Record<string, unknown>;
    const id = (data.achievement_id as string) ?? "";
    if (!id) return null;
    return {
      achievement_id: id,
      unlocked_at: (data.unlocked_at as string) ?? "",
      lekce: (data.lekce as string) ?? undefined,
      filePath: absPath,
      gratulace: parseGratulace(parsed.content),
    };
  } catch {
    return null;
  }
}

function parseGratulace(body: string): GratulaceEntry[] {
  const lines = body.split("\n");
  const out: GratulaceEntry[] = [];
  // Format: - **<jméno>** (<datum>): <text>
  const re = /^-\s+\*\*(.+?)\*\*\s+\((.+?)\):\s*(.*)$/;
  for (const line of lines) {
    const m = re.exec(line.trim());
    if (m) out.push({ fromName: m[1]!, date: m[2]!, text: m[3]! });
  }
  return out;
}

export function readUserAchievements(slug: string): UnlockedAchievement[] {
  const dir = achievementsDir(slug);
  const files = safeReadDir(dir).filter((n) => n.endsWith(".md"));
  const out: UnlockedAchievement[] = [];
  for (const name of files) {
    const item = parseAchievementFile(join(dir, name));
    if (item) out.push(item);
  }
  out.sort((a, b) => (a.unlocked_at < b.unlocked_at ? 1 : -1));
  return out;
}

export interface WriteResult {
  ok: boolean;
  file?: string;
  alreadyUnlocked?: boolean;
  error?: string;
}

export function writeUserAchievement(
  slug: string,
  achievementId: string,
  lessonId?: string,
): WriteResult {
  const def = getAchievement(achievementId);
  if (!def) return { ok: false, error: `Unknown achievement: ${achievementId}` };
  const dir = achievementsDir(slug);
  const file = join(dir, `${achievementId}.md`);
  if (existsSync(file)) {
    return { ok: true, file, alreadyUnlocked: true };
  }
  mkdirSync(dirname(file), { recursive: true });
  const fm = [
    "---",
    `achievement_id: ${achievementId}`,
    `unlocked_at: ${new Date().toISOString()}`,
    ...(lessonId ? [`lekce: ${lessonId}`] : []),
    "---",
    "",
    `# ${def.name}`,
    "",
    `> ${def.description}`,
    "",
    "## Gratulace",
    "",
    "<!-- gratulace appended below this line -->",
    "",
  ].join("\n");
  writeFileSync(file, fm, "utf-8");
  return { ok: true, file };
}

export function companyRoot(): string {
  return COMPANY_ROOT;
}
