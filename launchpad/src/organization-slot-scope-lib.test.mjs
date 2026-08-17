import { describe, expect, test } from "bun:test";
import {
  githubRepositoryCoordinate,
  isCanonicalOrganizationRepositorySlotPath,
  organizationRepositorySlotCollectionIssues,
  organizationSlotRepositoryId,
  organizationSlotRepositoryMountIssue,
} from "../../lazurio/core/organization-slot-scope-lib.mjs";

describe("case-preserving Organization repository mount paths", () => {
  test.each([
    "workspace/knowledgebase",
    "workspace/Knowledgebase.v2",
    "productionspace/Buddy_GEN2",
    "productionspace/Dashboard",
    "modules/Legacy_Module-2",
  ])("accepts exact repository basename %s", (path) => {
    expect(isCanonicalOrganizationRepositorySlotPath(path)).toBe(true);
  });

  test.each([
    "productionspace/.Buddy_GEN2",
    "productionspace/Buddy GEN2",
    "productionspace/Buddy_GEN2.",
    "productionspace/Nested/Buddy_GEN2",
    "workspace/..",
    "workspace/../../etc/passwd",
    "/workspace/repo",
    "productionspace/Buddy_GEN2/",
    "productionspace\\Buddy_GEN2",
  ])("rejects unsafe or non-canonical mount path %s", (path) => {
    expect(isCanonicalOrganizationRepositorySlotPath(path)).toBe(false);
  });

  test("keeps stable lowercase ID separate from the exact repository mount", () => {
    const slot = { slug: "buddy-gen2", path: "productionspace/Buddy_GEN2" };
    expect(organizationSlotRepositoryId(slot)).toBe("buddy-gen2");
    expect(organizationSlotRepositoryId({ path: slot.path })).toBeNull();
    expect(organizationSlotRepositoryId({ slug: "Buddy_GEN2", path: slot.path })).toBeNull();
    expect(organizationSlotRepositoryId({ path: "workspace/knowledgebase" })).toBe("knowledgebase");
    expect(organizationSlotRepositoryId({ slug: "root", path: "workspace/root-tools" })).toBeNull();
    expect(organizationSlotRepositoryId({ slug: "repo-", path: "workspace/repo" })).toBeNull();
    expect(organizationSlotRepositoryId({ slug: "repo--legacy", path: "workspace/repo" })).toBeNull();
  });

  test("requires the physical mount basename to match the GitHub repository exactly", () => {
    expect(organizationSlotRepositoryMountIssue({
      slug: "buddy-gen2",
      path: "productionspace/Buddy_GEN2",
      git: { url: "git@github.com:HumanAndMachine-ai/Buddy_GEN2.git" },
    })).toBeNull();
    expect(organizationSlotRepositoryMountIssue({
      slug: "buddy-gen2",
      path: "productionspace/Buddy_GEN2",
      git: { url: "git@github.com:HumanAndMachine-ai/Other.git" },
    })).toContain('"Buddy_GEN2" neodpovídá přesnému názvu GitHub repozitáře "Other"');
    expect(organizationSlotRepositoryMountIssue({
      slug: "buddy-gen2",
      path: "productionspace/Buddy_GEN2",
      repo: "git@github.com:HumanAndMachine-ai/Other.git",
      git: { url: "git@github.com:HumanAndMachine-ai/Buddy_GEN2.git" },
    })).toContain('"Buddy_GEN2" neodpovídá přesnému názvu GitHub repozitáře "Other"');
  });

  test("parses dotted GitHub repository names without dropping their suffix", () => {
    expect(githubRepositoryCoordinate("git@github.com:Example/Knowledgebase.v2.git")).toEqual({
      owner: "Example",
      repository: "Knowledgebase.v2",
      ownerRepo: "Example/Knowledgebase.v2",
    });
  });

  test("rejects logical ID and case-insensitive path collisions", () => {
    expect(organizationRepositorySlotCollectionIssues([
      { slug: "buddy-gen2", path: "productionspace/Buddy_GEN2" },
      { slug: "buddy-gen2", path: "productionspace/Buddy-legacy" },
      { slug: "buddy-shadow", path: "productionspace/buddy_gen2" },
    ])).toEqual([
      'repository slug "buddy-gen2" používají zároveň "productionspace/Buddy_GEN2" a "productionspace/Buddy-legacy"',
      'repo cesty "productionspace/Buddy_GEN2" a "productionspace/buddy_gen2" se liší jen velikostí písmen',
    ]);
  });

  test("allows the same path and ID across migration surfaces but rejects a cross-file mismatch", () => {
    expect(organizationRepositorySlotCollectionIssues([
      { slug: "knowledgebase", path: "workspace/knowledgebase" },
      { slug: "knowledgebase", path: "workspace/knowledgebase" },
    ], { allowEquivalentDuplicates: true })).toEqual([]);
    expect(organizationRepositorySlotCollectionIssues([
      { slug: "knowledgebase", path: "workspace/knowledgebase" },
      { slug: "knowledgebase", path: "workspace/KnowledgebaseV2" },
    ], { allowEquivalentDuplicates: true })).toContain(
      'repository slug "knowledgebase" používají zároveň "workspace/knowledgebase" a "workspace/KnowledgebaseV2"',
    );
  });
});
