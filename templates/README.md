# Templates

Tady jsou doplňkové šablony dostupné HumanAndMachine GEN3 / Conglomerate rootu.

Šablony patří pod `templates/` nebo do samostatného template repozitáře, ne jako submodule ani checkout pod `organizations/`. `organizations/` je vyhrazené pro lokální gitignored Organization repo mounty konkrétních klientů/firem a v root repu smí trackovat jen `organizations/README.md`.

First-client rollout vyžaduje tyto čtyři přesné template checkouty:

- `OrganizationTemplate_GEN3` — template upstream pro každou novou Organizaci GEN3; mount žije v `organizations/OrganizationTemplate_GEN3` (decision 0077), tady zůstávají jen modulové templaty.
- `templates/TemplatesRozjedeme-ai/MissionControlTemplate` — GitHub Template repository upstream pro klientský Mission Control app/code a repository-db install contract.
- `templates/TemplatesRozjedeme-ai/KnowledgebaseTemplate` — fork-style upstream pro klientský Git-native knowledgebase modul.
- `templates/TemplatesRozjedeme-ai/DesignSystemTemplate` — GitHub Template repository upstream pro primární Organization root Design System; je provisioning input i pro klienta, jehož neobjednaný Design System zůstává pouze `planned_slot`.

Modulové template mounty jsou lokální Git checkouty pod `templates/`; Organization template má výše popsaný marker mount pod `organizations/`. Povinnou přítomnost a Git stav přesných checkoutů ověřuje explicitní preflight v `manual/first-client-organization-rollout.md`. Doctor discovery pouze reportuje přítomné template mounty a nedrží hardcodovaný allowlist required template názvů. GitHub `is_template` musí být `true` pro všechny čtyři upstreamy; Mission Control ani Design System se nezakládají kopií souborů. `CompanyTemplate` je legacy GEN2 šablona a není správný výchozí bod pro novou GEN3 Organizaci.
