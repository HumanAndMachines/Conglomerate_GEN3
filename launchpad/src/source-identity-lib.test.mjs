import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createLaunchpadSourceId } from "./source-identity-lib.mjs";

test("Launchpad source identity tracks runtime and public bytes but ignores tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-source-id-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "public"), { recursive: true });
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, "src", "server.mjs"), "export const version = 1;\n");
    await writeFile(join(root, "src", "server.test.mjs"), "test('one');\n");
    await writeFile(join(root, "public", "app.js"), "console.log('one');\n");

    const initial = await createLaunchpadSourceId(root);
    expect(initial).toMatch(/^[a-f0-9]{64}$/);

    await writeFile(join(root, "src", "server.test.mjs"), "test('two');\n");
    expect(await createLaunchpadSourceId(root)).toBe(initial);

    await writeFile(join(root, "public", "app.js"), "console.log('two');\n");
    expect(await createLaunchpadSourceId(root)).not.toBe(initial);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
