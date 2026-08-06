import { afterAll, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import {
  actorInitials,
  buildNotifications,
  classifyActor,
  parseCoAuthors,
  parseNumstat,
} from "./notifications-lib.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function git(args, cwd, author = {}) {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author.name ?? "Anna Veselá",
      GIT_AUTHOR_EMAIL: author.email ?? "anna@example.com",
      GIT_COMMITTER_NAME: author.name ?? "Anna Veselá",
      GIT_COMMITTER_EMAIL: author.email ?? "anna@example.com",
    },
  });
  await child.exited;
}

async function makeModuleRepo(companiesRoot, relativePath, commits) {
  const abs = join(companiesRoot, relativePath);
  await mkdir(abs, { recursive: true });
  await git(["init"], abs);
  await git(["checkout", "-b", "main"], abs);
  for (const [index, commit] of commits.entries()) {
    for (const file of commit.files ?? [`file-${index}.txt`]) {
      await writeFile(join(abs, file), `obsah ${index}\n`, "utf8");
    }
    await git(["add", "."], abs);
    await git(["commit", "-m", commit.message], abs, commit.author);
  }
}

test("notifikace nese actor, scope i payload jedné změny", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-notif-"));
  tempRoots.push(root);
  await makeModuleRepo(root, "organizations/Acme/workspace/alpha", [
    { message: "feat: první" },
    { message: "feat: druhý", files: ["a.txt", "b.txt"] },
  ]);

  const apps = [
    {
      id: "acme-alpha-v1",
      company: "acme",
      company_display_name: "Acme",
      module: "alpha",
      cwd: "organizations/Acme/workspace/alpha",
      icon: "control",
    },
  ];

  const result = await buildNotifications({ companiesRoot: root, apps });
  expect(result.schema_version).toBe("companiesascode.launchpad.notifications.v1");
  expect(result.git_available).toBe(true);
  expect(result.notifications).toHaveLength(2);

  // Nejnovější změna je první.
  const [newest] = result.notifications;
  expect(newest.payload.subject).toBe("feat: druhý");
  expect(newest.actor.name).toBe("Anna Veselá");
  expect(newest.actor.kind).toBe("human");
  expect(newest.actor.initials).toBe("AV");
  expect(newest.scope.kind).toBe("module");
  expect(newest.scope.module).toBe("alpha");
  expect(newest.scope.company_display_name).toBe("Acme");
  // Payload = co je součástí změny, ne jen její nadpis.
  expect(newest.payload.files_changed).toBe(2);
  expect(newest.payload.files).toContain("a.txt");
  expect(newest.payload.insertions).toBeGreaterThan(0);
  expect(newest.payload.hash).toBeTruthy();
  expect(newest.id).toBe(`acme::alpha@${newest.payload.hash}`);
});

test("notifikace z více modulů se řadí podle času, ne podle modulu", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-notif-order-"));
  tempRoots.push(root);
  await makeModuleRepo(root, "organizations/Acme/workspace/alpha", [{ message: "alpha: starší" }]);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await makeModuleRepo(root, "organizations/Acme/workspace/beta", [{ message: "beta: novější" }]);

  const apps = [
    { id: "a", company: "acme", company_display_name: "Acme", module: "alpha", cwd: "organizations/Acme/workspace/alpha" },
    { id: "b", company: "acme", company_display_name: "Acme", module: "beta", cwd: "organizations/Acme/workspace/beta" },
  ];

  const result = await buildNotifications({ companiesRoot: root, apps });
  expect(result.notifications.map((item) => item.payload.subject)).toEqual([
    "beta: novější",
    "alpha: starší",
  ]);
});

test("notificationLimit ořízne seznam, ale nechá nejnovější", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-notif-limit-"));
  tempRoots.push(root);
  await makeModuleRepo(root, "organizations/Acme/workspace/alpha", [
    { message: "první" },
    { message: "druhý" },
    { message: "třetí" },
  ]);

  const apps = [
    { id: "a", company: "acme", company_display_name: "Acme", module: "alpha", cwd: "organizations/Acme/workspace/alpha" },
  ];

  const result = await buildNotifications({ companiesRoot: root, apps, notificationLimit: 2 });
  expect(result.notifications).toHaveLength(2);
  expect(result.notifications[0].payload.subject).toBe("třetí");
});

test("chybějící pracovní strom modulu notifikace neshodí", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-notif-missing-"));
  tempRoots.push(root);
  await makeModuleRepo(root, "organizations/Acme/workspace/alpha", [{ message: "alpha: jedna" }]);

  const apps = [
    { id: "a", company: "acme", company_display_name: "Acme", module: "alpha", cwd: "organizations/Acme/workspace/alpha" },
    { id: "b", company: "acme", company_display_name: "Acme", module: "ghost", cwd: "organizations/Acme/workspace/ghost" },
  ];

  const result = await buildNotifications({ companiesRoot: root, apps });
  expect(result.notifications).toHaveLength(1);
  expect(result.notifications[0].scope.module).toBe("alpha");
});

test("mergnutý PR nese obsah, ne prázdný payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-notif-merge-"));
  tempRoots.push(root);
  const abs = join(root, "organizations/Acme/workspace/alpha");
  await makeModuleRepo(root, "organizations/Acme/workspace/alpha", [{ message: "base" }]);
  await git(["checkout", "-b", "feature"], abs);
  await writeFile(join(abs, "feature.txt"), "z větve\n", "utf8");
  await git(["add", "."], abs);
  await git(["commit", "-m", "feat: práce ve větvi"], abs);
  await git(["checkout", "main"], abs);
  await git(["merge", "--no-ff", "feature", "-m", "Merge pull request #1"], abs);

  const apps = [
    { id: "a", company: "acme", company_display_name: "Acme", module: "alpha", cwd: "organizations/Acme/workspace/alpha" },
  ];

  const result = await buildNotifications({ companiesRoot: root, apps });
  const [newest] = result.notifications;
  expect(newest.payload.subject).toBe("Merge pull request #1");
  // Bez `-m` by git u merge commitu numstat nevypsal a payload by lhal.
  expect(newest.payload.files_changed).toBe(1);
  expect(newest.payload.files).toEqual(["feature.txt"]);
  // `--first-parent`: commit z větve není samostatná notifikace.
  expect(result.notifications.map((item) => item.payload.subject)).not.toContain(
    "feat: práce ve větvi",
  );
});

test("commit Agenta se pozná, člověk se skrytým e-mailem ne", () => {
  expect(classifyActor("Pablo AI", "agent@rozjedeme.ai")).toBe("agent");
  expect(classifyActor("dependabot[bot]", "support@github.com")).toBe("agent");
  expect(classifyActor("Codex", "codex@openai.com")).toBe("agent");
  // Skrytý GitHub e-mail z člověka Agenta nedělá — to je ta záměna, která by
  // notifikaci udělala nedůvěryhodnou.
  expect(classifyActor("Anna Veselá", "12345+anna@users.noreply.github.com")).toBe("human");
  expect(classifyActor("Matěj Suchánek", "matej@spectoda.com")).toBe("human");
});

test("iniciály zvládnou jedno slovo, dvě slova i prázdno", () => {
  expect(actorInitials("Anna Veselá")).toBe("AV");
  expect(actorInitials("Codex")).toBe("CO");
  expect(actorInitials("Anna Marie Veselá")).toBe("AV");
  expect(actorInitials("")).toBe("?");
  expect(actorInitials(null)).toBe("?");
});

test("Co-Authored-By trailer je vidět jako spoluautor", () => {
  const body = "Popis změny.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n";
  const coAuthors = parseCoAuthors(body);
  expect(coAuthors).toHaveLength(1);
  expect(coAuthors[0].name).toBe("Claude Opus 5");
  expect(coAuthors[0].kind).toBe("agent");
  expect(parseCoAuthors("Bez traileru.")).toEqual([]);
});

test("numstat parser zvládne binární soubor i prázdný vstup", () => {
  const parsed = parseNumstat("3\t1\tsrc/app.js\n-\t-\tassets/logo.png\n");
  expect(parsed.files).toEqual(["src/app.js", "assets/logo.png"]);
  expect(parsed.insertions).toBe(3);
  expect(parsed.deletions).toBe(1);
  expect(parseNumstat("")).toEqual({ files: [], insertions: 0, deletions: 0 });
});
