// The custody gate on the directory BUDDY_PROFILE_DIR actually names, asserted
// from INSIDE the input-facing bridge process. Only the Principal may reach the
// private communication surface; this check catches a miswired host profile,
// rather than trying to authorize chat participants a second time.
//
// WHAT THE BRIDGE IS ALLOWED TO OPEN, AND WHY THE LIST IS THIS SHORT. The whole
// Conglomerate tree lives on this host: the Principal's modules, their private
// `<login>-gbrain` memory, their secrets directory. Of that entire tree the
// bridge may open exactly ONE directory — `<personalspace>/<login>_GEN3/buddy`,
// the profile — and it runs under its own uid `buddy-bridge`, in no group but
// its own. That uid is ordinary process separation against accidental bridge
// self-mutation, not Buddy's authorization boundary or the Agent sandbox. The
// latter belongs to Hermes. Everything in this file is a startup check the
// bridge can still make about a path the kernel would otherwise let it read.
//
// WHY THERE ARE TWO GATES, AND WHY THIS ONE IS NOT REDUNDANT. The resident host
// service installer resolves the declared path, refuses a path that is not a
// secret-free `<login>-buddy` checkout, and copies the RESOLVED value into the
// unit's EnvironmentFile. But the unit
// outlives the install run: `systemctl restart buddy-bridge` and every reboot
// start the process without going through the seam, so an EnvironmentFile edited
// afterwards reaches this process unchecked. This module is what the process
// itself verifies at every single start.
//
// THE CHECK IS ON THE RESOLVED PATH, NOT ON THE STRING. `realpath` collapses
// `..` and follows symlinks first, so `/srv/personalspace/owner_GEN3/buddy/../gbrain`
// and a `buddy` symlink pointing at the memory repo are both judged as what they
// ACTUALLY ARE. A string comparison is not a check; it is a spelling test that
// an attacker and a tired operator both pass.
//
// WHAT IT CANNOT DO. Containment ("is this inside the profile root?") is not
// decidable from a bare path alone. What IS observable is the content contract
// the declared directory rests on, and that is exactly what catches the accident
// this exists for: a Personalspace ROOT declared one directory too high has no
// CONSTITUTION.md at its top level and does have `personal.gen3.json` and the
// owner repositories next to it.
//
// FAIL LOUD, NOT QUIET. The refusal must stop the bridge, not degrade to "no
// profile read". A Buddy that silently stops reading its own CONSTITUTION writes
// without gendered self-reference and looks like a Buddy whose Principal has not
// filled the block in yet — the operator would have no reason to look, while the
// person's memory sits open to the input-facing bridge process.

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";

/** Names that must never appear inside a `<login>-buddy` profile checkout. */
const FORBIDDEN = [
  /^\.env$/,
  /^\.env\.(?!example$)/,
  /\.(key|pem|p12|pfx|secret|tfstate)$/,
  /^id_(rsa|ecdsa|ed25519)/,
  /^authorized_keys$/,
  /^\.git-credentials$/,
  /^\.netrc$/,
  // The Personalspace ROOT's own marker. Its presence means the declared
  // directory is the whole Personalspace, not the profile inside it.
  /^personal\.gen3\.json$/,
];

/** Directories whose contents are not scanned (a checkout's own git objects). */
const UNSCANNED = new Set([".git", "node_modules"]);

export interface ProfileMountVerdict {
  ok: boolean;
  /**
   * The RESOLVED directory the bridge may read — `realpath` of what was
   * declared. Present only when `ok`, and it is what the caller must open: a
   * caller that keeps using the declared string has resolved nothing.
   */
  resolved?: string;
  /** Why the mount was refused — operator-facing, never the Principal's text. */
  reason?: string;
  /** Offending paths, relative to the mount. Names only; contents are never read. */
  offenders?: string[];
}

export type ProfileContractName = "CONSTITUTION.md" | "MANDATES.md";

/**
 * Read one contract through a descriptor opened with O_NOFOLLOW.
 *
 * The lstat is the operator-facing shape check; O_NOFOLLOW is the actual
 * read-time guard against swapping the entry to a symlink between that check
 * and open. The descriptor is fstat'd as a final regular-file assertion.
 */
export function readProfileContractDocument(
  profileDir: string,
  name: ProfileContractName,
): string {
  const file = join(profileDir, name);
  const entry = lstatSync(file);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`${name} is a symlink or non-regular file`);
  }
  const descriptor = openSync(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`${name} is not a regular file`);
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Decides whether `mountDir` may be read by the input-facing bridge.
 *
 * FAIL-CLOSED IN BOTH DIRECTIONS, and this is where it differs from the archive.
 * There, an absent or empty profile was OK and simply meant "no contract in this
 * turn" — which is how a Buddy could take every turn of its life with neither
 * CONSTITUTION.md nor MANDATES.md in front of it while the install log stayed
 * green (scar R7). ARCHITECTURE §2.6 says the contract is read in every turn, so
 * NOTHING DECLARED is a refusal here, not a default. The install order puts the
 * profile on the host before the bridge unit exists; a host that has not got
 * there yet is a host whose Buddy must not be answering anybody.
 *
 * The secret-shaped scan is BOUNDED at `maxDepth` levels — four, the same bound
 * the install seam's own `find` uses, so the two gates make one promise instead
 * of two. It covers the shape of a real `<login>-buddy` checkout and the accident
 * this exists for (a Personalspace root carries personal.gen3.json at depth 1).
 * It does not cover a key buried at `a/b/c/d/id_ed25519`, and no document may
 * claim otherwise.
 */
export function inspectProfileMount(
  mountDir: string | undefined,
  maxDepth = 4,
): ProfileMountVerdict {
  const declared = mountDir?.trim();
  if (!declared) {
    return {
      ok: false,
      reason:
        "no profile directory is declared. Every turn carries CONSTITUTION.md " +
        "and MANDATES.md verbatim (ARCHITECTURE §2.6), so a Buddy with no " +
        "profile does not answer — it refuses to start",
    };
  }
  if (!existsSync(declared)) {
    return { ok: false, reason: `${declared} does not exist` };
  }
  // RESOLVE FIRST. `..` is collapsed and symlinks are followed before anything
  // is judged, so a path that spells the profile and points at the memory repo
  // is judged as the memory repo.
  let dir: string;
  try {
    dir = realpathSync(declared);
  } catch {
    return { ok: false, reason: `${declared} cannot be resolved to a real path` };
  }
  if (!statSync(dir).isDirectory()) {
    return { ok: false, reason: `${dir} is not a directory` };
  }
  if (readdirSync(dir).length === 0) {
    return {
      ok: false,
      reason:
        `${dir} is empty, so it carries no CONSTITUTION.md — an empty checkout ` +
        "is a materialization that has not happened, not a Buddy without opinions",
    };
  }

  if (!existsSync(join(dir, "CONSTITUTION.md"))) {
    return {
      ok: false,
      reason:
        `${dir} has no CONSTITUTION.md, so it is not a <login>-buddy profile ` +
        "checkout — a Personalspace root declared one directory too high looks " +
        "exactly like this",
    };
  }
  // K3 is a conjunction. The moral contract is CONSTITUTION.md AND MANDATES.md;
  // a profile carrying only one would start a bridge whose every turn is then
  // refused at the runtime seam — a per-turn dead-letter loop at 3 a.m. instead
  // of one loud exit 78 at install time, when somebody is watching. Emptiness
  // counts as absence: an empty document is a materialization that half
  // happened, not a Principal with nothing to say.
  for (const name of ["CONSTITUTION.md", "MANDATES.md"] as const) {
    const file = join(dir, name);
    let fileStat;
    try {
      // Judge the directory entry itself. `stat`/`readFile` would follow a
      // symlink and could put arbitrary private content in front of every turn.
      fileStat = lstatSync(file);
    } catch {
      return {
        ok: false,
        reason:
          `${dir} has no ${name} — the contract is CONSTITUTION.md and ` +
          "MANDATES.md together, and a profile carrying half of it would refuse " +
          "every turn at runtime instead of refusing to start here",
      };
    }
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      return {
        ok: false,
        reason:
          `${dir} carries ${name} as a symlink or non-regular file. Contract ` +
          "documents must be regular files inside the profile checkout so they " +
          "cannot redirect the bridge into gbrain, secrets, or another private store",
      };
    }
    let body: string;
    try {
      body = readProfileContractDocument(dir, name);
    } catch {
      return { ok: false, reason: `${dir} carries a ${name} this uid cannot read` };
    }
    if (!body.trim()) {
      return {
        ok: false,
        reason:
          `${dir} carries an EMPTY ${name} — a materialization that half ` +
          "happened, not a Principal with nothing to say",
      };
    }
  }

  const offenders: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (depth > maxDepth || offenders.length >= 20) return;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      if (FORBIDDEN.some((pattern) => pattern.test(entry))) {
        offenders.push(relative(dir, full));
        if (offenders.length >= 20) return;
        continue;
      }
      if (UNSCANNED.has(entry)) continue;
      let isDirectory = false;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) walk(full, depth + 1);
    }
  };
  walk(dir, 1);

  if (offenders.length > 0) {
    return {
      ok: false,
      reason: `${dir} carries files that must never enter the input-facing bridge`,
      offenders: offenders.sort(),
    };
  }
  return { ok: true, resolved: dir };
}

/**
 * The startup gate. Returns the RESOLVED profile directory, or throws — and the
 * caller exits with `BRIDGE_EXIT_CONFIG_REFUSED`, the code the unit refuses to
 * restart on, so the refusal reaches a monitor instead of hiding behind an
 * endless `activating` (scar R10).
 */
export function assertProfileMountIsSafe(mountDir: string | undefined): string {
  const verdict = inspectProfileMount(mountDir);
  if (verdict.ok && verdict.resolved) return verdict.resolved;
  const listed = verdict.offenders?.length
    ? `\n  offending entries: ${verdict.offenders.join(", ")}`
    : "";
  throw new Error(
    `refusing to start: the profile declared at ${mountDir ?? "<nothing>"} is not ` +
      `a secret-free <login>-buddy profile.\n  reason: ${verdict.reason}${listed}\n` +
      "  This directory is readable by the input-facing bridge process. Fix " +
      "BUDDY_PROFILE_DIR through the resident service installer and " +
      "restart the bridge; read-only does not make the wrong directory safe to read.",
  );
}

/**
 * The exit code a CONFIGURATION refusal uses, and nothing else does.
 *
 * 78 is `EX_CONFIG` from sysexits(3) — a name that already means this. The unit
 * carries `RestartPreventExitStatus=78`, so a bridge that refuses its own
 * configuration stops at `failed` instead of restarting for ever. Scar R10: with
 * a wrong profile directory the archive's unit restarted eleven times in sixty
 * seconds and `systemctl is-active` reported `activating` the whole time, never
 * `failed`. The refusal was correct and well written; it told the monitor
 * nothing. A retry loop is right for a runtime that is not up yet and wrong for a
 * path that will not change by itself.
 */
export const BRIDGE_EXIT_CONFIG_REFUSED = 78;
