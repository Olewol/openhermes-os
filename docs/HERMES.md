# OpenHermes OS: Hermes-native transport (fase 1)

OpenHermes OS is a fork of [thesysdev/openclaw-os](https://github.com/thesysdev/openclaw-os) @ `076ae63` (MIT).
The OpenClaw gateway transport is replaced by **Hermes Agent's own gateway protocol**: JSON-RPC over `/api/ws`,
using Hermes' browser client `JsonRpcGatewayClient`. Hermes is not modified; the fork is only a UI in front of it.
Tested against Hermes `v0.23.2+2.g776e489` (tree `776e4897fa`).

```
Browser (Next dev :18790)
  └─ HermesEngine  ──(JsonRpcGatewayClient, vendored)──▶ ws://127.0.0.1:18791/hermes/ws   (bridge)
                                                          └─ login + POST /api/auth/ws-ticket ─▶ ws://127.0.0.1:9119/api/ws?ticket=…  (Hermes dashboard)
```

## What changed

| Path | What |
|---|---|
| `packages/claw-client/src/lib/hermes/vendor/json-rpc-gateway.ts`, `json-rpc-channel.ts` | **Vendored** from `hermes-agent/apps/shared/src/` (MIT, © Nous Research; header names source file + tree). Only the import paths are rewritten. |
| `…/vendor/gateway-events.ts` | Slim stand-in for Hermes' 7.6k-line generated contract (only the shapes the client needs). Contract source: `apps/shared/src/gateway-contract.openrpc.json`. |
| `packages/claw-client/src/lib/engines/hermes/HermesEngine.ts` | **New adapter**. Same public surface as `OpenClawEngine` (so `useGateway`, `useCronGateway`, `useNotificationsGateway`, `ChatApp` change by import only). Maps OpenClaw RPCs to Hermes methods; turns Hermes events into the AG-UI NDJSON stream the UI already renders. |
| `packages/claw-client/scripts/hermes-bridge.mjs` | Dev bridge (Node, `ws`): logs in to the dashboard, mints a ticket per browser socket, pipes JSON-RPC frames unchanged. Also `/hermes/health` and a `/hermes/api/*` REST passthrough. |
| `useGateway.ts`, `session-routing.ts`, `ChatApp.tsx`, `ThreadArea.tsx`, hooks | Import `HermesEngine` instead of `OpenClawEngine`; settings dialog no longer forced open (default bridge URL). |
| `next.config.ts` | `allowedDevOrigins: ["127.0.0.1","localhost"]` (otherwise the dev HMR socket is blocked and the page never hydrates). |
| Branding | Title, sidebar logo and mobile shell say OpenHermes; README gets a fork banner. |

The old `src/lib/gateway/*` and `engines/openclaw/OpenClawEngine.ts` are left in place but no longer imported by the app
(`ConnectionState` from `gateway/types.ts` is still used). Remove them in a cleanup commit once nothing needs the diff.

## Setup

Requirements: Node 20+, pnpm, a running Hermes dashboard on `127.0.0.1:9119` with dashboard auth.

```bash
pnpm install
cd packages/claw-client

# 1) bridge (credentials stay in env, never in the repo)
export HERMES_DASH_USER=…            HERMES_DASH_PASSWORD=…
#   or: HERMES_DASH_USER_CMD="…"  HERMES_DASH_PASSWORD_CMD="…"   (commands that print the value, e.g. a vault helper)
pnpm bridge                          # → http://127.0.0.1:18791  (WS /hermes/ws)

# 2) UI
pnpm dev                             # → http://127.0.0.1:18790
# or both:  pnpm dev:hermes
```

Bridge env: `HERMES_DASH_URL` (default `http://127.0.0.1:9119`), `HERMES_DASH_PROVIDER` (default `basic`),
`HERMES_BRIDGE_HOST`/`HERMES_BRIDGE_PORT` (default `127.0.0.1`/`18791`), `HERMES_BRIDGE_ORIGINS` (extra allowed browser origins; any `localhost`/`127.0.0.1` port is always allowed).
Override the URL the browser uses via the settings dialog (`gatewayUrl`), default is `ws(s)://<page host>:18791/hermes/ws`.

### How the browser authenticates (verified in code and by running it)

1. `POST /auth/password-login` `{provider:"basic", username, password}` → session cookie (`hermes_cli/dashboard_auth/routes.py`).
2. `POST /api/auth/ws-ticket` with that cookie → `{ticket, ttl_seconds: 30}`, single use (`routes.py:583-595`, `_require_session` at `:544`).
3. `ws://…/api/ws?ticket=…` (the Hermes client's `buildWsAuthParam`, `web/src/lib/api.ts`).

### Why a bridge in dev

The WS upgrade checks the `Origin` against the bound host and **rejects a page on another port**
(`hermes_cli/web_server_boundary.py:251-285`, `origin_mismatch`; the comment at `:277-279` says exactly this). Next dev on `:18790`
is a different origin from `:9119`, so the browser cannot open `/api/ws` itself. The bridge does login + ticket server-side
(the `ws` client sends no `Origin`, which the guard accepts) and the browser only talks to the bridge. A Vite/Next rewrite proxy would
need the same cookie handling, so the bridge is the simpler dev path. In production see Q1 below: no bridge needed if the app is served from the dashboard itself.

## Method map and status

Status: **works** = exercised in the verified run; **code** = implemented, not exercised; **stub** = local no-op/empty; **missing** = no Hermes counterpart.

| OpenClaw OS call | Hermes native | Status |
|---|---|---|
| connect / hello-ok | WS open + event `gateway.ready` | **works** |
| `agents.list` | one synthetic agent `hermes` (Hermes has profiles, not agents) | **works** |
| `sessions.list` | `session.list` (all sources incl. telegram/gui/tui/cron/subagent) | **works** |
| `sessions.create` | `session.create` → `{session_id (live), stored_session_id}` | **works** |
| `sessions.delete` | `session.delete` (stored id) | code (not run: no session deletion allowed in the test) |
| `sessions.patch {label}` | `session.title` | code |
| `sessions.patch` model/thinking/verbose | none session-scoped wired | stub (returns ok) |
| `sessions.reset` | no in-place reset → `session.create` and rebind | code |
| `sessions.compact` | `session.compress` | code |
| `chat.send` | `prompt.submit` `{session_id, text}` → `status: streaming` | **works** |
| stream: `agent.assistant/thinking/tool`, `chat.final` | events `message.start/delta/interim/complete`, `reasoning.delta`, `tool.start/complete`, `error` → AG-UI | **works** (text, reasoning, tool call + result, usage) |
| `chat.abort` | `session.interrupt` | **works** |
| `chat.history` | `session.resume` → `messages[]` (+ binds live id) | **works** |
| approvals | event `approval.request` → surfaced as a tool card + `HermesEngine.respondApproval()` → `approval.respond` | code (default gateway runs `approval_mode: off`, so never triggered) |
| clarify questions | `clarify.*` / `request.answer` | **missing** (not mapped; the event is ignored) |
| `models.list` / `config.get` | model taken from `session.info` event | partial: shows the session's model, no picker |
| `commands.list` (slash autocomplete) | `commands.catalog`-style methods exist | stub (empty list) |
| `sessions.subscribe` / `sessions.changed` | Hermes pushes `sessions.changed` to every connection | partial (global event, no per-session key; history of a *viewed* thread is not auto-refreshed) |
| `cron.*` | REST `/api/cron/jobs` (not on the WS; `hermes_cli/web_routers/cron.py:776`) | stub (empty), via bridge `/hermes/api/*` later |
| `openclawos.apps.*` | none in Hermes | **stub** (empty list; no apps persisted) |
| `openclawos.artifacts.*` | none | **stub** |
| `openclawos.uploads.*` | Hermes has `image.attach` / `input.detect_drop` | **stub** |
| `openclawos.notifications.*` | none | **stub** |
| `tools.invoke` | none (tools are agent-side) | **stub** (throws "not available") |

Thread model: the OpenClaw "main thread per agent" is the synthetic thread `hermes`, bound to one stored session id kept in
`localStorage["openhermes.mainStoredSession"]` (created lazily on first send). Every other Hermes session is an "extra" thread with its stored id.
Live (per-WS) session ids and stored ids are tracked in `HermesEngine.liveByStored/storedByLive`; events are routed by live id.

History: Hermes returns `{role, text, reasoning, row_id}` rows, and tool rows with `name/context/args/tool_call_id` but **without the tool result text**.
`transcriptToStored` folds assistant + tool rows into one assistant bubble (reasoning → tool_call → tool_result placeholder → text).
Live runs show the real result (`tool.complete.result_text`); reloaded history shows `(context)` instead. A fuller history needs `session.history`/`session.events.since` (not done).

## Verified run (24.11.2026, against the default gateway, Hermes 0.23.2)

Environment: bridge (`:18791`) + `pnpm dev` (`:18790`), Chromium driven by script. All test messages start with `[openhermes-test]`; no sessions were deleted, nothing sent to Telegram, `~/.hermes` untouched, no service restarted.

| Check | Result |
|---|---|
| (a) connect with ticket | UI badge «Connected»; bridge log `dashboard login ok`; node probe: `gateway.ready` frame through the bridge |
| (b) list sessions | thread list filled with the real sessions (probe: 200 rows, sources `cron 77, subagent 54, local 38, gui 12, api_server 9, telegram 5, tui 3, acp 1, cli 1`) |
| (c) create + send + stream + render | main thread → `session.create` → message `[openhermes-test] Svar med kun ordet OK, ingen verktøy.` → reasoning panel, answer «OK», usage 174 978/25 tokens rendered |
| (c2) tool call | `[openhermes-test] Kjør \`echo openhermes-ok\`…` → tool card «terminal · Succeeded» with output `openhermes-ok`, «1 tool call», «Worked for 0.1s» |
| (d) abort | `[openhermes-test] Kjør \`sleep 120\`…` → `pgrep` showed the `sleep 120` process → UI «Stop» → `session.interrupt` → process gone within 6 s, UI back to idle (`docs/img/abort-stop.png`) |
| (e) open existing session | page reload → click an existing thread → `session.resume` → history rendered (`docs/img/history-reload.png`) |

Latency note: Hermes' model route (`auto`/manifest) took 25-100 s to the first token in these runs; not a transport issue (the bridge adds < 50 ms).

## Open questions (answers with sources; paths relative to `~/.hermes/hermes-agent`, Hermes 0.23.2)

### Q1. Can a Hermes dashboard plugin serve a whole static SPA on the same origin (ticket without a proxy in production)?

**Yes, with constraints. (Verified by code reading only; not tested, because installing a plugin would change `~/.hermes`.)**

- A plugin with `dashboard/manifest.json` is discovered in user/bundled(/project) plugin roots (`hermes_cli/web_server_dashboard.py:638-668`). Its `dashboard/` directory is served at `GET /dashboard-plugins/<name>/<path>` (`hermes_cli/web_routers/dashboard_ui.py:408-445`), **same origin as the dashboard** (`:9119`, or the Tailscale HTTPS host).
- That route is public by design (`dashboard_ui.py:412`, and `hermes_cli/dashboard_auth/middleware.py:50` puts `/dashboard-plugins/` in the gate's public prefixes), so the static files load without a session; the **API calls use the dashboard's session cookie**, which the browser sends because it is the same origin. Then `POST /api/auth/ws-ticket` (`dashboard_auth/routes.py:583`) and `/api/ws` work from the page with no bridge, and the WS `Origin` check passes (page host == bound host: `web_server_boundary.py:282-284`).
- Constraints that bite a Next static export:
  1. **Suffix allowlist** (`dashboard_ui.py:392-397`): `.js .mjs .css .json .html .svg .png .jpg .gif .webp .ico .woff2 .woff .ttf .otf .map`. Everything else is 404. Next's RSC payload files (`.txt`) are therefore blocked; export must avoid them (hash routing / single page / `output: "export"` without client navigations that fetch `.txt`).
  2. **No directory index**: `file_path` must be an existing file (`dashboard_ui.py:439`), so the entry URL is `/dashboard-plugins/<name>/index.html`, not `/…/<name>/`. Set `basePath`/`assetPrefix` to `/dashboard-plugins/<name>` (the fork already ships `basePath` for `/plugins/openclawos` in static mode, `next.config.ts`).
  3. The plugin must be consented/enabled (`_plugin_consent_withheld`, `dashboard_ui.py:425`), the user must be logged in to the dashboard first (otherwise the API calls 401).
  4. Responses carry `Cache-Control: no-store` (`dashboard_ui.py:445`): no browser caching of the bundle.
- Alternative for a first-class page: register as a dashboard **tab** (`manifest.json` `tab`, `entry: dist/index.js`, `web_server_dashboard.py:629-636`); that is a script injected into the dashboard SPA rather than a standalone SPA.
- Backend routes for apps/artifacts storage (phase 2) can ride the same plugin: `api` file → mounted under `/api/plugins/<name>/` (`web_server_dashboard.py:1083-1100`), authenticated by the same cookie.

### Q2. Can `prompt.submit` (or the session) get an extra system prompt for the OpenUI Lang prompt, or must it be a `pre_llm_call` hook?

**There is no system-prompt field on `prompt.submit`; but a client can inject hidden model-facing context at session creation, and a plugin hook covers existing sessions.**

- `prompt.submit` params (`apps/shared/src/gateway-contract.generated.ts:2860-2877`): `session_id, text, display_kind, surface, voice_context, title_preview, truncate_*…`. No `system`/`instructions` field. (`system_prompt` appears only in *results*/info, e.g. `:3519`, `:4871`.)
- **Works from the client, verified:** `session.create` accepts `messages` seed rows (`SessionCreateParams`, `generated.ts:3195-3201`; coercion in `tui_gateway/session_history.py:376-390`): roles `user|assistant|system`, and `display_kind: "hidden"` is the one kind a client may author, "model-facing scaffolding the renderer must not paint". Test run (`[openhermes-test] Si hei.` with a hidden `system` row «Start ALLTID svaret med ordet BANAN.») → reply `BANAN hei.`, session `20261124_154309_f3d6ef`. So the fork can put the OpenUI Lang prompt in a hidden seed row for every session **it creates**. Limit: sessions created elsewhere (Telegram/Desktop/TUI) do not have it; the seed is part of the transcript (counts toward context, survives compression only as history).
- Per-session ephemeral system prompt exists server-side (`tui_gateway/agent_callbacks.py:309-318`, `agent.ephemeral_system_prompt`), but is reachable only through the `personality` config setter (name must exist in `config.yaml` personalities), i.e. needs a `~/.hermes` change. Not usable from the client today.
- **Plugin route:** `pre_llm_call` may return `{"context": "..."}` (a string also works) to inject text before each model call, or `{"action":"block"}` (`hermes_cli/plugins_dispatch.py:278-283`; hook registry `hermes_cli/plugins.py:116`). Use it when the prompt must apply to all sessions or per turn, or when it must be switched on only for sessions with `surface: "openhermes-os"` (the engine already sends `surface` in `prompt.submit`). It cannot be done without installing a plugin (outside phase 1).
- Recommendation: start with the hidden seed (no Hermes change), move to `pre_llm_call` if the prompt has to follow resumed foreign sessions.

### Q3. How do Telegram and Desktop sessions look when opened in the fork, and can you keep writing in them?

- **Listing: yes, all of them.** `session.list` returns every source except `kanban`, `tool`, `oneshot` (`hermes_state_sessions.py:243`, filter at `tui_gateway/methods_session.py:132-133`). In the live run: `cron 77, subagent 54, local 38, gui 12, api_server 9, telegram 5, tui 3, acp 1, cli 1`. Each row has `source`; the fork currently shows them in one flat list and does not label the source (small follow-up).
- **Opening/history: verified.** `session.resume` on a Telegram session returned its full transcript (user/assistant/tool rows, reasoning in `reasoning`), rendered in the thread view; tool results are not in the replay (see History above). Kanban-worker sessions are refused on purpose (`methods_session.py:846-848`, error 4132).
- **Writing on: possible by the protocol, not exercised.** `session.resume` returns a normal live session and `prompt.submit` appends to the stored session in state.db, with no per-source guard in `session.resume`/`_resume_guard` (`methods_session.py:836-860`). I did **not** send into a real Telegram session (it would pollute Ole's chat history; the rules forbid touching Telegram). Expected: the turn runs through the dashboard's agent and is stored in that session; **nothing is delivered to Telegram** because delivery belongs to the Telegram adapter process, so the user would see the answer only in OpenHermes OS/Desktop (and the Telegram agent sees it as history on its next message). Needs one deliberate test on a throw-away Telegram session before relying on it. Concurrency risk: if the same session is running in another process, `_reattach_refusal` (`methods_session.py:873`) decides.
- Desktop (`gui`) and TUI sessions are the same kind of stored session; they resume the same way.

## Remaining work (not done in phase 1)

- Persist apps / artifacts / notifications / uploads (needs a plugin API or a store in Hermes; all stubs today). `tools.invoke` has no counterpart.
- Production hosting as a dashboard plugin (Q1): static export without `.txt` payloads, base path, entry `index.html`.
- OpenUI Lang prompt injection (Q2): hidden seed at `session.create`, later `pre_llm_call`.
- Approval card UI wired to `respondApproval` (the engine surfaces the request as a tool card only); clarify (`request.answer`) not mapped.
- History: use `session.history`/`session.events.since` for tool results and long sessions; refresh the open thread on `sessions.changed`.
- Model/reasoning pickers (`model.options`, `config.set`), slash commands (`commands.*`), cron via `/api/cron/jobs`.
- Label thread source (Telegram/Desktop/cron/subagent), filter out `cron`/`subagent` noise by default.
- Remove the dead OpenClaw transport (`lib/gateway/*`, `engines/openclaw/*`) once the diff is no longer useful.
- Dependency notes: `ws` (bridge), `concurrently` (dev:hermes), Node ≥ 20 for global `WebSocket`/`fetch` in the probes.
