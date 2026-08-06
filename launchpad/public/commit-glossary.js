// Slovník pro převod commitů do češtiny (CAC-0095).
//
// **Proč slovník a ne překladač.** Launchpad běží lokálně a offline, žádný
// jazykový model v něm není. Obecnou anglickou větu proto přeložit neumí.
// Co ale umí: commit messages v tomhle workspace mají skoro vždy tvar
// `Oblast: sloveso objekt` („Website: Improve mobile product carousel")
// a sloveso je z malé uzavřené množiny.
//
// **Překládá se sloveso, ne objekt — a je to měřené rozhodnutí.**
// Slovník celých frází („official logo usage" → „pravidel pro používání
// loga") jsme zkusili a na 410 skutečných commitech tohohle workspace trefil
// 9 z nich. Objekty jsou totiž skoro vždy vlastní jména produktů, značek
// a zákazníků („Spectoda T-Mobile reference guidance", „Acebeam portable
// lamps supplier baseline"), a ta se nepřekládají ani přeložit nemají.
// Sloveso naproti tomu sedí u 215 ze 410 — a nese to podstatné: *co se
// stalo*. Ukazuje se proto jako štítek nad původní větou autora, ne jako
// polovičatě přeložená věta.

// Sloveso → české slovesné podstatné jméno. Podstatné jméno schválně:
// vyhne se shodě v rodě („přidal" vs „přidala") u actora, kterého stejně
// jmenuje řádek nad shrnutím.
export const VERBS = {
  add: "Přidání",
  adds: "Přidání",
  added: "Přidání",
  introduce: "Zavedení",
  create: "Vytvoření",
  establish: "Zavedení",
  register: "Zaevidování",
  remove: "Odstranění",
  removed: "Odstranění",
  delete: "Odstranění",
  drop: "Odstranění",
  fix: "Oprava",
  fixes: "Oprava",
  fixed: "Oprava",
  repair: "Oprava",
  update: "Aktualizace",
  refresh: "Aktualizace",
  upgrade: "Povýšení",
  improve: "Vylepšení",
  refine: "Vylepšení",
  enhance: "Vylepšení",
  polish: "Vylepšení",
  standardize: "Sjednocení",
  normalize: "Sjednocení",
  unify: "Sjednocení",
  align: "Sjednocení",
  codify: "Zaznamenání",
  record: "Zaznamenání",
  document: "Zaznamenání",
  clarify: "Ujasnění",
  rename: "Přejmenování",
  separate: "Oddělení",
  split: "Rozdělení",
  restore: "Obnovení",
  stabilize: "Zpevnění",
  harden: "Zpevnění",
  bound: "Omezení",
  scope: "Omezení",
  limit: "Omezení",
  install: "Instalace",
  adjust: "Úprava",
  mark: "Označení",
  archive: "Archivace",
  expand: "Rozšíření",
  apply: "Zapracování",
  propose: "Návrh",
  draft: "Návrh",
  reconcile: "Srovnání",
  rotate: "Výměna",
  migrate: "Převedení",
  prepare: "Příprava",
};

// Název složky → lidské téma. Většina složek v tomhle workspace je pojmenovaná
// srozumitelně a často rovnou česky (`logo`, `diagramy`, `socialni-site`),
// takže se jen rozdělí pomlčky a doplní diakritika u těch, kde chybí. Anglické
// technické názvy dostanou český protějšek. Co tu není, se ukáže tak, jak se
// složka jmenuje — na rozdíl od anglické věty je to pořád srozumitelné slovo.
export const TOPIC_LABELS = {
  "socialni-site": "sociální sítě",
  pozicovani: "pozicování",
  diagramy: "diagramy",
  logo: "logo",
  brand: "značka",
  colors: "barvy",
  fonts: "fonty",
  typografie: "typografie",
  tokens: "tokeny",
  hlas: "hlas a tón",
  stav: "stav",
  invoices: "faktury",
  deals: "obchodní případy",
  warehouse: "sklad",
  knowledgebase: "znalostní báze",
  website: "web",
  workflows: "automatické kontroly",
  migrations: "migrace",
  decisions: "rozhodnutí",
};
