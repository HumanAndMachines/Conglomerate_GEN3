// Destruktivní render nahradí původní ⋯ trigger novým DOM uzlem. Fokus proto
// obnovujeme až v microtasku na trigger se stejnou stabilní identitou.
export function focusMenuTriggerAfterRender(root, identity, schedule = queueMicrotask) {
  schedule(() => {
    const target = [...root.querySelectorAll(".app-more-button")]
      .find((candidate) => candidate.dataset.menuFocusKey === identity);
    if (typeof target?.focus === "function") target.focus();
  });
}
