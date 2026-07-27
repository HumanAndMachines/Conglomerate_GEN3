import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PERSONAL_SCHEMA_VERSION,
  PERSONALSPACE_TEMPLATE,
  PERSONALSPACE_TEMPLATE_VERSION,
  parseCreateArgs,
  targetForRoot,
  validateGbrainRepoOption,
  validateTemplateMarker,
} from "./create-personalspace.mjs";

const scriptPath = fileURLToPath(new URL("./create-personalspace.mjs", import.meta.url));

function runGit(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("create parser drží apply a gbrain instalaci explicitní", () => {
  expect(parseCreateArgs([
    "--display-name",
    "Example Owner",
    "--apply",
    "--install-gbrain",
  ])).toMatchObject({
    displayName: "Example Owner",
    apply: true,
    installGbrain: true,
    ownerType: "human",
  });
  expect(() => parseCreateArgs(["--with-buddy"])).toThrow("Neznámý argument");
  expect(() => parseCreateArgs(["--buddy-repo", "example/example-assistant"])).toThrow(
    "Neznámý argument",
  );
  expect(PERSONALSPACE_TEMPLATE).toBe("HumanAndMachines/PersonalspaceTemplate_GEN3");
});

test("cílový mount je deterministický v POSIX i Windows cestě", () => {
  expect(targetForRoot("/home/example/Conglomerate", "example", posix)).toBe(
    "/home/example/Conglomerate/personalspace/example_GEN3",
  );
  expect(targetForRoot("D:\\Home\\Example\\Conglomerate", "example", win32)).toBe(
    "D:\\Home\\Example\\Conglomerate\\personalspace\\example_GEN3",
  );
});

test("neznámý argument a chybějící hodnota failují", () => {
  expect(() => parseCreateArgs(["--unknown"])).toThrow();
  expect(() => parseCreateArgs(["--display-name"])).toThrow();
});

test("template marker váže přesný upstream a verzi personal kontraktu", () => {
  expect(validateTemplateMarker({
    schema_version: PERSONALSPACE_TEMPLATE_VERSION,
    template_repo: PERSONALSPACE_TEMPLATE,
    personal_schema_version: PERSONAL_SCHEMA_VERSION,
  })).toEqual([]);
  expect(validateTemplateMarker({
    schema_version: "unknown",
    template_repo: "other/repo",
    personal_schema_version: "legacy",
  })).toHaveLength(3);
});

test("custom gbrain repo patří ownerovi a nikdy nealiasuje owner repo", () => {
  expect(validateGbrainRepoOption("example", "example/example-gbrain")).toEqual([]);
  expect(validateGbrainRepoOption("example", "other/example-gbrain")).toHaveLength(1);
  expect(validateGbrainRepoOption("example", "example/example_GEN3")).toHaveLength(1);
  expect(validateGbrainRepoOption("example", "invalid")).toHaveLength(1);
});

test.skipIf(process.platform === "win32")("create dry-run never executes checkout-local core.fsmonitor", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-personalspace-fsmonitor-"));
  try {
    await writeFile(join(root, "launchpad.gen3.json"), "{}\n");
    await writeFile(join(root, ".gitignore"), "personalspace/\n");
    runGit(["init", "-q", "-b", "main"], root);
    runGit(["config", "user.name", "Personalspace Test"], root);
    runGit(["config", "user.email", "personalspace@example.invalid"], root);
    runGit(["add", "."], root);
    runGit(["commit", "-qm", "fixture"], root);

    const marker = join(root, "fsmonitor-ran");
    const helper = join(root, ".git", "fsmonitor-marker.sh");
    await writeFile(helper, `#!/bin/sh\nprintf marker > ${JSON.stringify(marker)}\nexit 0\n`);
    await chmod(helper, 0o755);
    runGit(["config", "core.fsmonitor", helper], root);

    const fakeBin = join(root, "fake-bin");
    await mkdir(fakeBin);
    const fakeGh = join(fakeBin, "gh");
    await writeFile(fakeGh, `#!/bin/sh
case "$1:$2:$3" in
  "api:user:") printf '%s\\n' '{"login":"example"}' ;;
  "repo:view:HumanAndMachines/PersonalspaceTemplate_GEN3") printf '%s\\n' '{"nameWithOwner":"HumanAndMachines/PersonalspaceTemplate_GEN3","visibility":"PUBLIC","isTemplate":true}' ;;
  "api:repos/HumanAndMachines/PersonalspaceTemplate_GEN3/contents/personalspace.template.json:-H") printf '%s\\n' '{"schema_version":"humanandmachines.personalspace-template.v1","template_repo":"HumanAndMachines/PersonalspaceTemplate_GEN3","personal_schema_version":"humanandmachines.personal.gen3.v1"}' ;;
  "repo:view:example/example_GEN3"|"repo:view:example/example-gbrain") printf '%s\\n' 'not found' >&2; exit 1 ;;
  *) printf 'unexpected gh invocation: %s\\n' "$*" >&2; exit 1 ;;
esac
`);
    await chmod(fakeGh, 0o755);
    const pathMarker = join(root, "path-git-ran");
    const fakeGit = join(fakeBin, "git");
    await writeFile(fakeGit, `#!/bin/sh\nprintf path-git > ${JSON.stringify(pathMarker)}\nexit 1\n`);
    await chmod(fakeGit, 0o755);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    });

    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(pathMarker)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
