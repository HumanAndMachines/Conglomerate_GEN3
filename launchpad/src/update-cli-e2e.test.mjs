import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { runIsolatedLazurioUpdate } from "./lazurio-update-runner-lib.mjs";

const cleanup = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("isolated CLI runtime fast-forwards mutable root and rerun is idempotent", async () => {
  const fixture = await fixtureRoot();
  await remoteCommit(fixture);

  const first = await runIsolatedLazurioUpdate({ rootPath: fixture.working });
  expect(first).toMatchObject({ state: "updated", ok: true });
  const second = await runIsolatedLazurioUpdate({ rootPath: fixture.working });
  expect(second).toMatchObject({ state: "current", ok: true });
});

test("bun update entrypoint and lazurio update expose the same report contract", async () => {
  const fixture = await fixtureRoot();
  const launchpadEntry = join(import.meta.dirname, "update-cli.mjs");
  const lazurioEntry = join(import.meta.dirname, "..", "..", "lazurio", "cli.mjs");

  const launchpad = spawnSync(process.execPath, [launchpadEntry, "--json", "--root", fixture.working], {
    cwd: fixture.working,
    encoding: "utf8",
  });
  const lazurio = spawnSync(process.execPath, [lazurioEntry, "update", "--json", "--root", fixture.working], {
    cwd: fixture.working,
    encoding: "utf8",
  });
  expect(launchpad.status).toBe(0);
  expect(lazurio.status).toBe(0);
  const first = JSON.parse(launchpad.stdout);
  const second = JSON.parse(lazurio.stdout);
  expect(first.schema_version).toBe("lazurio.update.v1");
  expect(second.schema_version).toBe(first.schema_version);
  expect(["current", "updated", "blocked"]).toContain(first.state);
  expect(second.state).toBe("current");
});

async function fixtureRoot() {
  const sandbox = await mkdtemp(join(tmpdir(), "lazurio-update-cli-"));
  cleanup.push(sandbox);
  const remote = join(sandbox, "remote.git");
  const seed = join(sandbox, "seed");
  const contributor = join(sandbox, "contributor");
  const working = join(sandbox, "working");
  git(sandbox, ["init", "--bare", remote]);
  git(sandbox, ["clone", remote, seed]);
  configure(seed);
  git(seed, ["switch", "-c", "main"]);
  await writeFile(join(seed, "launchpad.gen3.json"), "{}\n");
  git(seed, ["add", "launchpad.gen3.json"]);
  git(seed, ["commit", "-m", "initial"]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(sandbox, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  git(sandbox, ["clone", remote, contributor]);
  git(sandbox, ["clone", remote, working]);
  configure(contributor);
  configure(working);
  return { sandbox, remote, contributor, working };
}

async function remoteCommit(fixture) {
  await writeFile(join(fixture.contributor, "remote.txt"), "remote\n");
  git(fixture.contributor, ["add", "remote.txt"]);
  git(fixture.contributor, ["commit", "-m", "remote"]);
  git(fixture.contributor, ["push", "origin", "main"]);
}

function configure(cwd) {
  git(cwd, ["config", "user.name", "Lazurio Test"]);
  git(cwd, ["config", "user.email", "lazurio@example.test"]);
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
