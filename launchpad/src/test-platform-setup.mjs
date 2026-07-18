// Git for Windows and PowerShell-backed lifecycle probes have measurably higher
// process startup cost than their POSIX counterparts. Keep the fast fail window
// on Unix, while giving Windows integration tests enough time to exercise the
// real Git/Bun process boundary instead of being killed by Bun's 5 s default.
export function platformTestTimeout(milliseconds) {
  return process.platform === "win32" ? milliseconds * 3 : milliseconds;
}
