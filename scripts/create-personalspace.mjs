import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

export const PERSONALSPACE_TEMPLATE = "HumanAndMachines/PersonalspaceTemplate_GEN3";
export const PERSONALSPACE_TEMPLATE_VERSION = "humanandmachines.personalspace-template.v1";
export const PERSONAL_SCHEMA_VERSION = "humanandmachines.personal.gen3.v1";

export function parseCreateArgs(argv) {
  const options = {
    apply: false,
    displayName: null,
    ownerType: "human",
    login: null,
    gbrainRepo: null,
    installGbrain: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--install-gbrain") options.installGbrain = true;
    else if (arg === "--display-name") options.displayName = requireValue(argv, ++index, arg);
    else if (arg === "--owner-type") options.ownerType = requireValue(argv, ++index, arg);
    else if (arg === "--login") options.login = requireValue(argv, ++index, arg);
    else if (arg === "--gbrain-repo") options.gbrainRepo = requireValue(argv, ++index, arg);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Neznámý argument: ${arg}`);
  }
  return options;
}

export function targetForRoot(root, login, pathApi = { join, resolve }) {
  return pathApi.resolve(pathApi.join(root, "personalspace", `${login}_GEN3`));
}

export function validateTemplateMarker(marker) {
  const issues = [];
  if (marker?.schema_version !== PERSONALSPACE_TEMPLATE_VERSION) {
    issues.push(`schema_version musí být ${PERSONALSPACE_TEMPLATE_VERSION}`);
  }
  if (marker?.template_repo !== PERSONALSPACE_TEMPLATE) {
    issues.push(`template_repo musí být ${PERSONALSPACE_TEMPLATE}`);
  }
  if (marker?.personal_schema_version !== PERSONAL_SCHEMA_VERSION) {
    issues.push(`personal_schema_version musí být ${PERSONAL_SCHEMA_VERSION}`);
  }
  return issues;
}

export function validateGbrainRepoOption(login, value) {
  if (!value) return [];
  const normalized = String(value).trim().replace(/\.git$/i, "");
  const parts = normalized.split("/");
  const ownerRepo = `${login}/${login}_GEN3`;
  const issues = [];
  if (parts.length !== 2 || parts.some((part) => part === "")) {
    issues.push("--gbrain-repo musí mít tvar <login>/<repo>");
    return issues;
  }
  if (parts[0].toLowerCase() !== login.toLowerCase()) {
    issues.push("--gbrain-repo musí patřit přihlášenému GitHub účtu");
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(parts[1])) {
    issues.push("--gbrain-repo obsahuje neplatný název repozitáře");
  }
  if (normalized.toLowerCase() === ownerRepo.toLowerCase()) {
    issues.push("--gbrain-repo musí být jiné repo než Personalspace owner repo");
  }
  return issues;
}


function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} vyžaduje hodnotu.`);
  return value;
}

function usage() {
  console.log(`Použití:
  bun run personalspace:create -- --display-name "<jméno>"
      [--owner-type human|ai-colleague] [--gbrain-repo <login>/<repo>]
      [--install-gbrain]
      [--apply]

Bez --apply proběhne pouze read-only GitHub a lokální preflight.`);
}

function run(command, args, { cwd, allowFailure = false, inherit = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    shell: false,
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  const status = Number.isInteger(result.status) ? result.status : 1;
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  if (status !== 0 && !allowFailure) {
    throw new Error(`${command} selhal (exit ${status}): ${redact(stderr || result.error?.message || "bez detailu")}`);
  }
  return { status, stdout, stderr };
}

function redact(value) {
  return String(value)
    .replace(/:\/\/([^:/\s]+):([^@\s]+)@/g, "://***:***@")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, "gh*_***")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, "github_pat_***")
    .slice(-1200);
}

function json(command, args, cwd) {
  const result = run(command, args, { cwd });
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${command} nevrátil validní JSON.`);
  }
}

function repoInfo(repo, cwd, { allowMissing = false } = {}) {
  const result = run(
    "gh",
    ["repo", "view", repo, "--json", "nameWithOwner,visibility,isTemplate"],
    { cwd, allowFailure: true },
  );
  if (result.status !== 0) {
    if (allowMissing && /could not resolve|not found|http 404/i.test(`${result.stdout}\n${result.stderr}`)) {
      return null;
    }
    throw new Error(`GitHub repo ${repo} nejde ověřit: ${redact(result.stderr || "bez detailu")}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`GitHub repo ${repo} nevrátil validní metadata.`);
  }
}

function liveTemplateMarker(cwd) {
  const result = run(
    "gh",
    [
      "api",
      `repos/${PERSONALSPACE_TEMPLATE}/contents/personalspace.template.json`,
      "-H",
      "Accept: application/vnd.github.raw+json",
    ],
    { cwd },
  );
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${PERSONALSPACE_TEMPLATE} nemá validní public template marker.`);
  }
}

function sameRepo(left, right) {
  return typeof left === "string"
    && typeof right === "string"
    && left.replace(/\.git$/i, "").toLowerCase() === right.replace(/\.git$/i, "").toLowerCase();
}

function parseRemote(remote) {
  const scp = remote?.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (scp) return `${scp[1]}/${scp[2]}`;
  try {
    const parsed = new URL(remote);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    return parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  } catch {
    return null;
  }
}

function assertPrivate(info, repo) {
  if (!info || !sameRepo(info.nameWithOwner, repo)) throw new Error(`GitHub metadata neodpovídají ${repo}.`);
  if (String(info.visibility).toLowerCase() !== "private") {
    throw new Error(`Repo ${repo} musí být private; nalezeno ${info.visibility}.`);
  }
}

function checkNoSubmodules(cwd) {
  if (existsSync(join(cwd, ".gitmodules"))) throw new Error(`${cwd} obsahuje zakázaný .gitmodules.`);
  const output = run("git", ["ls-files", "-s"], { cwd }).stdout;
  const gitlinks = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("160000 "))
    .map((line) => line.split(/\s+/).at(-1));
  if (gitlinks.length > 0) throw new Error(`${cwd} obsahuje zakázané gitlinky: ${gitlinks.join(", ")}.`);
}

export async function createPersonalspace(options, { root = process.cwd() } = {}) {
  const conglomerateRoot = resolve(root);
  if (!existsSync(join(conglomerateRoot, "launchpad.gen3.json"))) {
    throw new Error("Příkaz spusť z kořene Conglomerate GEN3.");
  }
  if (!options.displayName && options.apply) throw new Error("--display-name je pro --apply povinný.");
  if (!["human", "ai-colleague"].includes(options.ownerType)) {
    throw new Error("--owner-type musí být human nebo ai-colleague.");
  }

  const login = json("gh", ["api", "user"], conglomerateRoot)?.login;
  if (typeof login !== "string" || login.trim() === "") throw new Error("GitHub CLI nevrátil přihlášený login.");
  if (options.login && options.login.toLowerCase() !== login.toLowerCase()) {
    throw new Error(`--login ${options.login} neodpovídá přihlášenému účtu ${login}.`);
  }
  const repo = `${login}/${login}_GEN3`;
  const target = targetForRoot(conglomerateRoot, login);
  const gbrainRepoIssues = validateGbrainRepoOption(login, options.gbrainRepo);
  if (gbrainRepoIssues.length > 0) throw new Error(gbrainRepoIssues.join("; "));
  const gbrainRepo = options.gbrainRepo ?? `${login}/${login}-gbrain`;

  const template = repoInfo(PERSONALSPACE_TEMPLATE, conglomerateRoot);
  if (String(template.visibility).toLowerCase() !== "public" || template.isTemplate !== true) {
    throw new Error(`${PERSONALSPACE_TEMPLATE} musí být public a is_template=true.`);
  }
  const upstreamMarkerIssues = validateTemplateMarker(liveTemplateMarker(conglomerateRoot));
  if (upstreamMarkerIssues.length > 0) {
    throw new Error(`Public template marker není důvěryhodný: ${upstreamMarkerIssues.join("; ")}`);
  }

  checkNoSubmodules(conglomerateRoot);
  const ignored = run(
    "git",
    ["check-ignore", "--quiet", "--no-index", `personalspace/${login}_GEN3`],
    { cwd: conglomerateRoot, allowFailure: true },
  );
  if (ignored.status !== 0) throw new Error(`personalspace/${login}_GEN3 není v Conglomerate rootu gitignored.`);

  let ownerInfo = repoInfo(repo, conglomerateRoot, { allowMissing: true });
  if (ownerInfo) assertPrivate(ownerInfo, repo);
  const gbrainInfo = repoInfo(gbrainRepo, conglomerateRoot, { allowMissing: true });
  if (gbrainInfo) assertPrivate(gbrainInfo, gbrainRepo);

  if (existsSync(target)) {
    if (!existsSync(join(target, ".git"))) throw new Error(`${target} existuje, ale není Git checkout.`);
    const remote = run("git", ["config", "--get", "remote.origin.url"], { cwd: target }).stdout;
    if (!sameRepo(parseRemote(remote), repo)) throw new Error(`Checkout ${target} nemá origin ${repo}.`);
    checkNoSubmodules(target);
    if (!ownerInfo) {
      throw new Error(`${target} existuje, ale GitHub repo ${repo} nejde ověřit; automatické vytvoření se zastavuje.`);
    }
  }

  console.log("Personalspace create preflight PASS");
  console.log(`- přihlášený owner: ${login}`);
  console.log(`- template: ${PERSONALSPACE_TEMPLATE} (public template)`);
  console.log(`- owner repo: ${repo} (${ownerInfo ? "private, existuje" : "bude vytvořeno jako private"})`);
  console.log(`- gbrain repo: ${gbrainRepo} (${gbrainInfo ? "private, existuje" : "bude vytvořeno jako private"})`);
  console.log(`- mount: personalspace/${login}_GEN3`);
  console.log("- Buddy: PENDING CAC-0072; tento live příkaz Buddy repo ani runtime nevytváří");
  if (!options.apply) {
    if (ownerInfo) {
      console.log("- apply gate: existující repo se automaticky nespouští; použij kontrolovaný resume postup v manuálu");
    }
    console.log("Dry-run dokončen. Pro provedení přidej --apply.");
    return { applied: false, login, repo, target };
  }

  if (ownerInfo) {
    throw new Error(
      `${repo} už existuje. Root příkaz nikdy nespouští kód z předem existujícího repa; `
      + "zkontroluj marker a pokračuj podle manual/create-personalspace.md.",
    );
  }
  run("gh", [
    "repo",
    "create",
    repo,
    "--private",
    "--template",
    PERSONALSPACE_TEMPLATE,
    "--description",
    "Privátní Personalspace GEN3.",
  ], { cwd: conglomerateRoot });
  ownerInfo = repoInfo(repo, conglomerateRoot);
  assertPrivate(ownerInfo, repo);
  run("gh", ["repo", "clone", repo, target], { cwd: conglomerateRoot });

  const dirty = run("git", ["status", "--porcelain"], { cwd: target }).stdout;
  if (dirty !== "") {
    throw new Error("Čerstvě vytvořený Personalspace checkout není čistý; bootstrap se nespustí.");
  }
  let marker;
  try {
    marker = JSON.parse(await readFile(join(target, "personalspace.template.json"), "utf8"));
  } catch {
    throw new Error("Čerstvě vytvořené repo nemá validní personalspace.template.json; bootstrap se nespustí.");
  }
  const markerIssues = validateTemplateMarker(marker);
  if (markerIssues.length > 0) {
    throw new Error(`Template marker není důvěryhodný: ${markerIssues.join("; ")}`);
  }

  const bootstrapArgs = [
    "scripts/bootstrap-personalspace.mjs",
    "--display-name",
    options.displayName,
    "--owner-type",
    options.ownerType,
    "--apply",
  ];
  if (options.gbrainRepo) bootstrapArgs.push("--gbrain-repo", options.gbrainRepo);
  if (options.installGbrain) bootstrapArgs.push("--install-gbrain");
  run("bun", bootstrapArgs, { cwd: target, inherit: true });
  return { applied: true, login, repo, target };
}

if (import.meta.main) {
  try {
    const options = parseCreateArgs(Bun.argv.slice(2));
    if (options.help) usage();
    else await createPersonalspace(options);
  } catch (error) {
    console.error(`Vytvoření Personalspace selhalo: ${error.message}`);
    process.exit(1);
  }
}
