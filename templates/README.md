# Templates

Tady jsou doplňkové šablony dostupné HumanAndMachine GEN3 / Conglomerate rootu.

Modulové šablony patří pod `templates/` nebo do samostatného template
repozitáře. `organizations/` je vyhrazené pro lokální gitignored Organization
mounty konkrétních klientů/firem a v root repu smí trackovat jen
`organizations/README.md`; jedinou template výjimkou je pracovní checkout
Organization/Personalspace template uvnitř `productionspace/` zastřešující
Admin Organizace podle decision 0127. Nejde o root submodule ani druhý alias.

First-client rollout vyžaduje tyto čtyři přesné template checkouty:

- `OrganizationTemplate_GEN3` — template upstream pro každou novou Organizaci GEN3; pracovní checkout žije podle decision 0127 v `productionspace/` zastřešující Admin Organizace a runbook dostává jeho explicitní cestu. Tady zůstávají jen modulové templaty.
- `templates/TemplatesRozjedeme-ai/MissionControlTemplate` — GitHub Template repository upstream pro klientský Mission Control app/code a repository-db install contract.
- `templates/TemplatesRozjedeme-ai/KnowledgebaseTemplate` — fork-style upstream pro klientský Git-native knowledgebase modul.
- `templates/TemplatesRozjedeme-ai/DesignSystemTemplate` — GitHub Template repository upstream pro primární Organization root Design System; je provisioning input i pro klienta, jehož neobjednaný Design System zůstává pouze `planned_slot`.

Modulové template mounty jsou lokální Git checkouty pod `templates/`;
Organization template je explicitně předaný productionspace checkout Admin
Organizace. Povinnou přítomnost a Git stav přesných checkoutů ověřuje explicitní
preflight v `manual/first-client-organization-rollout.md`. Doctor discovery
nedrží hardcodovaný allowlist required template názvů. GitHub `is_template`
musí být `true` pro všechny čtyři upstreamy; Mission Control ani Design System
se nezakládají kopií souborů. `CompanyTemplate` je legacy GEN2 šablona a není
správný výchozí bod pro novou GEN3 Organizaci.
