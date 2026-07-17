import { expect, test } from "bun:test";
import { posix, win32 } from "path";

import {
  PERSONAL_SCHEMA_VERSION,
  PERSONALSPACE_TEMPLATE,
  PERSONALSPACE_TEMPLATE_VERSION,
  parseCreateArgs,
  targetForRoot,
  validateBuddyRepoOption,
  validateGbrainRepoOption,
  validateTemplateMarker,
} from "./create-personalspace.mjs";

test("create parser drží apply a gbrain instalaci explicitní", () => {
  expect(parseCreateArgs([
    "--display-name",
    "Example Owner",
    "--apply",
    "--install-gbrain",
  ])).toMatchObject({
    displayName: "Example Owner",
    apply: true,
    installGbrain: true,
    withBuddy: false,
    ownerType: "human",
  });
  expect(parseCreateArgs([
    "--display-name",
    "Example Owner",
    "--apply",
    "--with-buddy",
    "--buddy-repo",
    "example/example-assistant",
  ])).toMatchObject({
    displayName: "Example Owner",
    apply: true,
    installGbrain: false,
    withBuddy: true,
    buddyRepo: "example/example-assistant",
    ownerType: "human",
  });
  expect(() => parseCreateArgs([
    "--with-buddy",
    "--install-gbrain",
  ])).toThrow("nelze kombinovat");
  expect(PERSONALSPACE_TEMPLATE).toBe("HumanAndMachines/PersonalspaceTemplate_GEN3");
});

test("cílový mount je deterministický v POSIX i Windows cestě", () => {
  expect(targetForRoot("/home/example/Conglomerate", "example", posix)).toBe(
    "/home/example/Conglomerate/personalspace/example_GEN3",
  );
  expect(targetForRoot("D:\\Home\\Example\\Conglomerate", "example", win32)).toBe(
    "D:\\Home\\Example\\Conglomerate\\personalspace\\example_GEN3",
  );
});

test("neznámý argument a chybějící hodnota failují", () => {
  expect(() => parseCreateArgs(["--unknown"])).toThrow();
  expect(() => parseCreateArgs(["--display-name"])).toThrow();
});

test("template marker váže přesný upstream a verzi personal kontraktu", () => {
  expect(validateTemplateMarker({
    schema_version: PERSONALSPACE_TEMPLATE_VERSION,
    template_repo: PERSONALSPACE_TEMPLATE,
    personal_schema_version: PERSONAL_SCHEMA_VERSION,
  })).toEqual([]);
  expect(validateTemplateMarker({
    schema_version: "unknown",
    template_repo: "other/repo",
    personal_schema_version: "legacy",
  })).toHaveLength(3);
});

test("custom gbrain repo patří ownerovi a nikdy nealiasuje owner repo", () => {
  expect(validateGbrainRepoOption("example", "example/example-gbrain")).toEqual([]);
  expect(validateGbrainRepoOption("example", "other/example-gbrain")).toHaveLength(1);
  expect(validateGbrainRepoOption("example", "example/example_GEN3")).toHaveLength(1);
  expect(validateGbrainRepoOption("example", "invalid")).toHaveLength(1);
});

test("custom Buddy repo patří ownerovi a nealiasuje owner ani gbrain", () => {
  expect(validateBuddyRepoOption("example", "example/example-buddy")).toEqual([]);
  expect(validateBuddyRepoOption("example", "other/example-buddy")).toHaveLength(1);
  expect(validateBuddyRepoOption("example", "example/example_GEN3")).toHaveLength(1);
  expect(validateBuddyRepoOption(
    "example",
    "example/memory",
    "example/memory",
  )).toHaveLength(1);
  expect(validateBuddyRepoOption("example", "invalid")).toHaveLength(1);
});
