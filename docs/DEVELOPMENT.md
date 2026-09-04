# Development Guide

This is for **plugin developers** who want to change the code of `@esuyo/esuyo-opencode-custom-provider` itself.

> End users: you don't need this. See the main [README.md](../README.md) and [CONFIGURATION.md](./CONFIGURATION.md).

## Requirements

- Node.js `>=18` (`node --version`)
- `npm` (`npm --version`) — the repo uses `npm ci`
- Opencode `>=1.18.25` for testing

## Setup

```bash
git clone https://github.com/8perezm/esuyo-opencode-custom-provider.git
cd esuyo-opencode-custom-provider
npm ci
```

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | `tsc` → `dist/` (what npm publishes) |
| `npm run dev` | `tsc --watch` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | No tests yet (`echo "No tests"`). Add vitest/jest if you add tests. |

`package.json:prepublishOnly` runs `build` automatically before `npm publish`.

## Project layout

```
src/index.ts            # entire plugin (~650 lines)
dist/                   # built output (git-ignored, published)
examples/               # example custom-provider json
docs/                   # you are here
.github/workflows/publish.yml  # CI: auto bump + publish
```

`.opencode/` in this repo is **dev config only** (not published, git-ignored elsewhere).

## Testing locally

### Option A — local file plugin (fastest)

Opencode loads local plugins from `~/.config/opencode/plugins/` and `.opencode/plugins/` directly (no npm cache).

```bash
# build first
npm run build
# copy or symlink src
mkdir -p ~/.config/opencode/plugins
cp src/index.ts ~/.config/opencode/plugins/esuyo-custom-provider.ts
# edit, then re-run opencode
opencode debug config
```

### Option B — npm link

```bash
npm link
# in a test project:
npm link @esuyo/esuyo-opencode-custom-provider
# add to opencode.json plugin: ["@esuyo/esuyo-opencode-custom-provider"]
```

### Verifying session headers (`x-opencode-session`)

`scripts/echo-gateway.mjs` is a header-dump stub (no deps). It serves
`/v1/models` (`echo-model`) and `/v1/chat/completions`, logging
`x-opencode-session` per request:

```bash
npm run echo-gateway -- --port 4311
# in esuyo-opencode-custom-provider.json add:
# { "providers": { "echo-test": { "baseURL": "http://127.0.0.1:4311/v1", "apiKey": "test" } } }
opencode debug config
opencode run "say hi" --model echo-test/echo-model
```

Every `POST /chat/completions` line should show `x-opencode-session: ses_...`.
`(MISSING)` means the hook isn't firing (plugin not loaded, provider not
managed, or `sessionHeaders: false`). Ctrl+C prints a pass/fail summary.

Logs are via `client.app.log({ service: "opencode-custom-provider" })` at `src/index.ts:464`.

## Code overview

- `loadCustomConfig(directory, env, log)` — `src/index.ts:271` — searches in order:
  `OPENCODE_CUSTOM_PROVIDER_CONFIG` env → project `.opencode/*` → `~/.config/opencode/*` (`$XDG_CONFIG_HOME`, `%APPDATA%`) → fallback to `opencode.json` providers with `baseURL`.
- `normalizeProviders()` — handles both `providers: {id: {baseURL}}` map and array forms.
- `fetchGatewayModels()` — GET `${baseURL}/v1/models` (handles trailing slashes, `/v1`, `/models`), `Authorization: Bearer <apiKey>` + `x-api-key`, 8s timeout default.
- `filterModels()` — regex `include`/`exclude`.
- `buildModelConfig()` — humanizes IDs, merges `raw.context_length` etc. into `limit`/`modalities`.
- `config` hook — `src/index.ts:484` — creates `config.provider[providerId]` if missing, resolves `apiKey` (supports `{env:VAR}`, `{file:~/path}`, `apiKeyEnv`, providerId env fallbacks), fetches models, syncs `provider.models`.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full flow.

## Style

- TypeScript `strict`, `module: ESNext`
- No runtime deps — peer is `@opencode-ai/plugin`
- Keep `src/index.ts` small and comment-light (per repo style)

## Before PR

```bash
npm run typecheck
npm run build
# bump version via conventional commit (see PUBLISHING.md), don't manual edit version
```
