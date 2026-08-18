import { createHash } from "node:crypto";
import { readdir, readFile } from "fs/promises";
import { join, relative } from "path";

export async function createLaunchpadSourceId(launchpadRoot) {
  const sourceFiles = [join(launchpadRoot, "package.json")];
  await collectFiles(join(launchpadRoot, "public"), sourceFiles, () => true);
  await collectFiles(
    join(launchpadRoot, "src"),
    sourceFiles,
    (path) => path.endsWith(".mjs") && !path.endsWith(".test.mjs"),
  );
  sourceFiles.sort((left, right) => left.localeCompare(right));

  const hash = createHash("sha256");
  hash.update("companiesascode.launchpad.source.v1\0");
  for (const path of sourceFiles) {
    const sourcePath = relative(launchpadRoot, path).replaceAll("\\", "/");
    const bytes = await readFile(path);
    hash.update(`${Buffer.byteLength(sourcePath)}:${sourcePath}:${bytes.byteLength}:`);
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function collectFiles(root, files, include) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(path, files, include);
    } else if (entry.isFile() && include(path)) {
      files.push(path);
    }
  }
}
