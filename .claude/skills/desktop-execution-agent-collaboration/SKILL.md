# Desktop execution agent collaboration

## Kdy použít

Použij, když Buddy, Steward nebo jiný autonomní AI kolega
zadává, přebírá nebo kontroluje práci ve viditelném **Claude Desktop App** nebo
**Codex Desktop App** threadu.

Typické situace:

- člověk předá rozpracovaný Claude/Codex thread a chce, aby agent pokračoval;
- Desktop agent má udělat maximum implementační práce, ale delegující kolega
  zůstává finální QA gate;
- vznikne PR stack, který potřebuje živé GitHub ověření, Steward AI kolega
  review a rozhodnutí, co je net-new vs. superseded;
- je potřeba vrátit úzký review feedback zpět do stejného viditelného threadu,
  ne potichu dokončit práci mimo něj.

Nepoužívej tento skill pro skryté CLI běhy typu `claude -p`, `codex exec`, tmux
nebo background shell jako náhradu Desktop threadu. CLI a shell slouží pro
source-of-truth ověření, testy, Git/GitHub inspekci a QA, ne jako neviditelná
primární delegace.

## Postup

1. **Najdi přesný Desktop thread.** Ověř název, workspace/cwd, poslední prompt,
   poslední handoff, branch, PR URL a případné stop conditions. Lokální
   transcripty a metadata jsou pomůcka; auditní stopa zadání zůstává ve
   viditelném Desktop chatu.
2. **Ověř live realitu před rozhodnutím.** Mimo self-report zkontroluj disk,
   Git, GitHub PR state, `origin/main`, checks, unresolved review threads,
   task ledgery a relevantní testy. Pokud se main mezitím posunul, nejdřív
   rozděl stav na `already-on-main`, `net-new`, `stale`, `superseded`.
3. **Pošli konverzační rozhodnutí zpět agentovi.** Mluv jako delegující kolega:
   co už je potvrzené, jaké je rozhodnutí, co se nesmí dělat, kde jsou zdroje
   pravdy, jaké validace očekáváš a kdy má agent zastavit. Pro dlouhý kontext
   použij file-backed prompt, ale krátký odkaz musí být viditelně ve threadu.
4. **Nech Desktop agenta udělat maximum práce.** Buddy nepřebírá
   implementaci jen proto, že umí spustit shell rychleji. Drží směr, scope,
   rozhodnutí a QA; Desktop agent implementuje, opravuje, připravuje PR a může
   volat subagenty, pokud to zlepší kvalitu.
5. **Po handoffu proveď QA counterweight.** Ověř diff, testy, build/lint/smoke,
   PR head SHA, merge state, review requests, unresolved threads, bot body
   findings a podle rizika spusť read-only auto-review druhým modelem/agentem.
6. **Vrať úzký feedback do stejného threadu.** Když QA najde blocker, napiš
   Desktop agentovi přesný nález, očekávanou opravu, validace a stop conditions.
   Nefixuj automaticky mimo thread, pokud nejde o malou emergency opravu, kterou
   explicitně převezmeš jako integrátor.
7. **Reviewer routing až po sanity.** Steward AI kolega dostane
   jen net-new reviewable diff. Superseded/stale PR se zavírá s důkazy místo
   review noise.
8. **Closeout pro člověka.** Reportuj, který Desktop thread byl použit, co agent
   udělal, co delegující kolega nezávisle ověřil, jaké PR/commity vznikly, co
   čeká na review a jaké poučení se má přenést do skillu/knowledgebase.

## Superseded PR cleanup

Když Desktop agent zjistí, že paralelní práce mezitím přistála na `main`:

1. Porovnej PR branch proti aktuálnímu `origin/main` přes tree diff, patch-id,
   main-only commity a konkrétní changed files.
2. Neprováděj rebase/push naslepo. Nejdřív klasifikuj:
   - `redundant` — obsah je už na main;
   - `stale-dangerous` — branch by revertoval unrelated main práci;
   - `net-new-delta` — jediný skutečný zbytek, často task ledger nebo evidence.
3. Zachovej `net-new-delta` jako samostatný úzký PR proti aktuálnímu mainu.
4. Zavři redundantní/stale PR s komentářem: co ho nahradilo, jaký diff důkaz byl
   ověřený, jestli se branch nesmí mergnout a proč není určený k review.
5. Reviewer requesty nech jen na novém net-new PR. Neposílej stewarda reviewovat
   stale branch.

## Ověření

Minimální ověření před tím, než práci označíš za hotovou:

- Desktop thread obsahuje viditelné zadání nebo file-backed odkaz na prompt.
- Aktuální Git/GitHub stav byl ověřen mimo Desktop self-report.
- U PR je známé: URL, head SHA, base, state, merge state, checks, review
  requests, unresolved review threads a changed files.
- Spuštěné testy/build/lint/smoke odpovídají riziku změny; pokud nejdou spustit,
  je popsán důvod a nejbližší náhradní důkaz.
- QA feedback se vrátil do stejného Desktop threadu a není jen v soukromém
  chatu integrátora.
- Review steward dostává jen net-new reviewable diff.
- Handoff uvádí, co je hotové, co čeká, kdo má další akci a kde je source of
  truth.

## Anti-patterny

- Desktop agent udělá práci, ale Buddy ji zopakuje/skrytě přepíše mimo thread.
- Self-report „tests passed" se přepošle člověku bez nezávislé validace.
- Steward AI kolega dostane stale nebo redundantní PR jen proto, že už byl
  requested.
- Source-of-truth konflikt se řeší push/rebase pokusem místo mapování mainu.
- Dlouhý prompt se uloží do souboru, ale ve viditelném Desktop threadu není
  krátká auditní zpráva s cestou k souboru.
- QA nálezy zůstanou jen v lokálním review a nedostanou se zpět k agentovi,
  který má práci opravit.
