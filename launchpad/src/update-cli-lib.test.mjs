import { describe, expect, test } from "bun:test";
import {
  formatCommits,
  formatUpdateLaneReport,
  matchOrganizationSelector,
  parseUpdateCliArgs,
  runUpdateLane,
  updateLanePullAllowed,
} from "./update-cli-lib.mjs";

const orgRootRepo = {
  key: "spectoda::root",
  organization: "spectoda",
  organization_path: "organizations/Spectoda_GEN3",
  workspace: "root",
  module: "root",
  repo_kind: "organization_root",
  repo_path: "organizations/Spectoda_GEN3",
};
const moduleRepo = {
  key: "spectoda::deals",
  organization: "spectoda",
  organization_path: "organizations/Spectoda_GEN3",
  workspace: "workspace",
  module: "deals",
  repo_kind: "module",
  repo_path: "organizations/Spectoda_GEN3/workspace/deals",
};
const productionRepo = {
  key: "spectoda::firmware",
  organization: "spectoda",
  organization_path: "organizations/Spectoda_GEN3",
  workspace: "productionspace",
  module: "firmware",
  repo_kind: "module",
  repo_path: "organizations/Spectoda_GEN3/productionspace/firmware",
};

function laneDeps({ rootState = "up_to_date", repoStatuses = {}, pulls = {} } = {}) {
  const calls = { performRoot: [], pullFastForward: [], pullWithAutostash: [] };
  return {
    calls,
    deps: {
      readRootStatus: async () => ({
        state: rootState,
        channel: "stable",
        message: "status",
        counts: { behind: rootState === "update_available" ? 2 : 0, ahead: 0 },
        head: { short_sha: "aaaaaaa" },
        target: { short_sha: "bbbbbbb" },
      }),
      performRoot: async (args) => {
        calls.performRoot.push(args);
        return {
          ok: true,
          updated: rootState === "update_available",
          state: "up_to_date",
          channel: "stable",
          message: "hotovo",
          from_commit: "aaaaaaa1111",
          to_commit: "bbbbbbb2222",
        };
      },
      buildInventory: async () => ({ repos: [orgRootRepo, moduleRepo, productionRepo] }),
      readRepoStatus: async (repo) => repoStatuses[repo.key] ?? { status: "up_to_date", counts: {} },
      pullFastForward: async (repo) => {
        calls.pullFastForward.push(repo.key);
        return pulls[repo.key] ?? { ok: true };
      },
      pullWithAutostash: async (repo) => {
        calls.pullWithAutostash.push(repo.key);
        return pulls[repo.key] ?? { ok: true, stash_preserved: false };
      },
    },
  };
}

describe("parseUpdateCliArgs", () => {
  test("parses org selectors, flags and root override", () => {
    const parsed = parseUpdateCliArgs(["--org", "Spectoda_GEN3", "--org", "avaltar", "--check", "--json", "--root", "/tmp/x"]);
    expect(parsed.ok).toBe(true);
    expect(parsed.options.orgs).toEqual(["Spectoda_GEN3", "avaltar"]);
    expect(parsed.options.check).toBe(true);
    expect(parsed.options.json).toBe(true);
    expect(parsed.options.root).toBe("/tmp/x");
    expect(parsed.options.preserve).toBe(false);
  });

  test("fails closed on unknown flag and missing --org value", () => {
    expect(parseUpdateCliArgs(["--force"]).ok).toBe(false);
    expect(parseUpdateCliArgs(["--org"]).ok).toBe(false);
    expect(parseUpdateCliArgs(["--org", "--check"]).ok).toBe(false);
  });
});

describe("scope guards", () => {
  test("productionspace is never pull-eligible; org root and workspace module are", () => {
    expect(updateLanePullAllowed(orgRootRepo)).toBe(true);
    expect(updateLanePullAllowed(moduleRepo)).toBe(true);
    expect(updateLanePullAllowed(productionRepo)).toBe(false);
  });

  test("selector matches company slug and mount folder basename, case-insensitive", () => {
    expect(matchOrganizationSelector(orgRootRepo, "spectoda")).toBe(true);
    expect(matchOrganizationSelector(orgRootRepo, "Spectoda_GEN3")).toBe(true);
    expect(matchOrganizationSelector(orgRootRepo, "spectoda_gen3")).toBe(true);
    expect(matchOrganizationSelector(orgRootRepo, "lumbio")).toBe(false);
  });
});

describe("runUpdateLane", () => {
  test("root-only update runs ff_only by default and reports ok", async () => {
    const { deps, calls } = laneDeps({ rootState: "update_available" });
    const result = await runUpdateLane({
      rootPath: "/x",
      options: { orgs: [], allOrgs: false, check: false, preserve: false },
      deps,
    });
    expect(calls.performRoot[0].mode).toBe("ff_only");
    expect(result.ok).toBe(true);
    expect(result.root.updated).toBe(true);
    expect(result.organizations).toEqual([]);
  });

  test("check mode never mutates and reports update_available", async () => {
    const { deps, calls } = laneDeps({
      rootState: "update_available",
      repoStatuses: { "spectoda::deals": { status: "pull_available", counts: { incoming: 3, outgoing: 0 } } },
    });
    const result = await runUpdateLane({
      rootPath: "/x",
      options: { orgs: ["spectoda"], allOrgs: false, check: true, preserve: false },
      deps,
    });
    expect(calls.performRoot).toEqual([]);
    expect(calls.pullFastForward).toEqual([]);
    expect(calls.pullWithAutostash).toEqual([]);
    expect(result.root.state).toBe("update_available");
    expect(result.organizations.find((entry) => entry.repo_key === "spectoda::deals").outcome)
      .toBe("update_available");
    expect(result.ok).toBe(true);
  });

  test("org update pulls eligible repos, skips productionspace, blocks dirty without --preserve", async () => {
    const { deps, calls } = laneDeps({
      repoStatuses: {
        "spectoda::root": { status: "pull_available", counts: { incoming: 1, outgoing: 0 } },
        "spectoda::deals": { status: "draft_changes", counts: { incoming: 2, outgoing: 0 } },
      },
    });
    const result = await runUpdateLane({
      rootPath: "/x",
      options: { orgs: ["Spectoda_GEN3"], allOrgs: false, check: false, preserve: false },
      deps,
    });
    expect(calls.pullFastForward).toEqual(["spectoda::root"]);
    expect(calls.pullWithAutostash).toEqual([]);
    const byKey = Object.fromEntries(result.organizations.map((entry) => [entry.repo_key, entry.outcome]));
    expect(byKey["spectoda::root"]).toBe("pulled");
    expect(byKey["spectoda::deals"]).toBe("blocked_dirty");
    expect(byKey["spectoda::firmware"]).toBe("policy_skipped");
    expect(result.ok).toBe(false);
    expect(result.summary.org_blocked_count).toBe(1);
  });

  test("--preserve enables autostash pull for dirty behind-only repos", async () => {
    const { deps, calls } = laneDeps({
      repoStatuses: { "spectoda::deals": { status: "draft_changes", counts: { incoming: 2, outgoing: 0 } } },
    });
    const result = await runUpdateLane({
      rootPath: "/x",
      options: { orgs: ["spectoda"], allOrgs: false, check: false, preserve: true },
      deps,
    });
    expect(calls.pullWithAutostash).toEqual(["spectoda::deals"]);
    expect(result.organizations.find((entry) => entry.repo_key === "spectoda::deals").outcome)
      .toBe("autostash_pulled");
  });

  test("diverged and push_required repos are reported, never pulled", async () => {
    const { deps, calls } = laneDeps({
      repoStatuses: {
        "spectoda::root": { status: "diverged", counts: { incoming: 2, outgoing: 1 } },
        "spectoda::deals": { status: "push_required", counts: { incoming: 0, outgoing: 1 } },
      },
    });
    const result = await runUpdateLane({
      rootPath: "/x",
      options: { orgs: ["spectoda"], allOrgs: false, check: false, preserve: true },
      deps,
    });
    expect(calls.pullFastForward).toEqual([]);
    expect(calls.pullWithAutostash).toEqual([]);
    const byKey = Object.fromEntries(result.organizations.map((entry) => [entry.repo_key, entry.outcome]));
    expect(byKey["spectoda::root"]).toBe("skipped");
    expect(byKey["spectoda::deals"]).toBe("skipped");
  });

  test("unknown org selector fails closed with available organizations", async () => {
    const { deps } = laneDeps();
    const result = await runUpdateLane({
      rootPath: "/x",
      options: { orgs: ["neexistuje"], allOrgs: false, check: false, preserve: false },
      deps,
    });
    expect(result.ok).toBe(false);
    expect(result.selector_errors[0]).toContain("neexistuje");
    expect(result.selector_errors[0]).toContain("spectoda");
  });
});

describe("report formatting", () => {
  test("czech commit pluralization", () => {
    expect(formatCommits(1)).toBe("1 commit");
    expect(formatCommits(2)).toBe("2 commity");
    expect(formatCommits(5)).toBe("5 commitů");
  });

  test("report leads with root outcome and flags blocked states", async () => {
    const { deps } = laneDeps({
      repoStatuses: { "spectoda::deals": { status: "draft_changes", counts: { incoming: 2, outgoing: 0 } } },
    });
    const result = await runUpdateLane({
      rootPath: "/x",
      options: { orgs: ["spectoda"], allOrgs: false, check: false, preserve: false },
      deps,
    });
    const report = formatUpdateLaneReport(result);
    expect(report.startsWith("Conglomerate root · stable:")).toBe(true);
    expect(report).toContain("BLOKOVÁNO");
    expect(report).toContain("Souhrn Organizací:");
    expect(report).toContain("vyžaduje pozornost");
  });
});
