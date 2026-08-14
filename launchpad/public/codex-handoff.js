const PORT_CONFLICT_KIND = "port_owner_cwd_mismatch";
const STYLESHEET_ID = "codex-handoff-styles";

let dialog = null;
let promptField = null;
let copyButton = null;
let copyStatus = null;
let returnFocus = null;
let returnFocusAppId = null;
let dialogTitle = null;
let dialogIntro = null;

export function isCodexPortConflict(app) {
  return app?.runtime?.failure_kind === PORT_CONFLICT_KIND;
}

export function buildCodexPortConflictPrompt(app = {}) {
  const title = cleanValue(app.title ?? app.name ?? app.id, "neznámá aplikace");
  const appId = cleanValue(app.id);
  const organization = cleanValue(app.company ?? app.organization);
  const port = cleanValue(app.port ?? app.runtime?.port);
  const pid = cleanValue(app.runtime?.pid ?? app.runtime?.port_owner?.pid);
  const expectedCwd = cleanValue(app.dependencies?.cwd ?? app.cwd);
  const runtimeMessage = cleanValue(app.runtime?.message);

  return `V Launchpadu mám blokovanou aplikaci „${title}“. Potřebuji bezpečně uvolnit její lokální vývojový port, aby ji potom mohl spustit Launchpad.

Kontext z Launchpadu:
- Organizace: ${organization}
- ID aplikace: ${appId}
- Port: ${port}
- PID procesu na portu: ${pid}
- Očekávaný checkout aplikace: ${expectedCwd}
- Diagnostika: ${runtimeMessage}

Postupuj prosím takto:
1. Nejdřív pouze čtením ověř, který proces port používá, jeho příkaz, pracovní složku a zda jde o zapomenutý lokální dev/preview proces.
2. Proces ukonči jen tehdy, když je jednoznačně bezpečné, že jde o lokální vývojový náhled a ne o Launchpad, produkční službu, databázi, VPN, systémový proces nebo jinou důležitou práci. Začni šetrným ukončením; nepoužívej force, pokud to není nezbytné a výslovně zdůvodněné.
3. Pokud se PID změnil, vlastnictví nejde spolehlivě ověřit nebo proces není bezpečné ukončit, nic neukončuj. Vysvětli mi přesně, co blokuje pokračování.
4. Po bezpečném ukončení ověř, že port už nemá listener. Pokud lze bezpečně dohledat běžící Launchpad, ověř znovu stav aplikace; jinak mi řekni, ať v Launchpadu kliknu na „Obnovit stav“ a potom aplikaci spustím.

Hranice úkolu: neměň soubory, Git stav, závislosti ani data aplikací; neukončuj žádné jiné procesy a nemaž žádné soubory. Na závěr napiš, co bylo ověřeno, co případně bylo ukončeno a zda je port volný.`;
}

export function openCodexPortConflictDialog(app) {
  if (typeof document === "undefined" || !isCodexPortConflict(app)) return false;
  return openCodexHandoffDialog({
    app,
    title: "Vyřešit blokaci s Codexem",
    intro: "Launchpad cizí proces sám neukončí. Codex ho nejdřív ověří a zasáhne pouze tehdy, když jde bezpečně o lokální vývojový náhled.",
    prompt: buildCodexPortConflictPrompt(app),
  });
}

export function buildCodexRuntimeIssuePrompt(app = {}, issue = {}) {
  const title = cleanValue(app.title ?? app.name ?? app.id, "neznámá aplikace");
  const technical = Array.isArray(issue.technical) && issue.technical.length > 0
    ? issue.technical.map((value) => `- ${cleanValue(value)}`).join("\n")
    : "- neuvedeno";
  return `V Launchpadu nejde spustit aplikace „${title}“. Potřebuji najít skutečnou příčinu, udělat nejmenší bezpečnou opravu ve správném scope a ověřit spuštění přes Launchpad.

Kontext z Launchpadu:
- Organizace: ${cleanValue(app.company ?? app.organization)}
- ID aplikace: ${cleanValue(app.id)}
- Kód chyby: ${cleanValue(issue.code)}
- Druh selhání: ${cleanValue(issue.failureKind)}
- Checkout aplikace: ${cleanValue(app.dependencies?.cwd ?? app.cwd)}
- Log: ${cleanValue(app.runtime?.log_path)}

Diagnostika:
${technical}

Postupuj prosím takto:
1. Nejdřív pouze čtením ověř příčinu, Git stav a správný root / Organizaci / modul.
2. Pokud existuje bezpečná automatická náprava, proveď ji jen v rozsahu této aplikace. Cizí Organizaci neopravuj z nesprávného scope a neobcházej validační ani access hranice.
3. Je-li potřeba změna souborů, zachovej cizí práci a použij předepsaný worktree + Draft PR postup. Nic nemerguj ani nepublikuj bez mého explicitního pokynu.
4. Nakonec aplikaci spusť stejnou cestou přes Launchpad a ověř její health. Když oprava vyžaduje moje rozhodnutí nebo cizí pravomoc, řekni přesně jakou a proč.

Hranice úkolu: nemaž data, neměň přístupy ani secrets a neukončuj neověřené procesy.`;
}

export function openCodexRuntimeIssueDialog(app, issue) {
  if (typeof document === "undefined") return false;
  return openCodexHandoffDialog({
    app,
    title: "Vyřešit spuštění s Codexem",
    intro: "Launchpad připravil přesný kontext chyby. Codex podle něj ověří příčinu, opraví správný scope a znovu zkontroluje spuštění.",
    prompt: buildCodexRuntimeIssuePrompt(app, issue),
  });
}

function openCodexHandoffDialog({ app, title, intro, prompt }) {
  ensureStylesheet();
  ensureDialog();

  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  returnFocusAppId = cleanValue(app.id, "");
  dialogTitle.textContent = title;
  dialogIntro.textContent = intro;
  promptField.value = prompt;
  copyStatus.textContent = "";
  copyButton.textContent = "Zkopírovat zprávu";

  if (!dialog.open) dialog.showModal();
  queueMicrotask(() => copyButton.focus());
  return true;
}

function ensureStylesheet() {
  if (document.getElementById(STYLESHEET_ID)) return;
  const link = document.createElement("link");
  link.id = STYLESHEET_ID;
  link.rel = "stylesheet";
  link.href = new URL("./codex-handoff.css", import.meta.url).href;
  document.head.append(link);
}

function ensureDialog() {
  if (dialog?.isConnected) return;

  dialog = document.createElement("dialog");
  dialog.className = "codex-handoff-dialog";
  dialog.setAttribute("aria-labelledby", "codexHandoffTitle");
  dialog.setAttribute("aria-describedby", "codexHandoffIntro codexHandoffSteps");

  const header = document.createElement("header");
  header.className = "codex-handoff-head";
  dialogTitle = document.createElement("h2");
  dialogTitle.id = "codexHandoffTitle";
  dialogTitle.textContent = "Vyřešit blokaci s Codexem";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "codex-handoff-close";
  closeButton.setAttribute("aria-label", "Zavřít okno");
  closeButton.textContent = "×";
  closeButton.addEventListener("click", () => dialog.close());
  header.append(dialogTitle, closeButton);

  const body = document.createElement("div");
  body.className = "codex-handoff-body";
  dialogIntro = document.createElement("p");
  dialogIntro.id = "codexHandoffIntro";
  dialogIntro.textContent = "Launchpad cizí proces sám neukončí. Codex ho nejdřív ověří a zasáhne pouze tehdy, když jde bezpečně o lokální vývojový náhled.";
  const steps = document.createElement("ol");
  steps.id = "codexHandoffSteps";
  steps.className = "codex-handoff-steps";
  for (const text of [
    "Zkopírujte připravenou zprávu.",
    "Otevřete Codex na tomto počítači a vložte ji jako nový úkol.",
    "Po dokončení se vraťte do Launchpadu a obnovte stav.",
  ]) {
    const item = document.createElement("li");
    item.textContent = text;
    steps.append(item);
  }

  const label = document.createElement("label");
  label.className = "codex-handoff-label";
  label.htmlFor = "codexHandoffPrompt";
  label.textContent = "Zpráva pro Codex";
  promptField = document.createElement("textarea");
  promptField.id = "codexHandoffPrompt";
  promptField.className = "codex-handoff-prompt";
  promptField.readOnly = true;
  promptField.spellcheck = false;
  promptField.rows = 14;
  body.append(dialogIntro, steps, label, promptField);

  const footer = document.createElement("footer");
  footer.className = "codex-handoff-actions";
  copyStatus = document.createElement("p");
  copyStatus.className = "codex-handoff-status";
  copyStatus.setAttribute("aria-live", "polite");
  const buttons = document.createElement("div");
  buttons.className = "codex-handoff-buttons";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "btn btn-secondary";
  cancelButton.textContent = "Zavřít";
  cancelButton.addEventListener("click", () => dialog.close());
  copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "btn btn-primary";
  copyButton.textContent = "Zkopírovat zprávu";
  copyButton.addEventListener("click", copyPrompt);
  buttons.append(cancelButton, copyButton);
  footer.append(copyStatus, buttons);

  dialog.append(header, body, footer);
  dialog.addEventListener("close", () => {
    const previousFocus = returnFocus;
    const appId = returnFocusAppId;
    returnFocus = null;
    returnFocusAppId = null;
    requestAnimationFrame(() => {
      const focusTarget = previousFocus?.isConnected && previousFocus !== document.body
        ? previousFocus
        : findAppTrigger(appId);
      focusTarget?.focus();
    });
  });
  document.body.append(dialog);
}

async function copyPrompt() {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(promptField.value);
    } else {
      promptField.focus();
      promptField.select();
      if (!document.execCommand("copy")) throw new Error("copy_failed");
    }
    copyButton.textContent = "Zkopírováno";
    copyStatus.textContent = "Zpráva je ve schránce. Vložte ji do nového úkolu v Codexu.";
  } catch {
    promptField.focus();
    promptField.select();
    copyStatus.textContent = "Automatické kopírování se nepovedlo. Zpráva je označená, zkopírujte ji ručně.";
  }
}

function cleanValue(value, fallback = "neuvedeno") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function findAppTrigger(appId) {
  if (!appId) return null;
  return [...document.querySelectorAll("[data-app-id]")].find((element) => (
    element instanceof HTMLElement
    && element.dataset.appId === appId
    && element.matches("button, [tabindex]")
  )) ?? null;
}
