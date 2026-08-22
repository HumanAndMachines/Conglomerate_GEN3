# Recovery runbook — návrh, neaktivní

1. Ověřit přesnou pack, policy, model, prompt a tool verzi.
2. Ověřit principal, boundary, cutoff a source snapshot checksumy.
3. Resume je povolen jen z posledního ověřeného checkpointu; změna kterékoliv autority vytvoří novou revizi runu.
4. Auth/access denied, schema mismatch a policy denial se neretryují.
5. Tranzientní read chyba: nejvýše dva retry s backoff 2 s a 8 s + jitter.
6. Ztráta heartbeat na 90 s nebo deadline 900 s → checkpoint a `PARTIAL/FAILED`.
7. Před návratem do pilotu spustit kompletní offline regresi.
