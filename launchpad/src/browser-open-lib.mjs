import { win32 } from "path";

export function browserOpenCommand(url, {
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform === "darwin") return ["open", url];
  if (platform === "linux") return ["xdg-open", url];
  if (platform !== "win32") return null;

  const systemRoot = env.SystemRoot ?? env.WINDIR;
  const executable = systemRoot
    ? win32.join(systemRoot, "System32", "cmd.exe")
    : "cmd.exe";
  return [executable, "/d", "/c", "start", "", url];
}

export async function openBrowser(url, {
  platform = process.platform,
  env = process.env,
  spawn = (command, options) => Bun.spawn(command, options),
} = {}) {
  const command = browserOpenCommand(url, { platform, env });
  if (!command) return { opened: false, command: null };

  let child;
  try {
    child = spawn(command, {
      stdout: "ignore",
      stderr: "pipe",
      windowsHide: true,
    });
  } catch (error) {
    throw browserOpenError(command, error?.message ?? String(error), { cause: error });
  }

  const [stderr, exitCode] = await Promise.all([
    child.stderr ? new Response(child.stderr).text() : "",
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw browserOpenError(command, stderr.trim() || `exit code ${exitCode}`);
  }
  return { opened: true, command, exitCode };
}

function browserOpenError(command, detail, options = {}) {
  const error = new Error(`Otevření prohlížeče selhalo: ${detail}`, options);
  error.code = "browser_open_failed";
  error.command = command;
  return error;
}
