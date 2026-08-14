// bridge/agency — the moral contract, in the turn.
//
// THE FAILURE THIS EXISTS FOR. ARCHITECTURE §2.6 says the moral contract is not
// optional: every profile carries `CONSTITUTION.md` and `MANDATES.md`, and the
// profile templates spell both out at length. Until this
// module, the only thing the bridge read out of that profile was the four-line
// § *Name and address* block; the request the runtime received was the Principal's
// text and nothing else. So a Buddy could be told, in a document its Principal
// had formally accepted, that it must escalate rather than act — and never see
// that sentence in any turn it took. The documents existed; the runtime did not
// read them.
//
// WHAT THIS MODULE DOES, AND WHAT IT DELIBERATELY DOES NOT.
//
//   * It assembles ONE `{role:"system"}` message per turn: who this Buddy is
//     (BUDDY_NAME), who is writing to it right now, the declared address block,
//     then CONSTITUTION.md and MANDATES.md **verbatim**.
//   * VERBATIM IS THE POINT. Nothing here summarises, reorders, filters or
//     "activates" a mandate. A record reading `Status: proposed` reaches the
//     model exactly as the Principal wrote it, next to the paragraph in the same
//     file that says a proposed record grants nothing. Buddy reads its own
//     contract; the bridge is not a second authority that decides what is in it.
//   * THERE IS NO MANDATE PARSER. The single generated line is an ANNOTATION:
//     today's date, and the names of records whose `Expires` is a concrete date
//     already in the past. It changes no status and revokes nothing. That
//     distinction is load-bearing — an expiry the bridge *enforced* would be a
//     per-action permission machine, which ARCHITECTURE §2.6 forbids, and it would
//     the bridge in the position of adjudicating a document only the Principal
//     may adjudicate. What the annotation buys is the one thing a language model
//     genuinely cannot do for itself: know what day it is.
//
// PRIVACY. The assembled text is the Principal's own accepted document. It is
// sent to the Principal's own runtime on their own host and NOWHERE else: it never
// enters a log line, an error message, delivery telemetry or lifecycle evidence.
// The delivery log is built only from closed vocabularies (telemetry/
// delivery-log.ts), which is what makes that promise structural rather than
// editorial — and `system-message.test.ts` re-asserts it against a body large
// enough that a truncating logger would still leak a recognizable fragment.

import { addressDirective, parseAddressBlock } from "../identity/address-block.ts";
import { readProfileContractDocument } from "../identity/profile-mount.ts";

export interface AgencyProfile {
  /** CONSTITUTION.md, verbatim, or null when the profile does not carry one. */
  constitution: string | null;
  /** MANDATES.md, verbatim, or null when the profile does not carry one. */
  mandates: string | null;
  /** Why a document is missing — operator-facing, never the Principal's text. */
  notes: string[];
}

/**
 * Read the two agency documents out of the mounted `<login>-buddy` profile.
 *
 * The bridge runs on the host now, so this is a plain read of a canonical
 * read-only path — no bind mount, no container. Every failure is non-fatal and
 * reported: a Buddy with no profile is a Buddy that takes turns with no contract
 * in front of it, which is exactly what it did before this module existed, and
 * the operator sees why. The custody gate that decides whether the path may be
 * read at all is `bridge/identity/profile-mount.ts`, and it runs first.
 */
export function readAgencyProfile(
  profileDir: string | undefined,
): AgencyProfile {
  const dir = profileDir?.trim();
  if (!dir) {
    return {
      constitution: null,
      mandates: null,
      notes: ["no BUDDY_PROFILE_DIR declared"],
    };
  }
  const notes: string[] = [];
  const readDocument = (name: "CONSTITUTION.md" | "MANDATES.md"): string | null => {
    try {
      const body = readProfileContractDocument(dir, name);
      if (!body.trim()) {
        notes.push(`${name} under ${dir} is empty`);
        return null;
      }
      return body;
    } catch {
      notes.push(`${name} under ${dir} is unreadable`);
      return null;
    }
  };
  return {
    constitution: readDocument("CONSTITUTION.md"),
    mandates: readDocument("MANDATES.md"),
    notes,
  };
}

const RECORD_HEADING = /^###\s+`?([^`\n]+?)`?\s*$/;
const EXPIRES_LINE = /^\s*[-*]\s*Expires:\s*`?([^`\n]*?)`?\s*$/i;
const CONCRETE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The names of mandate records whose `Expires` is a concrete date strictly
 * before `today`. A placeholder, `never`, an event-relative phrase or anything
 * this function cannot read as a date is NOT reported — an unreadable expiry is
 * not an expired mandate, and inventing one would be the bridge deciding.
 */
export function expiredMandateRecords(
  mandates: string | null,
  today: string,
): string[] {
  if (!mandates || !CONCRETE_DATE.test(today)) return [];
  const expired: string[] = [];
  let record: string | null = null;
  for (const line of mandates.split("\n")) {
    const heading = RECORD_HEADING.exec(line);
    if (heading) {
      record = heading[1].trim();
      continue;
    }
    if (/^##\s/.test(line)) {
      record = null;
      continue;
    }
    const expires = EXPIRES_LINE.exec(line);
    if (!expires || !record) continue;
    const value = expires[1].trim();
    if (CONCRETE_DATE.test(value) && value < today) expired.push(record);
    record = null;
  }
  return [...new Set(expired)];
}

export interface SystemMessageInput {
  buddyName: string;
  /** The Zulip display name of whoever wrote the message being answered. */
  senderDisplayName: string;
  profile: AgencyProfile;
  /** ISO calendar date, `YYYY-MM-DD`, of the host's today. */
  today: string;
}

/**
 * The one system message a turn carries, or null when there is nothing to say —
 * no profile, no declared address block. Null means the request is byte-for-byte
 * what it was before agency had a reader, so a host with no profile is
 * unaffected.
 */
export function assembleSystemMessage(
  input: SystemMessageInput,
): string | null {
  const sections: string[] = [];
  const sender = input.senderDisplayName.trim() || "your Principal";
  sections.push(
    [
      `You are ${input.buddyName}, the personal Buddy of the Principal whose ` +
        "profile follows. You are writing in their own private Zulip, which " +
        "holds exactly the two of you.",
      `The message you are answering was written by ${sender}.`,
    ].join("\n"),
  );

  if (input.profile.constitution) {
    const directive = addressDirective(
      parseAddressBlock(input.profile.constitution),
    );
    if (directive) sections.push(directive);
  }

  // The generated line. It is the only sentence in this message the Principal
  // did not write, and it says so.
  const expired = expiredMandateRecords(input.profile.mandates, input.today);
  sections.push(
    [
      "Generated by your bridge, not written by your Principal:",
      `- Today is ${input.today}.`,
      expired.length === 0
        ? "- Records whose Expires is before today: none."
        : `- Records whose Expires is before today: ${expired.join(", ")}.`,
      "  This is an annotation, not a ruling. Your bridge does not decide what " +
        "your mandates permit; read the records themselves and apply the rules " +
        "your Principal wrote in them.",
    ].join("\n"),
  );

  if (input.profile.constitution) {
    sections.push(
      "--- CONSTITUTION.md, verbatim, from your Principal's profile ---\n" +
        input.profile.constitution.trim(),
    );
  }
  if (input.profile.mandates) {
    sections.push(
      "--- MANDATES.md, verbatim, from your Principal's profile ---\n" +
        input.profile.mandates.trim(),
    );
  }

  // K3 is a conjunction: the contract is the constitution AND the mandates, so
  // a turn carries the whole of it or it does not go. Half a contract on the
  // wire would read as a Buddy with a constitution and no rules — say nothing
  // rather than assert a contract that does not exist. The startup gate
  // (profile-mount.ts) makes this unreachable on a healthy install; this is the
  // per-turn backstop, not the primary refusal.
  if (!input.profile.constitution || !input.profile.mandates) return null;
  return sections.join("\n\n");
}

export type SystemMessageBuilder = (context: {
  senderDisplayName: string;
}) => string | null;

/**
 * The per-turn builder the runtime client calls. The profile is read ONCE at
 * start-up — it is a git checkout the Principal advances deliberately, not a
 * hot-reload surface — while the date and the sender are resolved per turn, so a
 * bridge that has been up since Tuesday does not say it is still Tuesday.
 */
export function createSystemMessageBuilder(options: {
  buddyName: string;
  profile: AgencyProfile;
  now?: () => Date;
}): SystemMessageBuilder {
  const now = options.now ?? (() => new Date());
  return ({ senderDisplayName }) =>
    assembleSystemMessage({
      buddyName: options.buddyName,
      senderDisplayName,
      profile: options.profile,
      today: now().toISOString().slice(0, 10),
    });
}
