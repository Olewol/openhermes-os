# OpenHermes OS

> ## ⚠️ WIP — under arbeid, ikke klart til bruk (24.11.2026)
> Dette prosjektet er under aktiv utvikling og **kan ikke brukes i produksjon ennå**. Flere funksjoner (apps, artefakter, varsler, cron, opplasting, modellvelger, slash-kommandoer) er stubbet eller mangler. Status per metode: **[docs/HERMES.md](./docs/HERMES.md)**.

**Et generativt UI-arbeidsrom for [Hermes Agent](https://github.com/NousResearch/hermes-agent).** Agentens svar rendres som levende, interaktive komponenter (dashboards, tabeller, skjemaer, diagrammer) med [OpenUI](https://github.com/thesysdev/openui), og chatten går mot Hermes' egen gateway-protokoll: JSON-RPC over WebSocket (`/api/ws`).

OpenHermes OS er en **fork** av [thesysdev/openclaw-os](https://github.com/thesysdev/openclaw-os) (MIT) @ `076ae63`, som opprinnelig er laget for [OpenClaw](https://github.com/openclaw/openclaw). Hermes Agent er ikke endret; forken er bare et UI foran den. Se [Kreditering](#kreditering).

## Status (24.11.2026)

Fase 1 er ferdig: transporten er byttet fra OpenClaw-gatewayen til Hermes (`HermesEngine`). Det meste av chatten virker mot en ekte Hermes 0.23.2; resten er stubbet. Tabell per metode, verifiserte kjøringer og åpne spørsmål: **[docs/HERMES.md](./docs/HERMES.md)**.

| Virker | Stubbet / mangler |
|---|---|
| koble til, liste og åpne sesjoner, sende melding, strømming, resonnering, verktøykort, avbryt | apps, artefakter, varsler, cron, opplasting, `tools.invoke` |
| | modellvelger, slash-kommandoer, clarify-spørsmål, godkjenningskort (kode finnes, ikke kjørt) |
| | OpenUI Lang-prompten mot Hermes-sesjoner (ikke koblet på ennå) |

Hva som må portere fra OpenClaw til Hermes, med fil:linje-bevis: **[docs/PORTING.md](./docs/PORTING.md)**. Foreslått rekkefølge videre (fase 2 = apps og varsler som Hermes-plugin): **[docs/ROADMAP.md](./docs/ROADMAP.md)**.

## Slik virker det

```
Nettleser (Next dev :18790)
  └─ HermesEngine ──(JsonRpcGatewayClient, vendored fra Hermes)──▶ ws://127.0.0.1:18791/hermes/ws   (bridge)
                                                                    └─ innlogging + ws-ticket ─▶ ws://127.0.0.1:9119/api/ws  (Hermes-dashboardet)
```

I dev går nettleseren via en liten bridge (`packages/claw-client/scripts/hermes-bridge.mjs`) som logger inn på dashboardet og henter en WebSocket-ticket. Detaljer og hvorfor: [docs/HERMES.md](./docs/HERMES.md#setup).

## Kom i gang (dev)

Krever Node ≥ 20, pnpm og et kjørende Hermes-dashboard på `127.0.0.1:9119` med dashboard-innlogging.

```bash
pnpm install
cd packages/claw-client
export HERMES_DASH_USER=…  HERMES_DASH_PASSWORD=…   # holdes utenfor repoet
pnpm dev:hermes                                     # bridge :18791 + UI :18790
```

Miljøvariabler og alternativer: [docs/HERMES.md](./docs/HERMES.md#setup). Bidra: [CONTRIBUTING.md](./CONTRIBUTING.md).

## Pakker

| Pakke | Rolle i forken |
|---|---|
| [`packages/claw-client`](./packages/claw-client) (`@openuidev/claw-client`) | Selve UI-et (Next.js + OpenUI-renderer) og `HermesEngine`. **Aktiv.** |
| [`packages/claw-plugin`](./packages/claw-plugin) (`@openuidev/openclaw-os-plugin`) | OpenClaw-plugin fra upstream (apps/artefakter/varsler/opplasting, OpenUI-prompt). **Ikke i bruk mot Hermes**; skal portes til en Hermes-plugin i fase 2. Se [docs/PORTING.md](./docs/PORTING.md). |

Pakkemappene og pakkenavnene er beholdt fra upstream med vilje, slik at diffen mot upstream er lesbar. Ingen av pakkene publiseres fra denne forken (`@openuidev` er Thesys' npm-scope).

## Kreditering

OpenHermes OS bygger på andres åpne kildekode. Alt under er MIT-lisensiert; lisensene er sjekket mot kildene 24.11.2026 (se [NOTICE](./NOTICE) for fullstendig oversikt).

| Prosjekt | Hva vi bruker | Lisens | Kilde |
|---|---|---|---|
| **[Thesys](https://www.thesys.dev) / [OpenUI](https://github.com/thesysdev/openui)** | OpenUI Lang og React-rendereren (`@openuidev/react-lang`, `react-ui`, `react-headless`); OpenClaw OS selv er laget av Thesys Inc | MIT, © 2026 Thesys Inc ([openclaw-os](https://github.com/thesysdev/openclaw-os/blob/main/LICENSE)); © 2011–2024 Thesys Inc. ([openui](https://github.com/thesysdev/openui/blob/main/LICENSE)) | [thesysdev/openclaw-os](https://github.com/thesysdev/openclaw-os), [thesysdev/openui](https://github.com/thesysdev/openui) |
| **[OpenClaw](https://github.com/openclaw/openclaw)** | Gateway-protokollen og plugin-API-et som upstream er bygget mot; vi porterer *bort* fra den | MIT, © 2026 OpenClaw Foundation | [LICENSE](https://github.com/openclaw/openclaw/blob/main/LICENSE) |
| **[Hermes Agent](https://github.com/NousResearch/hermes-agent) / [Nous Research](https://nousresearch.com)** | Agenten og gateway-protokollen vi snakker med; to filer er kopiert inn og én er en slank erstatning (`packages/claw-client/src/lib/hermes/vendor/`) | MIT, © 2025 Nous Research | [LICENSE](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE), [docs](https://hermes-agent.nousresearch.com/docs) |

Forken er ikke tilknyttet, støttet eller godkjent av Thesys, OpenClaw eller Nous Research.

## Dokumentasjon

- [docs/HERMES.md](./docs/HERMES.md) — transport, oppsett, metodekart og verifiserte kjøringer
- [docs/PORTING.md](./docs/PORTING.md) — porteringskart per pakke
- [docs/ROADMAP.md](./docs/ROADMAP.md) — rekkefølge videre
- [docs/UPSTREAM.md](./docs/UPSTREAM.md) — upstream-README for OpenClaw OS (historisk, gjelder ikke denne forken)
- [AGENTS.md](./AGENTS.md) — arkitektur og begreper for kodeagenter
- [SECURITY.md](./SECURITY.md), [CONTRIBUTING.md](./CONTRIBUTING.md), [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)

## Lisens

[MIT](./LICENSE). Opprinnelig opphavsrett © 2026 Thesys Inc beholdes; endringer i forken © 2026 Ole ([Olewol](https://github.com/Olewol)). Tredjepartsoversikt: [NOTICE](./NOTICE).
