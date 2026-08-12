# Incident runbook — návrh, neaktivní

- **SEV-0:** cross-boundary leak nebo neautorizovaná mutace → okamžitě zastavit přesnou verzi packu, zneplatnit checkpointy, zachovat pouze audit metadata, žádný automatický resume.
- **SEV-1:** chybný finanční nebo CEO závěr → označit výstup invalidní, rollback na explicitně schválený last-known-good, root-cause a plná regrese.
- **SEV-2:** nedostupný zdroj/tool → circuit breaker, `PARTIAL/BLOCKED`, žádná domyšlená náhrada.

Incident owner je do delegace Michael Blažíček. Tento dokument nic nespouští a žádný connector nevypíná, protože žádný není aktivní.
