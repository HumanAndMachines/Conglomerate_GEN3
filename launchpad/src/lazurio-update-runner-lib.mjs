import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The short-lived CLI launcher may live in the mutable checkout, but the
// update engine itself runs from this complete bundle in a separate directory.
// Hosted Launchpad does not use this escape hatch: its long-running runtime
// must be installed outside the working root and passes that exact runtime root
// to runLazurioUpdate.
export async function runIsolatedLazurioUpdate({ rootPath }) {
  const directory = await mkdtemp(join(tmpdir(), "lazurio-update-runtime-"));
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dirname, "lazurio-update-runtime.mjs")],
      target: "bun",
      format: "esm",
      minify: false,
      sourcemap: "none",
    });
    if (!build.success || build.outputs.length !== 1) {
      throw new Error(build.logs.map((log) => log.message).join("\n") || "Updater runtime bundle se nepodařilo sestavit.");
    }
    const runtimePath = join(directory, "lazurio-update-runtime.mjs");
    await Bun.write(runtimePath, build.outputs[0]);
    const child = Bun.spawn(
      [process.execPath, runtimePath, "--root", rootPath, "--runtime-root", directory],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    let report;
    try {
      report = JSON.parse(stdout.trim());
    } catch {
      throw new Error(stderr.trim() || stdout.trim() || `Updater runtime skončil kódem ${exitCode}.`);
    }
    return report;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
