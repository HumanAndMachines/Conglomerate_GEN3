#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { relative, resolve, join, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  GIT_LOCAL_TIMEOUT_MS,
  resolveGitExecutableSync,
  safeGitCommandEnv,
} from '../launchpad/src/git-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set([
  '.git',
  '.worktrees',
  'node_modules',
  '.next',
  'dist',
  'build',
  '.astro',
  '.vite',
  '.turbo',
  '.cache',
  'coverage',
  'private',
  'secrets',
  '.claude/settings.local.json',
]);

const SKIP_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.worktrees',
  'dist',
  'build',
  '.build',
  '.astro',
  '.cache',
  'coverage',
  '__pycache__',
]);

const SKIP_PREFIXES = [
  'ClientCompanies/',
  'company/team/',
  'output/',
  'tmp/',
  'drafts/',
  'personalspace/',
  'private/',
  'modules/',
  'productionspace/',
];

const ROOT_FILES = new Set([
  'README.md',
  'MAP.md',
  'AGENTS.md',
  'ARCHITECTURE.md',
  'GLOSSARY.md',
  'WORKSPACE_MANUAL.md',
  'CHANGELOG.md',
  'TODO.tasks.json',
  'DONE.tasks.json',
  'ISSUES.open.json',
  'ISSUES.resolved.json',
  'company.gen3.json',
  'modules.manifest.json',
]);

const LEDGER_FILES = new Set([
  'TODO.tasks.json',
  'DONE.tasks.json',
  'ISSUES.open.json',
  'ISSUES.resolved.json',
]);

function parseArgs(argv) {
  const args = {
    gen2: null,
    gen3: null,
    label: 'Organization',
    pairsFile: null,
    json: false,
    includeSame: false,
    includeSharedSurfaces: false,
    limit: 200,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--gen2') args.gen2 = argv[++i];
    else if (arg === '--gen3') args.gen3 = argv[++i];
    else if (arg === '--label') args.label = argv[++i];
    else if (arg === '--pairs-file') args.pairsFile = argv[++i];
    else if (arg === '--json') args.json = true;
    else if (arg === '--include-same') args.includeSame = true;
    else if (arg === '--include-shared-surfaces') args.includeSharedSurfaces = true;
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.limit) || args.limit < 1) {
    throw new Error('--limit must be a positive number');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: bun scripts/gen2-gen3-sync-inventory.mjs --gen2 <path> --gen3 <path> [--label <name>] [--json] [--include-same] [--include-shared-surfaces]\n       bun scripts/gen2-gen3-sync-inventory.mjs --pairs-file <json> [--json] [--include-shared-surfaces]\n\nRead-only dry-run inventory for a local GEN2 -> GEN3 organization sync.\nIt never copies, deletes or edits files. It compares allowlisted source-of-truth files and labels whether a delta is likely organization-local, a template-baseline candidate, or a shared-root mechanism candidate.\n\nThe shared HumanAndMachine root must not carry organization-specific data. Shared-root and template hints are only extraction prompts: promote mechanisms after anonymizing names, paths, ports, people, business records and secrets.`);
}

function loadPairs(args) {
  if (args.pairsFile) {
    const absolute = resolvePath(args.pairsFile);
    const raw = JSON.parse(readFileSync(absolute, 'utf8'));
    const rows = Array.isArray(raw) ? raw : raw.pairs;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('--pairs-file must contain an array or an object with a non-empty pairs array');
    }
    return rows.map((row, index) => normalizePair(row, `pair-${index + 1}`));
  }
  if (!args.gen2 || !args.gen3) {
    throw new Error('Provide --gen2 <path> and --gen3 <path>, or provide --pairs-file <json>. Built-in organization pairs are intentionally not embedded in the shared root.');
  }
  return [normalizePair({ key: 'explicit', label: args.label, gen2: args.gen2, gen3: args.gen3 }, 'explicit')];
}

function normalizePair(row, fallbackKey) {
  if (!row || typeof row !== 'object') throw new Error(`Invalid pair entry: ${fallbackKey}`);
  if (!row.gen2 || !row.gen3) throw new Error(`Pair ${row.key ?? fallbackKey} must include gen2 and gen3 paths`);
  return {
    key: String(row.key ?? fallbackKey),
    label: String(row.label ?? row.key ?? fallbackKey),
    gen2: resolvePath(String(row.gen2)),
    gen3: resolvePath(String(row.gen3)),
  };
}

function resolvePath(input) {
  if (/^~[\\/]/.test(input)) return resolve(homedir(), input.slice(2));
  if (input === '~') return resolve(homedir());
  return resolve(ROOT, input);
}

function gitInfo(root) {
  if (!existsSync(root)) return { exists: false };
  const gitExecutable = resolveGitExecutableSync();
  const run = (args) => {
    if (!gitExecutable) return null;
    try {
      return execFileSync(gitExecutable, args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: safeGitCommandEnv(),
        timeout: GIT_LOCAL_TIMEOUT_MS,
        windowsHide: true,
      }).trim();
    } catch (_error) {
      return null;
    }
  };
  return {
    exists: true,
    branch: run(['branch', '--show-current']),
    head: run(['rev-parse', '--short=12', 'HEAD']),
    status: run(['status', '--short', '--branch']),
    remote: run(['remote', 'get-url', 'origin']),
  };
}

function shouldSkipRel(rel, options) {
  const segments = rel.split('/');
  if (segments.some((s) => SKIP_SEGMENTS.has(s))) return true;
  if (segments.some((s) => s.endsWith('.local') || s === '.DS_Store')) return true;
  if (/\.(pyc|pyo|log|tmp|swp|swo)$/i.test(rel)) return true;
  if (SKIP_PREFIXES.some((p) => rel.startsWith(p))) return true;
  if (ROOT_FILES.has(rel)) return false;
  if (rel.startsWith('mission-control/')) return false;
  if (rel.startsWith('manual/')) return false;
  if (rel.startsWith('company/scripts/')) return false;
  if (rel.startsWith('company/agents/')) return false;
  if (rel.startsWith('company/archive/')) return false;
  if (rel.startsWith('.claude/skills/')) return Boolean(!options.includeSharedSurfaces);
  if (rel.startsWith('launchpad/')) return Boolean(!options.includeSharedSurfaces);
  if (rel.startsWith('guide/')) return Boolean(!options.includeSharedSurfaces);
  return true;
}

function walkFiles(root, options, base = root, out = new Map()) {
  if (!existsSync(root)) return out;
  const st = statSync(root);
  if (st.isDirectory()) {
    const name = root === base ? '' : basename(root);
    if (name && SKIP_DIRS.has(name)) return out;
    for (const entry of readdirSync(root)) {
      walkFiles(join(root, entry), options, base, out);
    }
  } else if (st.isFile()) {
    const rel = relative(base, root).replaceAll('\\', '/');
    if (shouldSkipRel(rel, options)) return out;
    out.set(rel, { path: root, size: st.size, sha256: sha256(root) });
  }
  return out;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function classify(rel, gen2File, gen3File) {
  if (gen2File && !gen3File) return 'port-candidate';
  if (!gen2File && gen3File) return 'gen3-only';
  if (gen2File && gen3File && gen2File.sha256 !== gen3File.sha256) return 'manual-review';
  return 'same';
}

function ownershipHint(rel) {
  if (LEDGER_FILES.has(rel) || rel.startsWith('mission-control/')) {
    return { owner_hint: 'organization-local', extraction: 'do-not-promote' };
  }
  if (rel.startsWith('launchpad/') || rel.startsWith('guide/')) {
    return { owner_hint: 'shared-root', extraction: 'mechanism-only' };
  }
  if (rel.startsWith('manual/gen2-to-gen3') || rel.startsWith('manual/first-client') || rel.startsWith('manual/workspace-module-version')) {
    return { owner_hint: 'shared-root', extraction: 'mechanism-only' };
  }
  if (rel.startsWith('company/scripts/') || rel.startsWith('company/agents/') || rel.startsWith('.claude/skills/')) {
    return { owner_hint: 'template-baseline', extraction: 'anonymize-before-template' };
  }
  if (rel === 'company.gen3.json' || rel === 'modules.manifest.json') {
    return { owner_hint: 'organization-local', extraction: 'schema-or-template-only' };
  }
  if (ROOT_FILES.has(rel) || rel.startsWith('manual/')) {
    return { owner_hint: 'template-baseline', extraction: 'anonymize-before-template' };
  }
  return { owner_hint: 'manual-review', extraction: 'classify-before-promoting' };
}

function comparePair(pair, includeSame, options) {
  const gen2Info = gitInfo(pair.gen2);
  const gen3Info = gitInfo(pair.gen3);
  const result = {
    key: pair.key,
    label: pair.label,
    gen2: { path: pair.gen2, git: gen2Info },
    gen3: { path: pair.gen3, git: gen3Info },
    summary: {},
    owner_summary: {},
    entries: [],
  };
  if (!gen2Info.exists) {
    result.error = 'GEN2 path missing';
    return result;
  }
  if (!gen3Info.exists) {
    result.error = 'GEN3 path missing';
    result.summary['target-missing'] = 1;
    return result;
  }
  const gen2Files = walkFiles(pair.gen2, options);
  const gen3Files = walkFiles(pair.gen3, options);
  const rels = Array.from(new Set([...gen2Files.keys(), ...gen3Files.keys()])).sort();
  for (const rel of rels) {
    const gen2File = gen2Files.get(rel);
    const gen3File = gen3Files.get(rel);
    const kind = classify(rel, gen2File, gen3File);
    const hint = ownershipHint(rel);
    result.summary[kind] = (result.summary[kind] || 0) + 1;
    if (kind !== 'same') result.owner_summary[hint.owner_hint] = (result.owner_summary[hint.owner_hint] || 0) + 1;
    if (kind === 'same' && !includeSame) continue;
    result.entries.push({
      path: rel,
      kind,
      ...hint,
      gen2: gen2File ? { size: gen2File.size, sha256: gen2File.sha256.slice(0, 12) } : null,
      gen3: gen3File ? { size: gen3File.size, sha256: gen3File.sha256.slice(0, 12) } : null,
    });
  }
  return result;
}

function printHuman(results, limit) {
  for (const r of results) {
    console.log(`\n== ${r.label} (${r.key}) ==`);
    console.log(`GEN2: ${r.gen2.path}`);
    console.log(`GEN3: ${r.gen3.path}`);
    if (r.error) {
      console.log(`ERROR: ${r.error}`);
      continue;
    }
    console.log('Summary:', JSON.stringify(r.summary));
    console.log('Owner hints:', JSON.stringify(r.owner_summary));
    console.log(`GEN2 git: ${r.gen2.git.branch || '<no-branch>'}@${r.gen2.git.head || '<no-head>'}`);
    console.log(`GEN3 git: ${r.gen3.git.branch || '<no-branch>'}@${r.gen3.git.head || '<no-head>'}`);
    const interesting = r.entries.filter((e) => e.kind !== 'same');
    for (const e of interesting.slice(0, limit)) {
      console.log(`- ${e.kind} [${e.owner_hint}/${e.extraction}]: ${e.path}`);
    }
    if (interesting.length > limit) {
      console.log(`... ${interesting.length - limit} more entries omitted; rerun with --json or --limit ${interesting.length}`);
    }
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  const pairs = loadPairs(args);
  const options = { includeSharedSurfaces: args.includeSharedSurfaces };
  const results = pairs.map((pair) => comparePair(pair, args.includeSame, options));
  if (args.json) console.log(JSON.stringify({ schema_version: 2, generated_at: new Date().toISOString(), results }, null, 2));
  else printHuman(results, args.limit);
} catch (error) {
  console.error(error.message);
  console.error('Run with --help for usage.');
  process.exit(1);
}
