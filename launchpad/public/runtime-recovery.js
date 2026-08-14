export function runtimeRecoveryModel(error = {}) {
  const payload = error?.payload && typeof error.payload === "object" ? error.payload : {};
  const code = cleanToken(error?.code ?? payload.error ?? "runtime_action_failed");
  const failureKind = cleanToken(payload.failure_kind ?? error?.failure_kind ?? code);
  const technical = uniqueStrings([
    payload.message,
    error?.message,
    ...(Array.isArray(payload.details) ? payload.details : []),
    ...(Array.isArray(error?.details) ? error.details : []),
  ]);

  if (["invalid_discovery", "invalid_manifest", "bad_cwd", "missing_script"].includes(failureKind)
    || ["invalid_discovery", "invalid_manifest", "app_not_found"].includes(code)) {
    return {
      title: "Nastavení aplikace je potřeba opravit",
      message: "Launchpad aplikaci bezpečně nespustil. Připravil přesný kontext, se kterým může Codex opravit správnou deklaraci a ověřit spuštění.",
      action: "codex",
      actionLabel: "Vyřešit s Codexem",
      code,
      failureKind,
      technical,
    };
  }

  if (["missing_dependencies", "needs_install", "stale_lockfile", "install_script_failed", "missing_package"].includes(failureKind)
    || ["app_install_failed", "app_repair_failed"].includes(code)) {
    return {
      title: "Aplikaci je potřeba opravit",
      message: "Chybí nebo nesedí potřebné součásti. Launchpad je může bezpečně opravit v rozsahu této aplikace.",
      action: "repair",
      actionLabel: "Opravit balíčky",
      code,
      failureKind,
      technical,
    };
  }

  if (["start_timeout", "starting_timeout", "health_timeout"].includes(failureKind)) {
    return {
      title: "Aplikace startuje příliš dlouho",
      message: "Launchpad zatím nepotvrdil, že aplikace odpovídá. Stav můžete znovu ověřit a spuštění bezpečně zopakovat.",
      action: "retry",
      actionLabel: "Zkusit znovu",
      code,
      failureKind,
      technical,
    };
  }

  return {
    title: "Spuštění se nepovedlo",
    message: "Launchpad zachoval přesnou příčinu a připravil bezpečné předání do Codexu, který problém ověří a opraví ve správném scope.",
    action: "codex",
    actionLabel: "Vyřešit s Codexem",
    code,
    failureKind,
    technical,
  };
}

function cleanToken(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "runtime_action_failed";
}

function uniqueStrings(values) {
  return [...new Set(values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).trim())
    .filter(Boolean))];
}
