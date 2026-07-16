# Templates

Tady jsou doplňkové šablony dostupné HumanAndMachine GEN3 / Conglomerate rootu.

Šablony patří pod `templates/` nebo do samostatného template repozitáře, ne jako submodule ani checkout pod `organizations/`. `organizations/` je vyhrazené pro lokální gitignored Organization repo mounty konkrétních klientů/firem a v root repu smí trackovat jen `organizations/README.md`.

Default `launchpad.gen3.json` deklaruje required first-client template mounty:

- `OrganizationTemplate_GEN3` — fork-style upstream pro každou novou Organizaci GEN3; mount žije v `organizations/OrganizationTemplate_GEN3` (decision 0077), tady zůstávají jen modulové templaty.
- `templates/TemplatesRozjedeme-ai/MissionControlTemplate` — fork-style upstream pro klientský Mission Control app/code a repository-db install contract.
- `templates/TemplatesRozjedeme-ai/KnowledgebaseTemplate` — fork-style upstream pro klientský Git-native knowledgebase modul.

Tyto mounty jsou lokální git checkouty pod `templates/`; Doctor je kontroluje jako Git repozitáře. `CompanyTemplate` je legacy GEN2 šablona a není správný výchozí bod pro novou GEN3 Organizaci.
