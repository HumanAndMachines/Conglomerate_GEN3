# Desktop execution agent collaboration

Tento manuálový záznam je součást základního balíku Konglomerátu. Popisuje,
jak mají Buddy a workspace-local AI kolegové spolupracovat s viditelnými
Claude/Codex Desktop App agenty.

**Kanonický domov postupu je skill**
`.agents/skills/desktop-execution-agent-collaboration/SKILL.md`. Tam je celá
standardní smyčka (najít správný Desktop thread → ověřit live source of truth
mimo self-report → poslat konverzační rozhodnutí → nechat agenta udělat maximum
práce → QA counterweight po handoffu → úzký feedback zpět do threadu → reviewer
routing → closeout), superseded PR cleanup, minimální ověření i anti-patterny.
Neduplikuj ten postup sem — tento manuál drží jen zařazení do onboardingu
a nepřekročitelné invarianty.

## Princip

Desktop execution agent není autonomní kolega ani finální autorita. Je to
viditelný exekuční parťák v konkrétním Desktop threadu. Autonomní kolega, který
práci delegoval, zůstává odpovědný za brief, ověření, reviewer routing a
closeout.

## Základní balík

Každý Buddy/AI kolega v Konglomerátu má mít tento pattern k dispozici při
onboardingu. Konkrétní profily mohou mít vlastní Claude/Codex skill, ale nesmí
porušit tyto invarianty:

- viditelný Desktop thread je auditní stopa delegace;
- shell/CLI je pro QA a source-of-truth ověření, ne skrytá náhrada práce;
- self-report není důkaz;
- reviewer dostává jen net-new reviewable diff;
- superseded PR se zavírá s důkazem, ne review requestem.
