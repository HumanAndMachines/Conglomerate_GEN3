# Lazurio vendor snapshot

Launchpad načítá tyto soubory jako runtime kopii kanonického design systému
`Rozjedeme-ai/design-system-lazurio`:

- `tokens.css`
- `components.css`

Snapshot vychází z commitu `f0a5694384a34a67e9b8a448cc022a0e8781833b`.
Při aktualizaci se oba soubory kopírují společně a následně se spouští
`bun run check` v repozitáři Launchpadu. Lokální úpravy vendor souborů nejsou
zdrojem pravdy; změna nejdřív patří do design systému Lazurio.
