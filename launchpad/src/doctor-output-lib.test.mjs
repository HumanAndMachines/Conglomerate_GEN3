import { expect, test } from "bun:test";

import { renderHumanDoctorReport } from "./doctor-output-lib.mjs";

test("lidský Doctor renderer zachová blocked, not_applicable i child důkazy", () => {
  const output = renderHumanDoctorReport({
    scope: { name: "Fixture root" },
    summary: { status: "incomplete" },
    checks: [
      {
        id: "fixture.blocked",
        status: "blocked",
        message: "Fixture je zablokovaná",
        blocked_reason: "Chybí vstup",
        remedy: "Doplňte vstup",
        details: ["detail blokace"],
      },
      {
        id: "fixture.external",
        status: "not_applicable",
        message: "Řídí jiný scope",
        not_applicable_reason: "owned_by_root",
        owner: "launchpad_root",
        details: [],
      },
    ],
    children: [{
      outcome: "scope_mismatch",
      declaration_path: "personal.gen3.json",
      invoked_command: ["bun", "doctor.mjs", "--json"],
      failures: ["Report patří jinému scope"],
    }],
  });

  expect(output).toBe([
    "incomplete - Fixture root",
    "blocked - fixture.blocked: Fixture je zablokovaná",
    "  ! Chybí vstup",
    "  → Doplňte vstup",
    "  - detail blokace",
    "not_applicable - fixture.external: Řídí jiný scope",
    "  ~ owned_by_root · vlastní: launchpad_root",
    "scope_mismatch - podřízený doctor personal.gen3.json (bun doctor.mjs --json)",
    "  - Report patří jinému scope",
  ].join("\n"));
});
