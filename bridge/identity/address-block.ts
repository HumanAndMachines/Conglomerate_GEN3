// Capability C10 — how the Principal's language and their Buddy's grammatical
// gender reach the sentences the Buddy actually writes.
//
// THE FAILURE THIS EXISTS FOR. The profile template's `CONSTITUTION.md` gained
// a § *Name and address* block: name, language, the grammatical gender of that
// name in that language, and the form of address each way. It is the right home
// for those facts — the Principal accepts an exact profile commit, while ./.env
// is edited by the operator and has no acceptance record. But when it landed,
// NOTHING IN THIS REPOSITORY READ IT. A grep for `CONSTITUTION` across
// the whole archive returned nothing at all, and the bridge sent
// the runtime exactly one message: `[{ role: "user", content: text }]`. So a Buddy
// whose name is feminine in Czech would still have written about itself in the
// masculine in every clause of every reply, and the declared block would have
// been a document with no consumer — the same defect class as a host seam that
// names a systemd user nobody creates.
//
// This module is the reader. It is deliberately small and deliberately dumb:
//
//   * IT NEVER DERIVES GENDER FROM A NAME. A name borrowed across languages
//     carries no reliable gender; a heuristic would be silently and frequently
//     wrong. Declared, or absent.
//   * AN ABSENT OR PLACEHOLDER FIELD IS ABSENT. The template ships
//     `` `<language>` `` style placeholders; a profile that still carries them
//     has declared nothing, and pretending otherwise would make the Buddy assert
//     it speaks a language called "<language>".
//   * AN ABSENT GENDER MEANS "WRITE WITHOUT GENDERED SELF-REFERENCE", stated as
//     an instruction rather than left to chance, plus an ask to fill it in.
//   * NOTHING DECLARED AT ALL MEANS NO PREAMBLE — byte-for-byte today's
//     behaviour, so a host with no profile declared is unaffected.
//
// HONEST BOUNDARY. This is the bridge-side half: it puts a `system` message in
// front of the Principal's text on the authenticated runtime API. Whether the
// runtime then honours a system message is that runtime's behaviour (K3), and
// there is NO host probe for it in this slice. Do not report "Buddy writes in
// the Principal's language" as a verified host check until such a probe exists;
// what is verified today is that the declaration reaches the request.

import { readProfileContractDocument } from "./profile-mount.ts";

export type GrammaticalGender = "masculine" | "feminine" | "neuter" | "none";

export interface AddressBlock {
  name?: string;
  language?: string;
  gender?: GrammaticalGender;
  /** How the Principal addresses the Buddy. */
  addressToBuddy?: string;
  /** How the Buddy addresses the Principal. */
  addressToPrincipal?: string;
}

const SECTION = /^##\s+Name and address\s*$/im;

/** A value that is still the template's placeholder has declared nothing. */
function declared(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("<") || trimmed.includes(">")) return undefined;
  return trimmed;
}

/** The first backtick-quoted span on a line, which is how the template writes values. */
function quoted(line: string, after: number): string | undefined {
  const rest = line.slice(after);
  const match = /`([^`]*)`/.exec(rest);
  return match?.[1];
}

function normalizeGender(value: string | undefined): GrammaticalGender | undefined {
  const raw = declared(value)?.toLowerCase();
  if (!raw) return undefined;
  for (const candidate of ["masculine", "feminine", "neuter"] as const) {
    if (raw.startsWith(candidate)) return candidate;
  }
  // "none — the language does not inflect" is a real, declared answer: it means
  // the question does not arise, not that it is unanswered.
  if (raw.startsWith("none")) return "none";
  // Anything else is NOT interpreted. We would rather say nothing than invent a
  // reading of a word the Principal wrote.
  return undefined;
}

/** Parses § *Name and address* out of a CONSTITUTION.md body. */
export function parseAddressBlock(markdown: string): AddressBlock {
  const start = markdown.search(SECTION);
  if (start < 0) return {};
  const body = markdown.slice(start);
  const end = body.search(/^##\s+(?!Name and address)/m);
  const section = end > 0 ? body.slice(0, end) : body;

  const block: AddressBlock = {};
  for (const line of section.split("\n")) {
    const lower = line.toLowerCase();
    const at = (needle: string) => lower.indexOf(needle);
    if (at("grammatical gender") >= 0) {
      block.gender = normalizeGender(quoted(line, at("grammatical gender")));
      continue;
    }
    if (at("my name:") >= 0) {
      block.name = declared(quoted(line, at("my name:")));
      continue;
    }
    if (at("we speak:") >= 0) {
      block.language = declared(quoted(line, at("we speak:")));
      continue;
    }
    if (at("addresses me:") >= 0) {
      // Two values on one line: "<how they address me>", and I address them
      // "<how I address them>".
      const spans = [...line.matchAll(/`([^`]*)`/g)].map((match) => match[1]);
      block.addressToBuddy = declared(spans[0]);
      block.addressToPrincipal = declared(spans[1]);
    }
  }
  return block;
}

/**
 * The system preamble derived from a declared block, or null when the profile
 * declares nothing at all (in which case the request is exactly what it is today).
 */
export function addressDirective(block: AddressBlock): string | null {
  const lines: string[] = [];
  if (block.name) lines.push(`- Your name is ${block.name}.`);
  if (block.language) {
    lines.push(
      `- You and your Principal speak ${block.language}. Write in that language ` +
        "unless your Principal writes to you in another one.",
    );
  }
  if (block.gender === "none") {
    lines.push(
      "- Your Principal has declared that this language does not inflect for " +
        "grammatical gender, so nothing follows from your name's form.",
    );
  } else if (block.gender) {
    lines.push(
      `- The grammatical gender of your name in that language is ${block.gender}. ` +
        "Inflect every sentence you write about yourself accordingly — verbs, " +
        "adjectives and participles included.",
    );
  } else if (block.name || block.language) {
    // Declared identity, undeclared gender: say what to do about it rather than
    // leaving the model to guess from the name.
    lines.push(
      "- Your name's grammatical gender is NOT declared. Write without gendered " +
        "self-reference rather than guessing it from your name, and ask your " +
        "Principal to fill in CONSTITUTION.md § Name and address.",
    );
  }
  if (block.addressToBuddy) {
    lines.push(`- Your Principal addresses you as ${block.addressToBuddy}.`);
  }
  if (block.addressToPrincipal) {
    lines.push(`- You address your Principal as ${block.addressToPrincipal}.`);
  }
  if (lines.length === 0) return null;

  return [
    "Name and address — declared by your Principal in CONSTITUTION.md " +
      "§ Name and address of their private Buddy profile. These facts are " +
      "DECLARED, never inferred: do not derive any of them from your name.",
    ...lines,
  ].join("\n");
}

export interface ProfileReadResult {
  directive: string | null;
  /** Why there is no directive — for the operator's log, never for the Principal. */
  reason?: string;
}

/**
 * Reads the address directive out of a declared `<login>-buddy` profile.
 *
 * `profileDir` is the Principal's own profile checkout, read in place.
 * Every failure is non-fatal and reported: a Buddy with no declared block is a
 * Buddy that avoids gendered self-reference, not a Buddy that fails to start.
 */
export function readProfileDirective(profileDir: string | undefined): ProfileReadResult {
  const dir = profileDir?.trim();
  if (!dir) return { directive: null, reason: "no BUDDY_PROFILE_DIR declared" };
  let body: string;
  try {
    body = readProfileContractDocument(dir, "CONSTITUTION.md");
  } catch {
    return { directive: null, reason: `CONSTITUTION.md under ${dir} is unreadable` };
  }
  const directive = addressDirective(parseAddressBlock(body));
  if (!directive) {
    return {
      directive: null,
      reason:
        "CONSTITUTION.md § Name and address declares nothing yet " +
        "(still the template placeholders) — writing without gendered self-reference",
    };
  }
  return { directive };
}
