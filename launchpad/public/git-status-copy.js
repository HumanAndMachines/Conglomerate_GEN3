// Lidské texty git stavů (CAC-0044, step-005 prep) — portované 1:1 z GEN2
// Kontroly (GEN2 Launchpad app.js). Launchpad je
// builder surface pro neprogramátory: git mechanika se překládá do lidského
// jazyka, žádný git žargon v primárním UI.
//
// Tenhle modul je čistá copy/prezentační vrstva — nemá žádnou org-specific
// pravdu ani git implementaci. Data (status stringy) mu dodá git read model
// z CAC-0042. Bez dostupného git read modelu se chip na kartě chová graceful:
// bez git dat se prostě nezobrazí (viz gitChipModel).

// Krátký lidský label stavu — pro chip na kartě.
export function humanGitStatusLabel(status) {
  const labels = {
    up_to_date: "v pořádku",
    // CAC-0042 read model používá pull_available; GEN2 mělo update_available.
    pull_available: "novější verze",
    update_available: "novější verze",
    push_required: "čeká na odeslání",
    diverged: "ověřit změny",
    draft_changes: "rozdělaná práce",
    dirty_local_changes: "rozdělaná práce",
    wrong_branch: "jiný režim",
    not_on_main: "jiný režim",
    repo_missing: "chybí složka",
    git_unavailable: "Git nejde spustit",
    check_failed: "kontrola se nepovedla",
  };
  return labels[status] ?? status;
}

// Delší vysvětlení stavu — pro detail a ⋯ menu. Diverged/wrong_branch vedou na
// pomocníka, ne na automatický pull (nesmí zamlčet riziko).
export function gitStatusUserMessage(repo) {
  if (!repo) return "";
  if (
    (repo.status === "git_unavailable" || repo.status === "check_failed") &&
    repo.message
  ) {
    return repo.message;
  }

  const messages = {
    up_to_date: "Tenhle modul je připravený.",
    pull_available:
      "Někdo mezitím poslal novější verzi. Můžeš ji bezpečně stáhnout.",
    update_available:
      "Někdo mezitím poslal novější verzi. Můžeš ji bezpečně stáhnout.",
    push_required:
      "Tady jsou hotové uložené změny, které ještě nejsou odeslané ostatním.",
    diverged:
      "Tady jsou změny na tvém počítači i ve sdílené verzi. Nech to raději porovnat pomocníkem.",
    draft_changes:
      "Tady je rozepsaná práce. Můžeš si zobrazit, co se změnilo.",
    dirty_local_changes:
      "Tady je rozepsaná práce. Můžeš si zobrazit, co se změnilo.",
    wrong_branch:
      "Tenhle modul je v nestandardním pracovním režimu. Pomocník zjistí proč.",
    not_on_main:
      "Tenhle modul je v nestandardním pracovním režimu. Pomocník zjistí proč.",
    repo_missing:
      "Launchpad tuhle složku nenašel. Pomocník zjistí, jestli chybí přístup nebo lokální instalace.",
    git_unavailable:
      "Launchpad neumí spustit kontrolu stavu. Pomocník prověří lokální nastavení.",
    check_failed:
      "Kontrola se nepovedla. Pomocník se podívá na detail a navrhne další krok.",
  };
  return messages[repo.status] ?? repo.message ?? repo.title ?? "";
}

// Tón chipu podle severity (ok/warn/fail) → mapuje na chip- třídy v CSS.
export function gitStatusTone(status) {
  const okStates = ["up_to_date"];
  const failStates = ["diverged", "repo_missing", "git_unavailable", "check_failed"];
  if (okStates.includes(status)) return "muted";
  if (failStates.includes(status)) return "danger";
  return "warn";
}

// Git attention: stavy, které mají modul zahrnout při zapnutém kontrolním togglu.
// up_to_date není attention; všechno ostatní ano.
export function isGitAttentionStatus(status) {
  if (!status) return false;
  return status !== "up_to_date";
}

// Chip model pro kartu s graceful absencí. Vrací null, když git data nejsou —
// karta pak git chip vůbec nevykreslí (dokud git read model není dostupný).
export function gitChipModel(gitRepo) {
  if (!gitRepo || typeof gitRepo.status !== "string") return null;
  return {
    status: gitRepo.status,
    label: humanGitStatusLabel(gitRepo.status),
    message: gitStatusUserMessage(gitRepo),
    tone: gitStatusTone(gitRepo.status),
    attention: isGitAttentionStatus(gitRepo.status),
  };
}
