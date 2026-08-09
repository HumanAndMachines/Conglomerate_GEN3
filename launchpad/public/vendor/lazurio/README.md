# Lazurio vendor snapshot

Launchpad načítá tyto soubory jako runtime kopii kanonického design systému
`Rozjedeme-ai/design-system-lazurio`:

- `tokens.css`
- `components.css`

Snapshot vychází z commitu `f0a5694384a34a67e9b8a448cc022a0e8781833b`.
Při aktualizaci se oba soubory kopírují společně a následně se spouští
`bun run check` v repozitáři Launchpadu. Lokální úpravy vendor souborů nejsou
zdrojem pravdy; změna nejdřív patří do design systému Lazurio.

Ikonové exporty v `launchpad/public/` a kořenovém `assets/` pocházejí ze
stejného kanonického repozitáře, z commitu
`ed34efa929a599a22005f83ea2d6a514aec98445`:

- `favicon.svg` a `favicon.ico` jsou kanonické favicon exporty;
- `apple-touch-icon.png` je 180px platformní export kanonického
  `profile-light-1024.png` pro použití na světlé ploše;
- `assets/launchpad.svg` je kanonický `profile-light.svg`;
- `assets/launchpad.ico` je platformní balení kanonického
  `profile-light-1024.png` pro Windows zástupce na světlé ploše.

Ani ikonové kopie se neupravují ručně. Změna kresby patří nejdřív do
generátoru design systému Lazurio a potom se znovu vyexportuje celá sada.
