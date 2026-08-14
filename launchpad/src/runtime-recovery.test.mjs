import { expect, test } from "bun:test";
import { runtimeRecoveryModel } from "../public/runtime-recovery.js";

test("cross-Organization discovery failure offers a concrete Codex repair handoff", () => {
  const model = runtimeRecoveryModel(Object.assign(
    new Error("Runtime akce vyžaduje validní Launchpad discovery."),
    {
      code: "invalid_discovery",
      payload: {
        error: "invalid_discovery",
        failure_kind: "invalid_discovery",
        message: "Organizace Lumbio potřebuje opravit nastavení.",
        details: ["modules.manifest.json module_slots[3].path není kanonická boundary"],
      },
    },
  ));

  expect(model).toMatchObject({
    title: "Nastavení aplikace je potřeba opravit",
    action: "codex",
    actionLabel: "Vyřešit s Codexem",
    code: "invalid_discovery",
    failureKind: "invalid_discovery",
  });
  expect(model.technical.join("\n")).toContain("module_slots[3]");
});

test("missing dependencies offer direct scoped repair", () => {
  const model = runtimeRecoveryModel({
    code: "app_start_failed",
    message: "Chybí dependencies.",
    payload: { failure_kind: "missing_dependencies" },
  });

  expect(model.action).toBe("repair");
  expect(model.actionLabel).toBe("Opravit balíčky");
});

test("unknown early exit never degrades to a logs-only dead end", () => {
  const model = runtimeRecoveryModel({
    code: "app_start_failed",
    payload: {
      failure_kind: "unknown_early_exit",
      log_excerpt: "process exited 1",
    },
  });

  expect(model.action).toBe("codex");
  expect(model.message).not.toContain("podívej se na logy");
});
