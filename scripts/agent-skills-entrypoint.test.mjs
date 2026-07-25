import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAgentSkillsMirror,
  repairAgentSkillsMirror,
  trustedGitCandidates,
  trustedGitExecutable,
} from "./agent-skills-entrypoint.mjs";

const tempRoots = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(root, args) {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} selhalo: ${new TextDecoder().decode(result.stderr)}`);
  }
}

async function rootFixture(name, { slugs = ["example-skill"] } = {}) {
  const root = await mkdtemp(join(tmpdir(), `agent-skills-mirror-${name}-`));
  tempRoots.push(root);
  git(root, ["init", "--quiet"]);
  for (const slug of slugs) {
    await mkdir(join(root, ".agents", "skills", slug), { recursive: true });
    await writeFile(join(root, ".agents", "skills", slug, "SKILL.md"), `# ${slug}\n`);
  }
  await writeFile(
    join(root, ".agents", "skills", "manifest.json"),
    JSON.stringify({
      schema_version: "conglomerate.skills.v0",
      claude_compatibility: "tracked-derived-mirror",
      skills: slugs.map((slug) => ({ slug, path: `.agents/skills/${slug}/SKILL.md` })),
    }),
  );
  return root;
}

test("čerstvý checkout: check hlásí mirror_missing a repair mirror materializuje byte-for-byte", async () => {
  const root = await rootFixture("fresh");

  const before = await checkAgentSkillsMirror(root);
  expect(before.status).toBe("repair_needed");
  expect(before.code).toBe("mirror_missing");

  const after = await repairAgentSkillsMirror(root);
  expect(after.status).toBe("ok");
  expect(after.code).toBe("mirror_ready");
  const canonical = await readFile(join(root, ".agents", "skills", "example-skill", "SKILL.md"));
  const mirror = await readFile(join(root, ".claude", "skills", "example-skill", "SKILL.md"));
  expect(canonical.equals(mirror)).toBe(true);
});

test("legacy symlink: repair odstraní jen link záznam a cíl nechá nedotčený", async () => {
  const root = await rootFixture("legacy");
  await mkdir(join(root, ".claude"), { recursive: true });
  await symlink(join(root, ".agents", "skills"), join(root, ".claude", "skills"), "junction");

  const before = await checkAgentSkillsMirror(root);
  expect(before.code).toBe("mirror_legacy_link");

  const after = await repairAgentSkillsMirror(root);
  expect(after.status).toBe("ok");
  const canonical = await readFile(join(root, ".agents", "skills", "example-skill", "SKILL.md"), "utf8");
  expect(canonical).toBe("# example-skill\n");
});

test("drift mirroru: repair regeneruje obsah a odstraní neaktivní mirror skill", async () => {
  const root = await rootFixture("drift");
  await mkdir(join(root, ".claude", "skills", "example-skill"), { recursive: true });
  await writeFile(join(root, ".claude", "skills", "example-skill", "SKILL.md"), "# stale\n");
  await mkdir(join(root, ".claude", "skills", "removed-skill"), { recursive: true });
  await writeFile(join(root, ".claude", "skills", "removed-skill", "SKILL.md"), "# removed\n");

  const before = await checkAgentSkillsMirror(root);
  expect(before.code).toBe("mirror_drift");

  const after = await repairAgentSkillsMirror(root);
  expect(after.status).toBe("ok");
  const mirror = await readFile(join(root, ".claude", "skills", "example-skill", "SKILL.md"), "utf8");
  expect(mirror).toBe("# example-skill\n");
});

test("extra soubor v aktivním skill adresáři: repair failuje zavřeně a soubor přežije", async () => {
  const root = await rootFixture("active-extra");
  await mkdir(join(root, ".claude", "skills", "example-skill"), { recursive: true });
  await writeFile(join(root, ".claude", "skills", "example-skill", "SKILL.md"), "# example-skill\n");
  await writeFile(join(root, ".claude", "skills", "example-skill", "notes.md"), "lokální poznámky\n");

  const result = await repairAgentSkillsMirror(root);
  expect(result.status).toBe("blocked");
  expect(result.code).toBe("mirror_unknown_content");
  const survived = await readFile(join(root, ".claude", "skills", "example-skill", "notes.md"), "utf8");
  expect(survived).toBe("lokální poznámky\n");

  await rm(join(root, ".claude", "skills", "example-skill", "notes.md"));
  const after = await repairAgentSkillsMirror(root);
  expect(after.status).toBe("ok");
});

test("stray soubor přímo v mirroru: repair failuje zavřeně a soubor přežije", async () => {
  const root = await rootFixture("stray-file");
  await mkdir(join(root, ".claude", "skills"), { recursive: true });
  await writeFile(join(root, ".claude", "skills", "README.txt"), "stray\n");

  const result = await repairAgentSkillsMirror(root);
  expect(result.status).toBe("blocked");
  expect(result.code).toBe("mirror_unknown_content");
  const survived = await readFile(join(root, ".claude", "skills", "README.txt"), "utf8");
  expect(survived).toBe("stray\n");
});

test("neznámý obsah mirroru: repair failuje zavřeně a nic nemaže", async () => {
  const root = await rootFixture("unknown");
  await mkdir(join(root, ".claude", "skills", "scratch"), { recursive: true });
  await writeFile(join(root, ".claude", "skills", "scratch", "notes.md"), "moje poznámky\n");

  const result = await repairAgentSkillsMirror(root);
  expect(result.status).toBe("blocked");
  expect(result.code).toBe("mirror_unknown_content");
  const survived = await readFile(join(root, ".claude", "skills", "scratch", "notes.md"), "utf8");
  expect(survived).toBe("moje poznámky\n");
});

test("gitignored .claude/skills porušuje Git kontrakt mirroru", async () => {
  const root = await rootFixture("ignored");
  await writeFile(join(root, ".gitignore"), ".claude/skills\n");

  const result = await checkAgentSkillsMirror(root);
  expect(result.status).toBe("blocked");
  expect(result.code).toBe("entrypoint_contract_invalid");
  expect(result.problems.join(" ")).toContain(".gitignore");
});

test("slug s traversal cestou v manifestu je blocked manifest_invalid", async () => {
  const root = await rootFixture("traversal");
  await writeFile(
    join(root, ".agents", "skills", "manifest.json"),
    JSON.stringify({
      schema_version: "conglomerate.skills.v0",
      claude_compatibility: "tracked-derived-mirror",
      skills: [{ slug: "../../evil", path: ".agents/skills/../../evil/SKILL.md" }],
    }),
  );

  const state = await checkAgentSkillsMirror(root);
  expect(state.status).toBe("blocked");
  expect(state.code).toBe("manifest_invalid");
});

test("symlink v kanonickém katalogu: repair failuje zavřeně a nic nekopíruje", async () => {
  const root = await rootFixture("canonical-symlink");
  const outside = await mkdtemp(join(tmpdir(), "canonical-outside-"));
  tempRoots.push(outside);
  await writeFile(join(outside, "secret.md"), "tajný obsah\n");
  await rm(join(root, ".agents", "skills", "example-skill", "SKILL.md"));
  await symlink(join(outside, "secret.md"), join(root, ".agents", "skills", "example-skill", "SKILL.md"));

  const state = await repairAgentSkillsMirror(root);
  expect(state.status).toBe("blocked");
  expect(state.code).toBe("canonical_unsafe_content");
});

test("mirror mimo Git index je repair_needed a repair ho stage-uje", async () => {
  const root = await rootFixture("untracked");
  const first = await repairAgentSkillsMirror(root);
  expect(first.status).toBe("ok");

  const rmCached = Bun.spawnSync({
    cmd: ["git", "rm", "--cached", "--quiet", ".claude/skills/example-skill/SKILL.md"],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(rmCached.exitCode).toBe(0);

  const before = await checkAgentSkillsMirror(root);
  expect(before.status).toBe("repair_needed");
  expect(before.code).toBe("mirror_untracked");

  const after = await repairAgentSkillsMirror(root);
  expect(after.status).toBe("ok");
});

test("gitignored OS junk (.DS_Store) v mirroru není drift ani blocker", async () => {
  const root = await rootFixture("os-junk");
  expect((await repairAgentSkillsMirror(root)).status).toBe("ok");

  await writeFile(join(root, ".claude", "skills", ".DS_Store"), "junk");
  await writeFile(join(root, ".claude", "skills", "example-skill", ".DS_Store"), "junk");

  const check = await checkAgentSkillsMirror(root);
  expect(check.status).toBe("ok");
  expect(check.code).toBe("mirror_ready");

  const repair = await repairAgentSkillsMirror(root);
  expect(repair.status).toBe("ok");
  const survived = await readFile(join(root, ".claude", "skills", ".DS_Store"), "utf8");
  expect(survived).toBe("junk");
});

test("Git kontrakt: toplevel guard nezaměňuje index nadřazeného repozitáře", async () => {
  const parent = await mkdtemp(join(tmpdir(), "agent-skills-parent-"));
  tempRoots.push(parent);
  git(parent, ["init", "--quiet"]);
  const nested = join(parent, "nested-root");
  await mkdir(join(nested, ".agents", "skills", "example-skill"), { recursive: true });
  await writeFile(join(nested, ".agents", "skills", "example-skill", "SKILL.md"), "# example-skill\n");
  await writeFile(
    join(nested, ".agents", "skills", "manifest.json"),
    JSON.stringify({
      schema_version: "conglomerate.skills.v0",
      claude_compatibility: "tracked-derived-mirror",
      skills: [{ slug: "example-skill", path: ".agents/skills/example-skill/SKILL.md" }],
    }),
  );

  const state = await checkAgentSkillsMirror(nested);
  expect(state.status).toBe("blocked");
  expect(state.code).toBe("entrypoint_contract_invalid");
  expect(state.problems.join(" ")).toContain("nadřazeného repozitáře");
});

test("Windows per-user instalace Gitu je mezi trusted kandidáty", async () => {
  const withLocalAppData = trustedGitCandidates("win32", {
    LOCALAPPDATA: "C:\\Users\\kolega\\AppData\\Local",
  });
  expect(withLocalAppData).toContain("C:\\Program Files\\Git\\cmd\\git.exe");
  expect(withLocalAppData.some((path) => path.includes("AppData\\Local") && path.endsWith("git.exe")))
    .toBe(true);

  // Relativní nebo chybějící LOCALAPPDATA nesmí vytvořit relativního kandidáta.
  expect(trustedGitCandidates("win32", { LOCALAPPDATA: "relativni\\cesta" }))
    .toEqual(trustedGitCandidates("win32", {}));
  expect(trustedGitCandidates("darwin", {})).toContain("/opt/homebrew/bin/git");
  expect(trustedGitCandidates("linux", {})).toContain("/usr/local/bin/git");
});

test("resolution kandidátů najde na hostitelské platformě skutečný git", () => {
  // Běží v CI na Windows i Linuxu, takže pokrývá realpath+stat větev
  // discovery přesně tam, kde ji používá povinný doctor:agent-skills.
  const resolved = trustedGitExecutable();
  expect(typeof resolved).toBe("string");
  expect(isAbsolute(resolved)).toBe(true);
  expect(trustedGitCandidates().length).toBeGreaterThan(0);
});
