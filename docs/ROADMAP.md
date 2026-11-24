# Veikart: OpenHermes OS

Status 24.11.2026. Forslag, ikke vedtak; **ingenting av fase 1c–4 er bygget**. Grunnlaget (hva som mangler og hvor i koden) står i [PORTING.md](./PORTING.md); koder som C9, P5 osv. peker dit. Hermes-stier er relative til `~/.hermes/hermes-agent` (0.23.2). «Str.» er vurdering (S < 1 dag, M 1–3, L > 3).

## Rekkefølge i korte trekk

| Fase | Innhold | Hvorfor først/sist | Rører `~/.hermes`? |
|---|---|---|---|
| **1c** | Chat som faktisk er brukbar: OpenUI-prompt (seed), clarify, godkjenning, modell, slash, profil `openhermes` | Billig, ingen Hermes-endring, og uten clarify henger agenten | Nei |
| **2** | **Apps og varsler som Hermes-plugin** (lager, verktøy, REST, skill, prompt-hook) | Kjernen i OpenClaw OS; alt annet i UI-et er «chat med pent skall» uten den | Ja (installere plugin) |
| **3** | Same-origin hosting som dashboard-plugin (fjerner bridgen) | Trenger plugin fra fase 2 som bærer, og prod-hosting er verdiløs før fase 2 virker | Ja |
| **4** | Cron-visning, opplasting, opprydding, herding | Avhengig av 2–3; lavere verdi enn kjernen | Nei/ja (se tabell) |

Hver installasjon i `~/.hermes` krever Oles uttrykkelige ja per tilfelle (reglene for denne forken: ingen endring i `~/.hermes`, ingen omstart av gateway/dashboard uten avtale). Plugin-endringer på dashboard-siden krever trolig omstart av dashboardet (vurdering; ikke sjekket) — skrives da på kortet og stoppes.

---

## Fase 1c: gjør chatten brukbar (ingen plugin, ingen Hermes-endring)

### 1c-1 OpenUI-prompten som skjult seed-rad (P1)
- **Valg:** `HermesEngine` legger `prompts/openui-inline-ui.md` (generert av `claw-plugin/generate-prompt.ts`) inn som `session.create {messages:[{role:"system", display_kind:"hidden", …}]}` for økter UI-et selv oppretter.
- **Begrunnelse:** Testet i fase 1 (HERMES.md Q2: hidden `system`-rad ga effekt; kode `tui_gateway/session_history.py:376-390`). Krever ingen plugin og gir generativt UI i chatten med én gang. Inline-prompten trenger ikke app-verktøyene.
- **Forkastet:** (a) `surface: "openhermes-os"` som bryter — Hermes kaster verdien (`methods_prompt.py:887`, `gateway/session_surface.py:13`). (b) `pre_llm_call` nå — krever plugin; utsettes til fase 2 (se 2-6). (c) ephemeral system prompt via `personality` — krever endring i `config.yaml`.
- **Risiko:** seed teller mot kontekst og følger transkriptet; fremmede økter får den ikke. **Str.** S–M.

### 1c-2 Clarify (C9)
- **Valg:** Handle `clarify`-requesten fra Hermes (`tui_gateway/server.py:990`) i engine, vis spørsmålskort, svar per qid med `clarify.lock` (`methods_prompt.py:1296`).
- **Begrunnelse:** I dag ignoreres requesten og agenten venter 300 s. Det er en reell feil, ikke en nice-to-have.
- **Forkastet:** å bare slå av clarify-verktøyet i profilen — skjuler problemet og ligger i `~/.hermes`. **Str.** M.

### 1c-3 Godkjenningskort (C8)
- **Valg:** Knapper (`once/session/deny`) som kaller eksisterende `respondApproval` (`HermesEngine.ts:493` → `approval.respond`, `methods_prompt.py:1354`).
- **Begrunnelse:** Koden er skrevet, bare UI mangler; test mot en profil med `approval_mode` på.
- **Forkastet:** auto-godkjenn i UI — sikkerhetsbrudd. **Str.** M.

### 1c-4 Modellvelger og slash-kommandoer (C4, C6, C7)
- **Valg:** `model.options` for listen (`methods_complete.py:320`), `config.set` for valg (`methods_config_set.py:589`), `commands.catalog` (`methods_tools.py:433`) + `slash.exec` (`:1030`) for kommandoer.
- **Begrunnelse:** Alle er WS-metoder Hermes' egne klienter bruker; ingen ny backend.
- **Forkastet:** egen modellliste i klienten — går ut av sync med Hermes. **Str.** M + M.

### 1c-5 Profil: UI-et kjører i profilen `openhermes` (C12)
- **Valg:** `session.create {profile:"openhermes"}` (`methods_session.py:329`: `profile` leses og binder `HERMES_HOME`), og profilen vises i stedet for «agent». Profilen finnes allerede (`~/.hermes/profiles/openhermes`; sjekket 24.11.2026, ikke åpnet).
- **Begrunnelse:** Isolerer UI-ets økter, modell og (i fase 2) plugin-data fra Oles øvrige profiler. Profilvelger kan komme senere (`GET /api/profiles`, `profiles.py:742`).
- **Forkastet:** launch-profilen (`default`) — blander UI-økter med Oles daglige agent, og `plugin_db` følger aktiv profil. **Åpent:** hvilken profil dashboard-REST-kall (`/api/plugins/…`) lander i; `plugin_db` «følger aktiv profil» (`plugin_storage.py:36`) men om `?profile=` støttes på plugin-ruter er ikke sjekket (**vurdering**: les `web_server_dashboard.py:1159-1200` før fase 2). **Str.** S–M.

### 1c-6 Opprydding (C14, C16)
- **Valg:** Skriv om OpenClaw-tekster i innstillinger (`SettingsDialog.tsx:254,295`) og fjern `lib/gateway/*`/`engines/openclaw/*` **sist** i fase 1c. **Begrunnelse:** forvirrende UI-tekst nå; død kode koster diff-støy, men den lar oss sammenligne med upstream til porteringen er ferdig. **Str.** S.

---

## Fase 2: apps og varsler som Hermes-plugin

**Mål:** apps, artefakter og varsler lagres varig og vises i UI-et, laget av agenten via verktøy; samme brukeropplevelse som OpenClaw OS. Bygg ikke før fase 1c-1 og Oles ja til plugin-installasjon.

### 2-1 Pluginskjelett (P12)
- **Valg:** Ny mappe `packages/hermes-plugin/` i denne repoen (`plugin.yaml`, `__init__.py` med `register(ctx)`, `dashboard/manifest.json` + `dashboard/plugin_api.py`); installeres ved symlink/kopi til `~/.hermes/plugins/openhermes-os`. Mønster: `~/.hermes/plugins/hermes-genui` (`plugin.yaml` med `provides_tools`/`provides_hooks`; `dashboard/manifest.json` med `"api": "plugin_api.py"`; ruter under `/api/plugins/<name>/…`). Validér med `hermes plugins validate`/`doctor` (dokumentert i `website/docs/developer-guide/plugins/index.md`).
- **Begrunnelse:** Hermes-regelen «plugins never touch core» (`plugins/AGENTS.md`); samme form som eksisterende plugins gir minst overraskelser. Egen mappe endrer ingen eksisterende pakkemapper.
- **Forkastet:** (a) separat repo — mister diff mot klienten og gjør felles versjonering vanskelig; kan trekkes ut senere. (b) patch i Hermes-kjernen — forbudt og ikke vedlikeholdbart. (c) MCP-server i stedet for plugin — gir verktøy, men ikke dashboard-ruter, hook eller skill (`mcp_servers` i config). **Str.** S.

### 2-2 Lager: SQLite via `plugin_db`
- **Valg:** Tabeller `apps`, `app_versions`, `artifacts`, `notifications` i `plugin_db("openhermes-os")` (`plugins/plugin_storage.py:36`); porter semantikken fra `app-store.ts` (versjoner, restore), `artifact-store.ts`, `notification-store.ts` (dedupeKey, trim).
- **Begrunnelse:** Overlever `hermes plugins update`, følger profil. Én DB-fil gir transaksjoner (upstream bruker JSON-fil per app, som ikke tåler samtidige skriv).
- **Forkastet:** JSON-filer som upstream — ingen transaksjoner, og vi trenger spørringer (liste/søk/versjoner). `$HERMES_HOME/…` direkte — omgår plugin-datakatalogen. **Str.** M.

### 2-3 Agent-verktøy: `app_create/get/update`, `*_artifact`, `db_query/db_execute`, `notify` (P4, P5, P7, P9)
- **Valg:** `ctx.register_tool(...)` (`plugins_context.py:272`) i et eget toolset `openhermes-os`. `db_query/db_execute` portes til Python `sqlite3` med samme read-only-regel. Lint: kjør eksisterende `lint-openui.ts` som Node-subprosess (`app_create` returnerer funn som i upstream).
- **Begrunnelse:** Samme verktøyoverflate som skillen beskriver, så `SKILL.md` trenger minst mulig omskriving. Lint er 554 linjer logikk (`src/lint-openui.ts`) som er dyr å omskrive og enkel å kalle (vurdering).
- **Forkastet:** omskrive lint til Python nå — risiko for avvik fra rendereren; vurderes når Node-avhengigheten blir et problem. **Str.** L (dominerende post i fasen).

### 2-4 REST-ruter for klienten (`plugin_api.py`)
- **Valg:** `GET/DELETE /api/plugins/openhermes-os/apps|artifacts`, `GET …/apps/{id}/versions`, `POST …/restore`, `GET/POST …/notifications`, `…/read`. `HermesEngine.apps/artifacts/notifications` kaller dem med `fetch`. Dev: via bridgens `/hermes/api/*`-passthrough (finnes, HERMES.md); prod: same-origin (fase 3).
- **Begrunnelse:** Nettleseren kan ikke kalle plugin-funksjoner over WS (ingen generisk metode-registrering i gatewayen funnet; `@method` er internt i `tui_gateway`). Dashboard-plugin-API er den dokumenterte veien (`web_server_dashboard.py:611-629,1063`).
- **Forkastet:** egne JSON-RPC-metoder på `/api/ws` — krever endring i Hermes. Egen port/prosess — ny angrepsflate og egen auth. **Str.** M.

### 2-5 Skill `openui-app` som Hermes-skill (P2)
- **Valg:** Kopier `claw-plugin/skills/openui-app/SKILL.md` til pluginen, registrér med `register_skill` (`plugins_content.py:32`), bytt `~/.openclaw/workspace/…` og verktøynavn. Behold Thesys' MIT-notis øverst.
- **Begrunnelse:** 1 101 linjer verdifull komponentdokumentasjon; skill lastes på forespørsel, som upstream-designet vil (stor og trengs bare ved apps).
- **Forkastet:** legge hele skillen i systemprompten — sprenger konteksten på hver tur (upstream skilte av samme grunn, `claw-plugin/README.md:24`). **Str.** M.

### 2-6 Prompt-injeksjon og gate (P1, P3)
- **Valg:** `pre_llm_call`-hook (`plugins_dispatch.py:278-283`) som legger OpenUI-konteksten på for økter som kommer fra UI-et — **avgrenset med markør** (profil `openhermes` eller skjult seed-tag), siden `surface` ikke virker. `pre_tool_call`-gate som blokkerer `app_create/app_update` til skillen er lest, tilstand i plugin-DB.
- **Begrunnelse:** Seed (1c-1) dekker bare økter UI-et oppretter; hook dekker også gjenopptatte økter (Telegram/Desktop) om ønskelig. Gaten løste et reelt problem upstream (modellen kalte `app_create` uten å lese skillen).
- **Forkastet:** hook for alle økter — ville gjort OpenUI-prompten til støy i Telegram. Dropp gaten — vurderes igjen etter måling; billig å beholde. **Str.** M.

### 2-7 `tools.invoke` fra apper (P8) — **trenger Oles beslutning**
- **Valg (forslag):** Rute `POST …/tools/<name>` med **hvitliste**: `db_query`, `db_execute` (kun app-DB). `exec`/`read` er av som standard; kan slås på per app etter eksplisitt bekreftelse.
- **Begrunnelse:** Upstream lar en generert app kjøre vilkårlig shell (`index.ts:1226-1262`) uten LLM i løkken. På Oles maskin (Hermes-profil med full verktøytilgang) er det en fjernkjøring-flate for alt agenten kan generere. Hvitliste gir mest verdi (apper med lagret tilstand) for minst risiko.
- **Forkastet:** full paritet med upstream (exec/read) — for farlig uten sandkasse. Dropp `tools.invoke` helt — apper uten Query/Mutation mister det som gjør dem til apper. **Åpent for Ole:** skal `exec` finnes i det hele tatt (f.eks. for cron-drevne dashboards)? **Str.** M.

### Fase 2 ferdig når
Agenten (profil `openhermes`) kan lage en app med SQLite-tilstand, UI-et lister og åpner den etter reload, `restore` virker, et varsel kan opprettes og markeres lest. Bevis: kjørt mot ekte Hermes, skjermbilde + REST-respons, som i fase 1.

---

## Fase 3: same-origin hosting som dashboard-plugin (C13)

- **Valg:** Samme plugin som i fase 2 får `dashboard/` med statisk eksport av klienten, servert på `/dashboard-plugins/openhermes-os/index.html` (`dashboard_ui.py:408-445`). Fjern **all klientnavigasjon** (dropp `/setup`-ruten, `src/app/setup/page.tsx`, bruk dialog; ingen `next/link`/`router.push`) slik at ingen RSC-`.txt` hentes. Sett `basePath/assetPrefix` til `/dashboard-plugins/openhermes-os`. Nettleseren bruker dashboardets sesjonscookie; bridgen trengs ikke i prod.
- **Begrunnelse:** `.txt` er ikke i suffiks-allowlisten (`dashboard_ui.py:392-397`) og katalog-index finnes ikke (`:439`), men en enkeltside-eksport henter aldri `.txt` uten navigasjon (**vurdering**, Next-oppførsel må bevises med bygg + nettlesertest). Enkleste vei som ikke rører Hermes-kjernen.
- **Forkastet:** (a) post-build-omdøping `.txt` → `.json` + patch av Next-runtime — skjør mot Next-oppdateringer. (b) Skrive om klienten til Vite-SPA — stor omskriving uten behov hvis (vurdering) enkeltside holder. (c) Dashboard-fane via `entry: dist/index.js` — injiserer skript i dashboardets egen React-app; kobling til deres versjoner. (d) Utvide allowlisten i Hermes — endring i kjernen (og upstream-PR er forbudt her). (e) Egen reverse proxy — mer infrastruktur, egen auth.
- **Åpent:** cookie + WS-ticket flyten fra siden (`POST /api/auth/ws-ticket`, `dashboard_auth/routes.py:583`) er lest, ikke kjørt. Første deloppgave er en 30-minutters proof of concept. **Str.** M.

---

## Fase 4: cron, opplasting, herding

### 4-1 Cron-visning (C10, C11)
- **Valg:** `HermesEngine.listCronJobs/runs/…` mot REST `GET /api/cron/jobs`, `…/{id}/runs`, `PUT …/{id}` (`web_routers/cron.py:776-822`); form-mapper til `CronJobRecord`. Opprettelse av jobber skjer via agenten (Hermes' `cronjob`-verktøy, `tools/cronjob_tools.py:1283`) eller `POST /api/cron/jobs`. Cron-varsel: avled fra `…/runs` (som `useCronGateway.ts:18-64`) og skriv til fase 2-varsellageret.
- **Begrunnelse:** Hermes har fullverdig cron-REST; UI-et trenger kun adapter. Hermes' modell (`schedule`-streng, `repeat`, `deliver`, `skills`) er rikere enn OpenClaws — vis det ærlig, ikke tving inn i `CronJobRecord`.
- **Forkastet:** egen scheduler i pluginen — dobbelt opp med Hermes cron. **Str.** L.

### 4-2 Opplasting (P6)
- **Valg:** `POST /api/chat/file-upload` (`uploads.py:22`) + `image.attach`/`file.attach`; ingen plugin-lager. `uploads.list/get/delete` droppes eller holdes i klienten.
- **Begrunnelse:** Hermes eier allerede opplasting (0600-fil under profilens `uploads/`); å dublere lager gir ny angrepsflate.
- **Forkastet:** portere `upload-store.ts` — 282 linjer for noe Hermes allerede gjør. **Str.** M.

### 4-3 Historikk og kildemerking
- **Valg:** `session.history`/`session.events.since` for verktøyresultat og lange økter; merk tråder med kilde (Telegram/Desktop/cron/subagent) og skjul `cron`/`subagent` som standard (HERMES.md «Remaining work»). **Begrunnelse:** reell sesjonsliste har 77 cron + 54 subagent av 200 rader (HERMES.md, kjørt 24.11.2026). **Str.** M.

### 4-4 Pakkehygiene
- **Valg:** Fjern `claw-plugin` først når fase 2 er ferdig og verifisert; behold `@openuidev`-pakkenavnene til da. Vurder omdøping av pakker først da (oppdraget for 1b forbyr det nå). Oppdater NOTICE/LICENSE-hoder for hver portert fil (kilde + commit).

---

## Åpne spørsmål (trenger Ole)

| # | Spørsmål | Anbefaling |
|---|---|---|
| Q1 | Installere plugin `openhermes-os` i `~/.hermes/plugins`? (fase 2; trolig dashboard-omstart) | Ja, men som egen avtale på eget kort, med tilbakerulling (fjern mappen) |
| Q2 | Skal apper få `exec`/`read` via `tools.invoke`? | Nei (kun `db_*`), se 2-7 |
| Q3 | GitHub: slå på private sårbarhetsrapporter, issues og discussions på `Olewol/openhermes-os` (er av, sjekket 24.11.2026) | Slå på «private vulnerability reporting» så `SECURITY.md` virker |
| Q4 | Hvilken profil: `openhermes` (finnes) som fast, eller valgbar? | Fast `openhermes` i 1c, valgbar senere |
| Q5 | Skal fork-endringer noen gang tilbake til upstream (Thesys/OpenClaw)? | Nei inntil videre; ingen PR/issue (reglene for denne forken) |

## Hva som ikke er sjekket

- At en statisk Next-eksport uten navigasjon aldri henter `.txt` (fase 3) — **vurdering**.
- At `/api/plugins/<name>/…` velger riktig profil for `plugin_db` — **vurdering**, må leses/prøves før fase 2.
- At dashboard krever omstart for ny plugin — **vurdering**; `_plugin_api_hot_mount` (`web_server_dashboard.py:1168-1199`) tyder på at hot-mount finnes, ikke bekreftet.
- Størrelsene (S/M/L) er anslag, ikke målt.
