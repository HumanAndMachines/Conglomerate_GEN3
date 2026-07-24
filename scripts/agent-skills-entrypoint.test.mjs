import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAgentSkillsMirror,
  repairAgentSkillsMirror,
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
