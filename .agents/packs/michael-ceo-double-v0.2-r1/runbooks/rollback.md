# Rollback runbook — návrh, neaktivní

1. Aktivovat kill switch přesné pack verze (budoucí runtime gate).
2. Zneplatnit její neověřené checkpointy.
3. Obnovit pouze explicitně schválený last-known-good pack/policy/router.
4. Znovu ověřit source permissions.
5. Spustit offline evaly včetně boundary, injection, finance lineage a failure injection.
6. Nový manuální shadow run vyžaduje samostatné přesné schválení.

V této verzi není co provozně rollbackovat: runtime, konektory, schedule i writes jsou vypnuté a nebyly vytvořeny.
