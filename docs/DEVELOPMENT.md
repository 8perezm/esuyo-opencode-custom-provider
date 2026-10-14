# Development Guide

This is for **plugin developers** who want to change the code of `@esuyo/esuyo-opencode-custom-provider` itself.

> End users: you don't need this. See the main [README.md](../README.md) and [CONFIGURATION.md](./CONFIGURATION.md).

## Requirements

- Node.js `>=18` (`node --version`)
- `npm` (`npm --version`) — the repo uses `npm ci`
- Opencode `>=2.0` for testing (V2-only since 0.4.0; V1 needs `<=0.3.x`)

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

Opencode 2 auto-loads `~/.config/opencode/plugins/*.js` (and
`.opencode/plugins/` per project) — no npm cache involved. The file must be
the **built** output (`dist/index.js`), not TS source:

```bash
npm run build
mkdir -p ~/.config/opencode/plugins
cp dist/index.js ~/.config/opencode/plugins/esuyo-custom-provider.js
opencode reload
opencode models  # should list esuyo-gateway/...
```

> Explicit `plugins: ["./local/path"]` entries in `opencode.json` are
> silently ignored by Opencode 2.0.29 on Windows — use the `plugins/`
> discovery directory instead. Re-copy after every build (the file is a
> snapshot, not a link).

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

Logs go to stdout (`[opencode-custom-provider]` prefix) — visible in
`opencode ... --standalone --print-logs`, **not** in the background service
log. `src/index.ts` line numbers below are approximate.

## Code overview

- `loadCustomConfig(directories, env, log)` — searches in order:
  `OPENCODE_CUSTOM_PROVIDER_CONFIG` env → project `.opencode/*` (for every
  of `project.directory`, `project.canonical`, `location.directory`) →
  `~/.config/opencode/*` (`$XDG_CONFIG_HOME`, `%APPDATA%`) → fallback to
  registry providers with `settings.baseURL`.
- `normalizeProviders()` — handles `providers: {id: {baseURL}}` map, array
  `[{id, baseURL}]`, and bare-map forms.
- `fetchGatewayModels()` — GET `${baseURL}/v1/models` (handles trailing slashes, `/v1`, `/models`), `Authorization: Bearer <apiKey>` + `x-api-key`, 8s timeout default.
- `filterModels()` — regex `include`/`exclude`.
- `buildModelInfo()` — builds V2 `Model.Info` via `Model.Info.default()`,
  humanizes IDs, merges `raw.context_length` etc. into `limit`/`capabilities`.
- `setup()` — V2 entrypoint (`Plugin.define({ id, setup })`):
  1. reads the custom JSON (fast, local fs only),
  2. registers `ctx.provider.transform` (replays a mutable `source` object) and the `model.request` session hook (fast — setup returns in ms),
  3. syncs gateways in a **background** floating promise, then `ctx.provider.reload()`.
  
  Setup must never block on network: locations fail to activate otherwise
  (`ServiceUnavailableError: Location plugins did not finish activating`).
- Session hook — `ctx.session.hook("model.request", …)` backfills
  `x-opencode-session` for managed providers (V1 `chat.headers` equivalent).

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full flow.

## Style

- TypeScript `strict`, `module: NodeNext`
- No runtime deps — peer is `@opencode/plugin` (`^2.0.0`, host-provided at runtime)
- Keep `src/index.ts` small and comment-light (per repo style)

## Before PR

```bash
npm run typecheck
npm run build
# bump version via conventional commit (see PUBLISHING.md), don't manual edit version
```
