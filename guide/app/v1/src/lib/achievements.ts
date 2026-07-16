import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { contentRoot } from "./content";
import type { AchievementDef } from "./types";

interface AchievementsFile {
  achievements: AchievementDef[];
}

export function loadAchievements(): AchievementDef[] {
  const path = join(contentRoot(), "achievements", "achievements.json");
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as AchievementsFile;
    return Array.isArray(data.achievements) ? data.achievements : [];
  } catch {
    return [];
  }
}

export function getAchievement(id: string): AchievementDef | null {
  return loadAchievements().find((a) => a.id === id) ?? null;
}

export function achievementsByTrigger(
  type: AchievementDef["trigger"]["type"],
  ref?: string,
): AchievementDef[] {
  return loadAchievements().filter(
    (a) => a.trigger.type === type && (ref == null || a.trigger.ref === ref),
  );
}
