import { posix, win32 } from "node:path";

export function buildLaunchpadInstallInvocation({ root, platform = process.platform }) {
  if (platform === "darwin") {
    const canonicalRoot = posix.resolve(root);
    return {
      argv: ["/bin/bash", posix.join(canonicalRoot, "scripts", "install-launchpad-macos.sh")],
      cwd: canonicalRoot,
    };
  }

  if (platform === "win32") {
    const canonicalRoot = win32.resolve(root);
    return {
      argv: [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        win32.join(canonicalRoot, "Install-LaunchpadShortcut.ps1"),
      ],
      cwd: canonicalRoot,
    };
  }

  throw launchpadInstallError(
    `Instalace Lazurio Launchpadu zatím podporuje pouze macOS a Windows; aktuální platforma je '${platform}'.`,
  );
}

export async function runLaunchpadInstall({
  root,
  platform = process.platform,
  spawn = Bun.spawn,
}) {
  const invocation = buildLaunchpadInstallInvocation({ root, platform });
  let child;
  try {
    child = spawn(invocation.argv, {
      cwd: invocation.cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw launchpadInstallError(
      `Instalátor Lazurio Launchpadu se nepodařilo spustit z rootu '${invocation.cwd}': ${detail}`,
      cause,
    );
  }

  try {
    return await child.exited;
  } catch (cause) {
    throw launchpadInstallError("Instalátor Lazurio Launchpadu skončil bez platného exit code.", cause);
  }
}

function launchpadInstallError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.lazurioExitCode = 1;
  return error;
}
