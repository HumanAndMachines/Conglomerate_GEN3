export const PLAN_CODE_PATTERN = /^[A-Z]{2,6}-[0-9]{4}$/;
export const SURFACE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const VALUE_OPTIONS = new Set([
  "plan",
  "branch",
  "purpose",
  "surface",
  "agent-label",
  "created-by",
  "thread-id",
]);

export function parseWorktreeCreateArgs(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`neznámý argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (!VALUE_OPTIONS.has(key)) {
      throw new Error(`neznámý argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`neúplný argument: ${arg}`);
    }
    options[key] = value;
    index += 1;
  }
  if (options.surface && !SURFACE_PATTERN.test(options.surface)) {
    throw new Error(`--surface má neplatný formát: ${options.surface}`);
  }
  return options;
}
