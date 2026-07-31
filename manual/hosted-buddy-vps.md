# Hostovaný Buddy na VPS — co o něm musí vědět agent v rootu

> **Pro koho to je.** Worker Agent (Codex, Claude Code, Cursor…), kterého
> Principál pustil z rootu Conglomerate_GEN3 na svém počítači. Tenhle dokument
> odpovídá na dvě otázky: *má můj Principál hostovaného Buddyho?* a *co platí,
> když se práce dotkne jeho VPS?*
>
> **Co to není.** Instalační ani provozní manuál Buddyho. Ten žije jinde —
> viz [Na VPS platí jiná pravidla](#na-vps-platí-jiná-pravidla-než-v-tomhle-rootu).

## Proč o tom root vůbec mluví

Personalspace může existovat bez Buddyho a většina jich tak začíná. Když si ale
Principál Buddyho onboarduje, vznikne mu druhé místo, kde jeho osobní vrstva
žije: **dedikovaná per-owner VPS** (decision 0080, VPS-only Buddy). Lokální
mount `personalspace/<owner>_GEN3/buddy/` drží jen Git konfiguraci profilu —
**runtime tam není a nikdy nebude** (`local_execution: forbidden`).

Z toho plyne past, kvůli které tenhle dokument vznikl: agent na lokále vidí
složku `buddy/`, přečte si konfiguraci a začne se k ní chovat jako k něčemu, co
může lokálně spustit, opravit nebo přenastavit. Nemůže. Ta konfigurace popisuje
běh, který se odehrává jinde, pod jinými pravidly a s jiným credential setem.

## Jak zjistíš, jestli tvůj Principál Buddyho má

**Deklarace není důkaz.** `personal.gen3.json` může Buddyho binding deklarovat
a přesto k němu Principál dnes přístup mít nemusí — a naopak, kohortové
instalace běží mimo self-service lane a v manifestu je nemusí být vidět vůbec.
Stejná logika jako u přístupů obecně: **scope se prokazuje operací, ne
přečtením konfigurace.**

Postupuj odshora a zastav se na prvním kroku, který dá odpověď:

1. **Zeptej se Principála.** U hostovaného Buddyho je to jednořádková otázka
   a je to nejlevnější a nejspolehlivější zdroj. Vlastní jméno Buddyho
   (Principálové jim jména dávají) je dobrý signál, že instalace proběhla.
2. **Manifest jako indicii.** `personalspace/<owner>_GEN3/personal.gen3.json` —
   pokud nese Buddy binding, ber to jako *pravděpodobné ano, ověř operací*.
   Pokud ho nenese, **neuzavírej z toho „ne"**.
3. **Dosažitelnost hostu.** Hostované Buddy hosty se zpřístupňují přes privátní
   síť Principála, ne veřejným portem. Pokud používá Tailscale, `tailscale
   status` vypíše i nody sdílené do jeho tailnetu — hostitelský node Buddyho
   bude mezi nimi. Existence nodu prokazuje **síťovou** dosažitelnost, nic víc.
4. **Skutečný přístup.** Ten prokazuje jedině operace: přihlášení do chatového
   rozhraní Buddyho, nebo SSH na host. Tady končí to, co smí agent dělat sám —
   viz hranice níž.

**Fail-closed:** dokud nemáš důkaz, pracuj s odpovědí „nemá". Nikdy nezakládej
plán, report ani slib na domněnce, že Buddy existuje a je dosažitelný.

## Co s tím smíš dělat ty

| | |
|---|---|
| **Smíš** | zjistit, jestli Buddy existuje; přečíst lokální mount `buddy/` jako konfiguraci; odkázat Principála na jeho Buddyho; připravit mu podklad, který si na VPS odnese sám |
| **Nesmíš** | přihlašovat se za Principála do jeho chatu s Buddym; číst obsah Buddyho paměti a vynášet ho do sdílených výstupů; spouštět Buddy runtime lokálně; měnit stav VPS podle pravidel tohohle rootu |

Přístup na VPS je **Principálův**, ne tvůj — i když ti jeho počítač technicky
dovolí ho použít. Když je pro úkol potřeba, řekni si o něj nahlas a nech
Principála rozhodnout; mlčky použitý cizí přístup je porušení hranice, i když
skončí správným výsledkem.

**Paměť Buddyho je personalspace.** Platí pro ni celá security hranice
personalspace: nesmí se objevit ve sdílených výstupech, org discovery,
reportech ani šablonách — bez ohledu na to, jak užitečný ten obsah pro aktuální
úkol vypadá.

## Na VPS platí jiná pravidla než v tomhle rootu

**Tohle je to hlavní, co si z dokumentu odnes.** Jakmile se práce přesune na
host Buddyho, pravidla Conglomerate rootu **končí** a platí instrukce
kohortového repa **`HumanAndMachines/Buddy_GEN2`**. Není to doporučení ani
paralelní zdroj pravdy: root o vnitřku hostu nic neví a jeho pravidla tam
nejsou ověřená.

V Buddy_GEN2 najdeš `ARCHITECTURE.md` jako dokument č. 1 (co Buddy je a z čeho
se skládá), instalační manuál a provozní dokumentaci hostu. Repo je privátní —
pokud k němu přístup nemáš, **nedomýšlej si obsah z tohohle rootu**; řekni
Principálovi, že na pokračování potřebuješ přístup.

Praktický důsledek pro tvoje rozhodování:

- úkol o **lokálním** mountu, manifestu nebo Git konfiguraci → root, tenhle
  dokument a `personalspace/README.md`;
- úkol o **běhu Buddyho** — instalace, runtime, paměť, bridge, model,
  zálohy, incidenty → Buddy_GEN2, a čti ho **dřív**, než se hostu dotkneš;
- úkol, kde si nejsi jistý, na které straně hranice leží → zeptej se
  Principála. Odhad je tu dražší než dotaz: špatná změna na hostu se
  projeví na tom, jak Buddy jedná jménem svého Principála.

## Vztah k self-service onboardingu

Založení personalspace pokrývá [`create-personalspace.md`](create-personalspace.md).
**Buddy část toho flow je PENDING `CAC-0072`** — root parser `--with-buddy`
dnes odmítá jako neznámý argument a hosted handoff nevytváří.

To ale **neznamená, že hostovaní Buddyové neexistují.** GEN2 kohorta běží mimo
tuhle lane: hosty se instalují ručně podle Buddy_GEN2 a jejich Principálové
k nim přístup mají. Když tvůj Principál mluví o svém Buddym a self-service lane
je zavřená, není to rozpor — jen jsi narazil na kohortovou instalaci.

---

*Vzniklo z provozu první GEN2 kohorty (2026-07/08): agenti v rootu neměli jak
zjistit, že hostovaný Buddy existuje, a neměli kam být odkázáni, když na něj
narazili.*
