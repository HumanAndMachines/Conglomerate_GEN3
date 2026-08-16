import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const installer = join(root, "scripts", "install-launchpad-macos.sh");
const tempRoots = [];
const macTest = process.platform === "darwin" ? test : test.skip;

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("macOS launcher ověřuje identitu rootu a nepoužívá zastaralý launchctl submit", async () => {
  const launcher = await readFile(join(root, "scripts", "macos", "launchpad-gen3-launcher.sh"), "utf8");

  expect(launcher).toContain("/api/launchpad/identity");
  expect(launcher).toContain("launchctl bootstrap");
  expect(launcher).toContain("Resources/root-path");
  expect(launcher).toContain("seq 4174 4193");
  expect(launcher).not.toContain("launchctl submit");
});

macTest("macOS instalátor vytvoří podepsanou aplikaci navázanou na aktuální root", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "launchpad-macos-installer-"));
  tempRoots.push(fixtureRoot);
  const target = join(fixtureRoot, "Launchpad GEN3.app");
  const result = Bun.spawnSync(["/bin/bash", installer, target], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(await readFile(join(target, "Contents", "Resources", "root-path"), "utf8")).toBe(`${root}\n`);
  const jobLabel = (await readFile(join(target, "Contents", "Resources", "job-label"), "utf8")).trim();
  expect(jobLabel).toMatch(/^com\.humanandmachine\.launchpad-gen3\.[a-f0-9]{12}$/);

  const plist = Bun.spawnSync(["plutil", "-extract", "CFBundleIdentifier", "raw", join(target, "Contents", "Info.plist")]);
  expect(plist.exitCode).toBe(0);
  expect(plist.stdout.toString().trim()).toBe("com.humanandmachine.launchpad-gen3");

  const launchAgent = join(target, "Contents", "Resources", "LaunchAgent.plist");
  const program = Bun.spawnSync(["plutil", "-extract", "ProgramArguments.1", "raw", launchAgent]);
  expect(program.exitCode).toBe(0);
  expect(program.stdout.toString().trim()).toBe(join(root, "Launchpad.command"));

  const signature = Bun.spawnSync(["codesign", "--verify", "--deep", "--strict", target]);
  expect(signature.exitCode, signature.stderr.toString()).toBe(0);
});
