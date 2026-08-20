import { runLazurioUpdate } from "./lazurio-update-lib.mjs";

export const UPDATE_CLI_USAGE = `Použití: lazurio update [--json] [--root <cesta>]

Aktualizuje celou spravovanou hierarchii Lazurio Root → Organization Rooty →
Workspace Moduly. Productionspace, Personalspace, worktrees a nested
repository-db zůstávají nedotčené. Bezpečné lokální změny uloží do ověřeného
recovery stashe; historii, kterou nelze fast-forwardnout, předá Codexu.`;

export function parseUpdateCliArgs(argv) {
  const options = { json: false, help: false, root: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return { ok: false, error: "--root vyžaduje cestu." };
      options.root = value;
      index += 1;
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
      if (!options.root) return { ok: false, error: "--root vyžaduje cestu." };
    } else {
      return {
        ok: false,
        error: `Neznámá volba ${JSON.stringify(arg)}. Lazurio update záměrně nemá plan/apply, preserve ani scope přepínače.`,
      };
    }
  }
  return { ok: true, options };
}

export async function runUpdateLane({ rootPath, runtimeRoot, deps = {} } = {}) {
  return runLazurioUpdate({ rootPath, runtimeRoot, deps });
}

export function formatUpdateLaneReport(report) {
  const lines = [`Lazurio update: ${report.state}`];
  for (const result of report.results ?? []) {
    const symbol = result.state === "blocked" ? "!" : result.state === "updated" ? "✓" : "·";
    lines.push(`${symbol} ${result.path}: ${result.state} — ${result.message}`);
    if (result.recovery_stash) lines.push(`  Recovery stash: ${result.recovery_stash}`);
    if (result.next_action?.prompt) {
      lines.push("  Prompt pro Codex:");
      lines.push(...result.next_action.prompt.split("\n").map((line) => `    ${line}`));
    }
  }
  if ((report.warnings ?? []).length > 0) {
    lines.push("Upozornění:", ...report.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join("\n");
}
