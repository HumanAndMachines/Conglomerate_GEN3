// COVERS: the in-process custody gate on the ONE directory the input-facing
// bridge may open. That the judgement is made on the RESOLVED path (a symlink and
// a `..` are collapsed first, so a path that spells the profile and points at the
// memory repo is judged as the memory repo); that a Personalspace root declared
// one directory too high is refused; that a secret-shaped file inside the profile
// is refused with its name listed; that NOTHING DECLARED is a refusal and not a
// default; and that the refusal is loud, carries a remedy, and never quotes the
// Principal's own text.
//
// DOES NOT COVER: the KERNEL layer under all of this. The bridge runs under its
// own uid `buddy-bridge`, in no group but its own (ARCHITECTURE §10.3.2), and
// that uid — not this file — is what holds when a check here is wrong. Whether
// the uid exists, whether it can traverse to the profile and whether it can read
// anything else in the Conglomerate tree are host facts, owned by the install
// seam (exec ring) and by T3. Nor does it cover containment: "is this path inside
// the Personalspace?" is not decidable from a bare path, which is why the gate
// judges the directory's CONTENT contract instead.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIDGE_EXIT_CONFIG_REFUSED,
  assertProfileMountIsSafe,
  inspectProfileMount,
} from "../../bridge/identity/profile-mount.ts";
import { readAgencyProfile } from "../../bridge/agency/system-message.ts";
import { readProfileDirective } from "../../bridge/identity/address-block.ts";
import { startupExitCode } from "../../bridge/run.ts";
import { zulipConfigFromEnv } from "../../bridge/outbound/zulip.ts";
import { createRuntimeReplyProvider } from "../../bridge/runtime-adapter/http-client.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "buddy-profile-"));
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
}

const PROFILE = {
  "CONSTITUTION.md": "# Buddy constitution\n",
  "MANDATES.md": "# Buddy standing mandates\n",
  "onboarding/role-understanding.md": "# role\n",
};

describe("a real profile is accepted, and what is accepted is the RESOLVED path", () => {
  test("a secret-free <login>-buddy checkout passes and reports its resolved path", () => {
    const dir = tree(PROFILE);
    const verdict = inspectProfileMount(dir);
    expect(verdict.ok).toBe(true);
    expect(verdict.resolved).toBeDefined();
    expect(assertProfileMountIsSafe(dir)).toBe(verdict.resolved);
  });

  test("a symlink that POINTS somewhere else is judged by where it points", () => {
    // The concrete accident: `personalspace/<login>_GEN3/buddy` is one keystroke
    // and one `ln -s` away from the memory repo next to it. A string comparison
    // passes that; `realpath` does not.
    const memory = tree({ "README.md": "# gbrain memory\n", "notes/day.md": "…\n" });
    const parent = mkdtempSync(join(tmpdir(), "buddy-space-"));
    const link = join(parent, "buddy");
    symlinkSync(memory, link);
    const verdict = inspectProfileMount(link);
    expect(verdict.ok).toBe(false);
    // The reason names the RESOLVED directory, not the pretty name.
    expect(verdict.reason).toContain(memory);
    expect(verdict.reason).toContain("no CONSTITUTION.md");
  });

  test("`..` is collapsed before anything is judged", () => {
    const dir = tree(PROFILE);
    expect(inspectProfileMount(join(dir, "onboarding", "..")).ok).toBe(true);
    expect(inspectProfileMount(join(dir, "onboarding", "..", "..")).ok).toBe(false);
  });
});

describe("the refusals, each for a failure somebody actually made", () => {
  test("a Personalspace ROOT declared one directory too high is refused", () => {
    const root = tree({
      "personal.gen3.json": "{}",
      "buddy/CONSTITUTION.md": "# constitution\n",
      "gbrain/README.md": "# memory\n",
    });
    const verdict = inspectProfileMount(root);
    expect(verdict.ok).toBe(false);
    // BUDDY_PROFILE_PATH=/srv/personalspace instead of
    // /srv/personalspace/<login>_GEN3/buddy is one keystroke, and it would put
    // the person's whole memory in front of the parser of untrusted text while
    // every service reported healthy.
    expect(verdict.reason).toContain("one directory too high");
  });

  test("a secret-shaped file inside the profile is refused, and named", () => {
    const dir = tree({ ...PROFILE, "secrets/id_ed25519": "PRIVATE KEY\n" });
    const verdict = inspectProfileMount(dir);
    expect(verdict.ok).toBe(false);
    expect(verdict.offenders).toContain(join("secrets", "id_ed25519"));
    // Names only. The gate never reads a byte of what it refuses.
    expect(verdict.reason).not.toContain("PRIVATE KEY");
  });

  test("contract documents cannot be symlinks into a private store", () => {
    const privateStore = tree({ "principal-memory.md": "private memory marker\n" });
    const dir = tree({ "MANDATES.md": "# Buddy standing mandates\n" });
    symlinkSync(join(privateStore, "principal-memory.md"), join(dir, "CONSTITUTION.md"));

    const verdict = inspectProfileMount(dir);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("symlink or non-regular file");
    expect(verdict.reason).not.toContain("private memory marker");
    expect(readAgencyProfile(dir).constitution).toBeNull();
    expect(readProfileDirective(dir).directive).toBeNull();
  });

  test("NOTHING DECLARED is a refusal, not a default", () => {
    // Scar R7's structural half. In the archive this was OK and meant "no
    // contract in this turn", which is how a Buddy could take every turn of its
    // life without its own constitution while the install log stayed green.
    for (const declared of [undefined, "", "   "]) {
      const verdict = inspectProfileMount(declared);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain("does not answer");
    }
  });

  test("an empty checkout is a materialization that did not happen", () => {
    const empty = mkdtempSync(join(tmpdir(), "buddy-empty-"));
    expect(inspectProfileMount(empty).ok).toBe(false);
    expect(inspectProfileMount(empty).reason).toContain("has not happened");
  });

  test("half a contract is refused at START, not turn by turn at three a.m.", () => {
    // K3 is a conjunction. A profile with a constitution and no MANDATES.md
    // used to pass this gate and then have EVERY turn refused at the runtime
    // seam — a per-turn dead-letter loop instead of one loud exit 78 while
    // somebody is still at the keyboard. Emptiness counts as absence.
    const noMandates = tree({ "CONSTITUTION.md": "# Buddy constitution\n" });
    const missing = inspectProfileMount(noMandates);
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain("no MANDATES.md");

    const emptyMandates = tree({
      "CONSTITUTION.md": "# Buddy constitution\n",
      "MANDATES.md": "   \n",
    });
    const empty = inspectProfileMount(emptyMandates);
    expect(empty.ok).toBe(false);
    expect(empty.reason).toContain("EMPTY MANDATES.md");

    const emptyConstitution = tree({
      "CONSTITUTION.md": "\n",
      "MANDATES.md": "# Buddy standing mandates\n",
    });
    expect(inspectProfileMount(emptyConstitution).ok).toBe(false);
    expect(inspectProfileMount(emptyConstitution).reason).toContain("EMPTY CONSTITUTION.md");
  });

  test("a declared path that does not exist is refused rather than ignored", () => {
    expect(inspectProfileMount("/nonexistent/buddy-profile").ok).toBe(false);
  });
});

describe("the refusal is loud, and a monitor can see it", () => {
  test("the thrown message carries the remedy and the reason", () => {
    const root = tree({ "personal.gen3.json": "{}", "buddy/CONSTITUTION.md": "x" });
    let thrown: Error | undefined;
    try {
      assertProfileMountIsSafe(root);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toStartWith("refusing to start:");
    expect(thrown!.message).toContain("BUDDY_PROFILE_DIR");
    expect(thrown!.message).toContain("read-only does not make the wrong directory safe");
  });

  test("SCAR-R10 a configuration refusal exits with the code the unit will not restart on", () => {
    // With a wrong profile directory the archive's unit restarted eleven times in
    // sixty seconds while `systemctl is-active` said `activating` the whole time
    // and never `failed`. The refusal was correct and well written; the monitor
    // could not see it. 78 is EX_CONFIG, and the unit carries
    // RestartPreventExitStatus=78.
    expect(BRIDGE_EXIT_CONFIG_REFUSED).toBe(78);
    const refusal = (() => {
      try {
        assertProfileMountIsSafe(undefined);
        return null;
      } catch (error) {
        return error as Error;
      }
    })();
    expect(refusal).not.toBeNull();
    expect(startupExitCode(refusal)).toBe(BRIDGE_EXIT_CONFIG_REFUSED);

    // The FALSE path, without which this is a boolean that cannot be false: a
    // transient fault must NOT take the no-restart code, or a reboot race would
    // leave a Buddy dead until somebody notices.
    expect(startupExitCode(new Error("Zulip GET events transport failed"))).toBe(1);
    expect(startupExitCode(new Error("another Buddy bridge is already running"))).toBe(1);
  });

  test("SCAR-R10 every permanent configuration refusal carries the classifying prefix", () => {
    // The classifier reads the message, so the message IS the contract: a
    // config-shaped throw without the prefix exits 1 and restart-loops for
    // ever — R10 for a different sentence. Each of these was found exiting 1
    // in review (2026-07-30): missing Zulip credentials, an unparseable
    // runtime endpoint, a wrong-scheme endpoint.
    const credentialRefusal = (() => {
      try {
        zulipConfigFromEnv({});
        return null;
      } catch (error) {
        return error as Error;
      }
    })();
    expect(credentialRefusal).not.toBeNull();
    expect(credentialRefusal!.message).toStartWith("refusing to start:");
    expect(startupExitCode(credentialRefusal)).toBe(BRIDGE_EXIT_CONFIG_REFUSED);

    for (const endpoint of ["not a url at all", "ftp://runtime.local/v1"]) {
      const thrown = (() => {
        try {
          createRuntimeReplyProvider({
            endpoint,
            apiKey: "k",
            model: "m",
            systemMessage: () => "contract",
          });
          return null;
        } catch (error) {
          return error as Error;
        }
      })();
      expect(thrown).not.toBeNull();
      expect(thrown!.message).toStartWith("refusing to start:");
      expect(startupExitCode(thrown)).toBe(BRIDGE_EXIT_CONFIG_REFUSED);
      // The endpoint value itself must not leak into the refusal.
      expect(thrown!.message).not.toContain("not a url at all");
    }
  });

  test("SCAR-R10 the unit really carries the directive the exit code depends on", async () => {
    // An exit code nothing acts on is a number in a file. The pair is the
    // mechanism, so both halves are asserted in one place.
    const unit = await Bun.file(
      join(import.meta.dir, "..", "..", "distribution", "runtime", "buddy-bridge.service.template"),
    ).text();
    expect(unit).toContain(`RestartPreventExitStatus=${BRIDGE_EXIT_CONFIG_REFUSED}`);
    expect(unit).toContain("User=buddy-bridge");
    expect(unit).toContain("Group=buddy-bridge");
    expect(unit).toContain("ReadWritePaths=@@QUEUE_ROOT@@");
    expect(unit).toContain("ExecStart=@@BUN_BIN@@ @@ACTIVE_ROOT@@/bridge/run.ts");
  });
});
