// COVERS: K3 end to end — the moral contract from the files on disk to the
// bytes in the request body. That both documents travel VERBATIM; that the one
// generated line is an annotation and not a ruling; that the date advances
// between turns without a restart; that a contract of the size really measured on
// the wire (36 194 characters, Host #1, 2026-07-29) arrives WHOLE; and that K3 is
// FAIL-CLOSED — a turn with no contract is refused, not sent bare.
//
// DOES NOT COVER: whether the runtime OBEYS the contract. A fake provider proves
// DELIVERY of the contract and can never prove obedience to it — mandate
// compliance, refusal outside a mandate, the hard stop on an expired record and
// prompt-injection resistance (ARCHITECTURE §2.6 rules 2, 3, 4, 7) are
// permanently outside any tier (TESTING.md §5). Nor does it cover the profile
// TEMPLATE's own text, which belongs to the profile work order.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleSystemMessage,
  createSystemMessageBuilder,
  expiredMandateRecords,
  readAgencyProfile,
} from "../../bridge/agency/system-message.ts";
import { createRuntimeReplyProvider } from "../../bridge/runtime-adapter/http-client.ts";
import type { BridgeReplyInput } from "../../bridge/inbound/message.ts";

/**
 * The size of the assembled system message really observed on the wire on
 * Host #1 on 2026-07-29 (`role=system chars=36194`). It is written down as a
 * FLOOR the transport must survive, not as an exact expectation: a Principal's
 * documents grow, and a test pinned to an exact byte count would go red on a
 * paragraph and green on a truncation.
 */
const MEASURED_CONTRACT_CHARS = 36_194;

function profileDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "buddy-agency-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

const CONSTITUTION = [
  "# Buddy constitution",
  "",
  "## Name and address",
  "",
  "- **My name:** `Nova`",
  "- **We speak:** `Czech`.",
  "- **My name's grammatical gender in that language:** `feminine`.",
  "",
  "## Duties",
  "",
  "I escalate rather than guess when a boundary is unclear.",
  "",
].join("\n");

const MANDATES = [
  "# Buddy standing mandates",
  "",
  "## Candidate mandates",
  "",
  "### `owner-repository-work`",
  "",
  "- Status: `active`",
  "- Expires: `2026-01-01`",
  "",
  "### `pr-review-sweep`",
  "",
  "- Status: `active`",
  "- Expires: `2099-12-31`",
  "",
  "### `gbrain-memory`",
  "",
  "- Status: `proposed`",
  "- Expires: `never`",
  "",
].join("\n");

const JOB: BridgeReplyInput = {
  text: "ahoj",
  senderName: "Ada Lovelace",
  trigger: "direct_message",
  conversationKind: "private",
  sessionId: "buddy-zulip-private-abc123",
  messageId: 4242,
  replyTarget: { kind: "private", recipientEmails: ["ada@realm.test"] },
};

interface Captured {
  body: any;
  headers: Record<string, string>;
}

/** Runs one turn against a fake runtime and hands back what went on the wire. */
async function oneTurn(options: {
  constitution?: string | null;
  mandates?: string | null;
  today?: string;
}): Promise<Captured> {
  const files: Record<string, string> = {};
  if (options.constitution !== null) {
    files["CONSTITUTION.md"] = options.constitution ?? CONSTITUTION;
  }
  if (options.mandates !== null) files["MANDATES.md"] = options.mandates ?? MANDATES;
  const build = createSystemMessageBuilder({
    buddyName: "Nova",
    profile: readAgencyProfile(profileDir(files)),
    now: () => new Date(`${options.today ?? "2026-07-27"}T09:00:00Z`),
  });
  let captured: Captured = { body: null, headers: {} };
  const provider = createRuntimeReplyProvider({
    endpoint: "http://127.0.0.1:8642/v1/chat/completions",
    apiKey: "k",
    model: "hermes",
    systemMessage: (input) => build({ senderDisplayName: input.senderName }),
    fetchImpl: (async (_url: string, init: any) => {
      captured = { body: JSON.parse(init.body), headers: init.headers };
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    }) as unknown as typeof fetch,
  });
  await provider(JOB);
  return captured;
}

describe("K3 — the contract reaches the wire, layered and verbatim", () => {
  test("one system message, then the Principal's text, in that order", async () => {
    const { body } = await oneTurn({});
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1]).toEqual({ role: "user", content: "ahoj" });
    // Layering, not replacing: our message is the FIRST one, and the runtime's
    // own system prompt is underneath it where we cannot see it.
    expect(body.stream).toBe(false);
  });

  test("both documents arrive verbatim, including a record the bridge does not act on", async () => {
    const { body } = await oneTurn({});
    const system: string = body.messages[0].content;
    // VERBATIM means verbatim: the sentence the Principal wrote about escalating
    // is IN the turn, not a summary of it.
    expect(system).toContain("I escalate rather than guess when a boundary is unclear.");
    // A `proposed` record reaches the model exactly as written, next to the
    // paragraph that says a proposed record grants nothing. The bridge is not a
    // second authority deciding what is in the Principal's own document.
    expect(system).toContain("### `gbrain-memory`");
    expect(system).toContain("- Status: `proposed`");
    expect(system).toContain("You are Nova");
    expect(system).toContain("written by Ada Lovelace");
  });

  test("a contract the size of the one really measured on the wire arrives WHOLE", async () => {
    // The floor is a measurement, not a guess: 36 194 characters of assembled
    // system message went over this hop on Host #1 on 2026-07-29. What this test
    // asserts is that nothing between the file and the body truncates it — the
    // last line of the LAST document is the one a truncation eats first.
    const tail = "ZAVERECNA-VETA-KONTRAKTU";
    const bigMandates = [
      MANDATES,
      ...Array.from(
        { length: 400 },
        (_, index) =>
          `### \`mandate-${index}\`\n\n- Status: \`active\`\n- Expires: \`2099-12-31\`\n- Scope: ${"x".repeat(60)}\n`,
      ),
      `### \`${tail}\`\n`,
    ].join("\n");
    const { body } = await oneTurn({ mandates: bigMandates });
    const system: string = body.messages[0].content;
    expect(system.length).toBeGreaterThanOrEqual(MEASURED_CONTRACT_CHARS);
    expect(system).toContain(tail);
    // And the transport really carried it: the serialized body is at least as
    // large as the message we counted.
    expect(JSON.stringify(body).length).toBeGreaterThanOrEqual(MEASURED_CONTRACT_CHARS);
  });

  test("FAIL-CLOSED: with no contract to send, the turn is refused rather than sent bare", async () => {
    // Scar R7 in its forward direction. The archive sent `[{role:"user"}]` and
    // answered normally, so a Buddy could live its whole life without ever
    // seeing its own constitution while every log stayed green. ARCHITECTURE
    // §2.6 says the contract is read in EVERY turn; a turn without it is not a
    // degraded turn, it is not a turn.
    const provider = createRuntimeReplyProvider({
      endpoint: "http://127.0.0.1:8642/v1/chat/completions",
      apiKey: "k",
      model: "hermes",
      systemMessage: () => null,
      fetchImpl: (async () => {
        throw new Error("the runtime must never be dialled without a contract");
      }) as unknown as typeof fetch,
    });
    await expect(provider(JOB)).rejects.toThrow(/no moral contract/);
  });

  test("the refusal names the remedy and never quotes the Principal", async () => {
    const provider = createRuntimeReplyProvider({
      endpoint: "http://127.0.0.1:8642/v1/chat/completions",
      apiKey: "k",
      model: "hermes",
      systemMessage: () => "   ",
      fetchImpl: (async () => Response.json({})) as unknown as typeof fetch,
    });
    const error = await provider(JOB).catch((thrown: Error) => thrown);
    expect((error as Error).message).toContain("BUDDY_PROFILE_DIR");
    expect((error as Error).message).not.toContain("ahoj");
  });
});

describe("the one generated line is an annotation, not a ruling", () => {
  test("only a concrete date already past is reported expired", () => {
    expect(expiredMandateRecords(MANDATES, "2026-07-27")).toEqual([
      "owner-repository-work",
    ]);
  });

  test("`never`, a placeholder and an unreadable value are never called expired", () => {
    const withPlaceholders = [
      "### `a`",
      "- Expires: `never`",
      "### `b`",
      "- Expires: `<YYYY-MM-DD or never — the Principal writes it>`",
      "### `c`",
      "- Expires: `when the pilot ends`",
      "",
    ].join("\n");
    // An expiry this function cannot read is NOT an expired mandate. Inventing
    // one would be the bridge adjudicating a document only the Principal may
    // adjudicate — and that is a per-action permission machine by the back door.
    expect(expiredMandateRecords(withPlaceholders, "2026-07-27")).toEqual([]);
  });

  test("the message labels the generated line and says nothing expired when nothing did", async () => {
    const expired: string = (await oneTurn({})).body.messages[0].content;
    expect(expired).toContain("Generated by your bridge, not written by your Principal");
    expect(expired).toContain("- Today is 2026-07-27.");
    expect(expired).toContain("- Records whose Expires is before today: owner-repository-work.");
    expect(expired).toContain("This is an annotation, not a ruling");

    const none: string = (await oneTurn({ today: "2025-01-01" })).body.messages[0].content;
    expect(none).toContain("- Records whose Expires is before today: none.");
  });

  test("the date advances between turns without a restart", () => {
    let day = "2026-07-27";
    const build = createSystemMessageBuilder({
      buddyName: "Nova",
      profile: readAgencyProfile(
        profileDir({ "CONSTITUTION.md": CONSTITUTION, "MANDATES.md": MANDATES }),
      ),
      now: () => new Date(`${day}T09:00:00Z`),
    });
    expect(build({ senderDisplayName: "Ada" })).toContain("Today is 2026-07-27");
    day = "2026-07-28";
    expect(build({ senderDisplayName: "Ada" })).toContain("Today is 2026-07-28");
  });
});

describe("the contract stays off every other surface", () => {
  test("a large contract never reaches an error message or a stack", async () => {
    const marker = "CONFIDENTIAL-THERAPY-BOUNDARY-CLAUSE";
    const bulky = `${CONSTITUTION}\n${"filler paragraph. ".repeat(4000)}\n${marker}\n`;
    const build = createSystemMessageBuilder({
      buddyName: "Nova",
      profile: readAgencyProfile(
        profileDir({ "CONSTITUTION.md": bulky, "MANDATES.md": MANDATES }),
      ),
      now: () => new Date("2026-07-27T09:00:00Z"),
    });
    const provider = createRuntimeReplyProvider({
      endpoint: "http://127.0.0.1:8642/v1/chat/completions",
      apiKey: "shhh-bearer",
      model: "hermes",
      systemMessage: (input) => build({ senderDisplayName: input.senderName }),
      fetchImpl: (async () =>
        Response.json({ error: "upstream exploded" }, { status: 502 })) as unknown as typeof fetch,
    });
    const error = (await provider(JOB).catch((thrown: Error) => thrown)) as Error;
    const serialized = `${error.message}\n${error.stack ?? ""}`;
    expect(serialized.length).toBeGreaterThan(0);
    for (const secret of [marker, "I escalate rather than guess", "ahoj", "shhh-bearer"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("nothing declared at all yields no message — which the client then refuses", () => {
    // The assembler's honest answer is null; the REFUSAL is the client's job.
    // Keeping the two apart is what lets the assembler stay a pure function.
    expect(
      assembleSystemMessage({
        buddyName: "Buddy",
        senderDisplayName: "Ada",
        profile: readAgencyProfile(undefined),
        today: "2026-07-27",
      }),
    ).toBeNull();
  });

  test("half a contract yields no message either — K3 is a conjunction", () => {
    // A constitution without mandates used to go on the wire as a Buddy with
    // opinions and no rules. The startup gate makes this unreachable on a
    // healthy install; the assembler is the per-turn backstop.
    for (const profile of [
      { constitution: "# Buddy constitution\n", mandates: null, notes: [] },
      { constitution: null, mandates: "# Buddy standing mandates\n", notes: [] },
    ]) {
      expect(
        assembleSystemMessage({
          buddyName: "Buddy",
          senderDisplayName: "Ada",
          profile,
          today: "2026-07-27",
        }),
      ).toBeNull();
    }
  });
});

