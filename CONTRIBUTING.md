# Contributing to OpenHermes OS

> OpenHermes OS er en WIP-fork av [thesysdev/openclaw-os](https://github.com/thesysdev/openclaw-os) for [Hermes Agent](https://github.com/NousResearch/hermes-agent) (se [README](./README.md)). Bidrag gjøres mot **denne** forken, ikke mot upstream. Pull requests og issues hører hjemme i [Olewol/openhermes-os](https://github.com/Olewol/openhermes-os); ikke send forkens endringer til Thesys eller OpenClaw uten avtale.

Thank you for considering contributing to OpenHermes OS! This document covers how to set up the repo, what we expect from contributions, and the workflow for opening a pull request.

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Repository layout

```
openhermes-os/
├── packages/
│   ├── claw-client/   # Next.js generative UI web client (+ HermesEngine)
│   └── claw-plugin/   # upstream OpenClaw-plugin; skal portes til Hermes (docs/PORTING.md)
├── scripts/           # Local helpers (connection info, tunnel setup)
└── .github/           # CI workflows + issue / PR templates
```

See [`AGENTS.md`](./AGENTS.md) for protocol details, gateway internals, and the agent / session / thread mental model.

## Prerequisites

- [Node.js](https://nodejs.org/) **20+** (run `nvm use` to pick up the version pinned in `.nvmrc`)
- [pnpm](https://pnpm.io/) **9.15+**
- A running [Hermes Agent](https://github.com/NousResearch/hermes-agent) dashboard on `127.0.0.1:9119` with dashboard login for end-to-end testing (see [`docs/HERMES.md`](./docs/HERMES.md#setup))

## Local setup

```bash
git clone https://github.com/Olewol/openhermes-os.git
cd openhermes-os
git checkout hermes-native
pnpm install
```

That's it — the install runs in the workspace root and links both packages.

### Run the client locally

```bash
cd packages/claw-client
pnpm dev:hermes   # bridge :18791 + UI http://localhost:18790 (needs HERMES_DASH_USER / HERMES_DASH_PASSWORD, see docs/HERMES.md)
```

### The OpenClaw plugin (upstream, not used with Hermes)

`packages/claw-plugin` is the unchanged upstream OpenClaw plugin. It does **not** run against Hermes; porting it to a Hermes plugin is phase 2 (see [`docs/ROADMAP.md`](./docs/ROADMAP.md)). Its install instructions in [`packages/claw-plugin/README.md`](./packages/claw-plugin/README.md) are upstream text and apply to OpenClaw only.

## Development workflow

1. Fork [Olewol/openhermes-os](https://github.com/Olewol/openhermes-os).
2. Create a feature branch from `hermes-native`: `git checkout -b feature/your-thing`.
3. Make your changes.
4. Run the full check before pushing:
   ```bash
   pnpm ci
   ```
   This runs lint, format check, typecheck, and build for every package. It is the same set of checks GitHub Actions runs on your PR.
5. Update docs (root README or per-package README) when you change user-facing behaviour.
6. Open a pull request against `hermes-native` in this fork using the PR template. (`main` mirrors upstream and is not the working branch.)

## Code style

We use **ESLint** (flat config, v9) and **Prettier**. Both are wired up at the workspace root and run per-package.

```bash
pnpm format:fix      # auto-format every package
pnpm lint:fix        # auto-fix what ESLint can fix
pnpm typecheck       # strict TypeScript across the workspace
```

Notes:

- Strict TypeScript is enabled at the root: `noUncheckedIndexedAccess`, `noImplicitReturns`, `noPropertyAccessFromIndexSignature`, `noFallthroughCasesInSwitch`, `noImplicitOverride`. New code should satisfy these without `// @ts-ignore`.
- `console.log` is a lint error. Use `console.warn` / `console.error` / `console.info` (or a proper logger).
- Unused imports are a lint error. Prefix intentionally-unused vars with `_`.
- Prettier is the source of truth for formatting — no bikeshedding.

## Commit messages

Keep the subject short, imperative, and scoped to the package when relevant:

```
feat(claw-client): stream artifact updates incrementally
fix(claw-plugin): tolerate missing senderId in session keys
chore(deps): bump @openuidev/react-ui to 0.12.0
```

## Bug reports & feature requests

Please use the [issue templates](.github/ISSUE_TEMPLATE/). For bugs, include:

- A clear description and reproduction steps
- Versions of the client and of Hermes Agent (`hermes --version`)
- Relevant bridge/gateway logs and browser console output

## Security issues

Please **do not** report security vulnerabilities through public GitHub issues. See [`SECURITY.md`](./SECURITY.md) for the disclosure process.

## Questions?

Open an [issue](https://github.com/Olewol/openhermes-os/issues) in this fork (issues are currently disabled on the repo; enable them under Settings → Features before relying on this).
