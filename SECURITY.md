# Security Policy

OpenHermes OS is a work-in-progress fork ([Olewol/openhermes-os](https://github.com/Olewol/openhermes-os)) of [thesysdev/openclaw-os](https://github.com/thesysdev/openclaw-os) for [Hermes Agent](https://github.com/NousResearch/hermes-agent). It is **not production-ready** (see [README](./README.md)); do not expose it to untrusted networks.

## Reporting a Vulnerability

Report vulnerabilities in **this fork** privately through GitHub's Security Advisory flow on this repository:

1. Go to the **Security** tab of [Olewol/openhermes-os](https://github.com/Olewol/openhermes-os/security).
2. Click **Report a vulnerability**.
3. Describe the issue, affected commit/branch (`hermes-native`), and reproduction steps.

> Note for the maintainer: private vulnerability reporting is currently **disabled** on the repository (checked 24.11.2026 via the GitHub API). Enable it under Settings → Code security before this policy is usable; until then, contact the maintainer ([Olewol](https://github.com/Olewol)) directly and **do not open a public issue** with exploit details.

**Please do not report security vulnerabilities through public GitHub issues.**

## Scope and where else to report

| Issue is in | Report to |
|---|---|
| This fork (UI, `HermesEngine`, `scripts/hermes-bridge.mjs`, docs) | this repository, as above |
| Hermes Agent itself (gateway, dashboard, plugins) | [NousResearch/hermes-agent security policy](https://github.com/NousResearch/hermes-agent/security) |
| Unchanged upstream code that also exists in `thesysdev/openclaw-os` or OpenClaw | the respective upstream project; tell us as well so the fork can follow |

The bridge (`scripts/hermes-bridge.mjs`) logs in to the Hermes dashboard with credentials from environment variables and must only listen on loopback unless you know what you are doing.
