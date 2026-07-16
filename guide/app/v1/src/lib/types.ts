// Shared schema typy pro guide content + profile state.
// Schema kontrakt sdílený obsahem, aplikací a profile vrstvou.

export type LekceStatus = "locked" | "available" | "in-progress" | "done";

export type AchievementIcon =
  | "trophy"
  | "star"
  | "zap"
  | "compass"
  | "wrench"
  | "rocket"
  | "book"
  | "sparkles";

export type AchievementLevel = "bronze" | "silver" | "gold";

export type AchievementTriggerType =
  | "lekce-complete"
  | "kviz-pass"
  | "ukol-complete"
  | "section-complete"
  | "cesta-complete"
  | "manual";

export interface AchievementTrigger {
  type: AchievementTriggerType;
  ref?: string;
}

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  icon: AchievementIcon;
  level: AchievementLevel;
  trigger: AchievementTrigger;
}

export interface LekceFrontmatter {
  id: string;
  title: string;
  section: string;
  order: number;
  prerequisites: string[];
  duration_min: number;
  achievement_on_complete?: string;
  quiz: boolean;
  ukol: boolean;
}

export interface Lekce extends LekceFrontmatter {
  bodyMd: string;
  bodyHtml: string;
  hasKviz: boolean;
  hasUkol: boolean;
}

export type UkolType = "terminal" | "browser" | "file" | "reflection";

export interface UkolFrontmatter {
  title: string;
  type: UkolType;
  checklist: string[];
  achievement_on_complete?: string;
}

export interface Ukol extends UkolFrontmatter {
  bodyMd: string;
  bodyHtml: string;
}

export interface KvizOption {
  id: string;
  text: string;
  correct: boolean;
  feedback?: string;
}

export type KvizMode = "standard" | "glossary-cards";

export interface KvizQuestion {
  id: string;
  text: string;
  type: "single";
  term?: string;
  icon?: string;
  cardHint?: string;
  options: KvizOption[];
  explanation?: string;
}

export interface Kviz {
  mode?: KvizMode;
  title?: string;
  subtitle?: string;
  questions: KvizQuestion[];
  achievement_on_pass?: string;
}

export interface CestaSection {
  id: string;
  title: string;
  description: string;
  lessons: string[];
}

export interface Cesta {
  sections: CestaSection[];
  welcome?: string;
}

export interface TeamMember {
  slug: string;
  jmeno: string;
  email?: string;
}

export interface UnlockedAchievement {
  achievement_id: string;
  unlocked_at: string;
  lekce?: string;
  filePath: string;
  gratulace: GratulaceEntry[];
}

export interface GratulaceEntry {
  fromName: string;
  date: string;
  text: string;
}
