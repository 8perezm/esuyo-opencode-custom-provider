# Architecture

## Goal

On every `opencode` start, turn any OpenAI-compatible gateway (`/v1/models`) into first-class `opencode` providers with models auto-discovered — no manual `providers.<id>.models` maintenance in `opencode.jsonc`.

## Entry (Opencode V2)

`src/index.ts` default-exports `Plugin.define({ id: "esuyo-custom-provider", setup })` (`@opencode/plugin`, promise API). The V2 server **requires** this shape — the V1 function export (`@opencode-ai/plugin`, `config`/`chat.headers` hooks) fails to load with `Plugin must export a default definition with an id and an effect or setup function`.

For local repair/dev, Opencode 2 auto-loads the built file from the global discovery directory (explicit `plugins: ["<absolute path>"]` entries are silently ignored on Windows in 2.0.29):

```
~/.config/opencode/plugins/esuyo-custom-provider.js  <- copy of dist/index.js
```

Published installs (`opencode plugin add @esuyo/esuyo-opencode-custom-provider`) keep working via the npm path.

## Load order

Per [opencode.ai/docs/plugins](https://opencode.ai/v2/docs/plugins): global config → project config → global plugins dir → project plugins dir.

## Setup flow (V2)

`setup(ctx)` must return fast — slow setups abort location activation (`ServiceUnavailableError: Location plugins did not finish activating`). So it only does local work, then syncs in the background:

```
setup(ctx)
 ├─ loadCustomConfig(project dirs + global, env override)
 ├─ loadModelsDevCatalog() once (live fetch, snapshot fallback, TTL-cached;
 │   skipped when every provider opts out via `modelsDev: false`)
 ├─ ctx.provider.transform(editor => replay(source))   # sync, initially empty
 ├─ ctx.session.hook("model.request", inject header)   # sync
 └─ background (floating promise, never throws):
     ├─ for each provider: GET ${baseURL}/v1/models (parallel)
     ├─ per model: findModelsDevMatch(id) → enrich capabilities/limit/cost
     │   (gateway raw > catalog by default; static `models:` entries win)
     ├─ filter include/exclude, build Model.Info[]
     └─ source.providers = [...] → await ctx.provider.reload()
```

Compare V1 (`src ≤0.3.x`): a `config` hook mutated `config.provider[id].options/models` synchronously at startup.

### 1. Load custom config

`loadCustomConfig(directory, env, log)` (`src/index.ts:271`):

```
OPENCODE_CUSTOM_PROVIDER_CONFIG env (absolute)
  → PROJECT/.opencode/esuyo-opencode-custom-provider.json[c]
  → .opencode/opencode-custom-provider.json[c], custom-providers.json[c]
  → PROJECT/esuyo-opencode-custom-provider.json, etc.
  → GLOBAL ~/.config/opencode/esuyo-opencode-custom-provider.json[c]
    ($XDG_CONFIG_HOME/opencode if set, %APPDATA%\opencode on Windows)
  → fallback: opencode.json provider.*.options.baseURL
```

`normalizeProviders()` handles map `{id: {baseURL}}`, array `[{id, baseURL}]`, or bare map without `providers` key.

### 2. Filter providers

- `entry.enabled === false` → skip
- (V1-only, removed: `disabled_providers` / `enabled_providers` from `opencode.json` no longer exist in V2, so they are not read.)

### 3. Provider registration (V2 transform)

The `source` object accumulates `{ info, models }` per provider; the
registered transform replays it on every reload:

- new provider → `editor.add({ info, models })` with
  `info = { ...Provider.Info.empty(id), name, activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL, apiKey } }`
- existing provider → `editor.update(...)` + `editor.models.set(id, models)` (stale models removed, same as V1 replacing `provider.models`).

### 4. Resolve apiKey

`resolveApiKeyAsync()`: `apiKey` (`{env:}`, `{file:}`, plain) → `apiKeyEnv` → existing registry `settings.apiKey` → `${ID}_API_KEY`/`_TOKEN` → `ESUYO_*` fallbacks. Also reuses key from another entry with same `baseURL`.

### 5. Fetch + sync models

- `fetchGatewayModels(baseURL, apiKey, timeoutMs)`: `GET ${baseURL}/v1/models` (handles `/v1`, `/models` suffixes), headers `Authorization: Bearer` + `x-api-key`, parses `[]` or `{data:[]}` or `{models:[]}`, dedupes by `id`.
- `filterModels()` regex `include`/`exclude`.
- `buildModelInfo()` humanizes IDs, merges `raw.context_length` etc. into `limit`/`capabilities`, respects `entry.models` static overrides.
- Cache per `baseURL` 30s.
- Stale models removed on `editor.models.set`, new added.

Logs go to stdout (`[opencode-custom-provider]` prefix).

## Error handling

- No config → warn `create .opencode/esuyo-opencode-custom-provider.json`, still registers the session hook, returns.
- Gateway fetch fails → skip that provider, warn (registry keeps previous inventory).
- 0 models → warn, skip sync.

## Constants

`DEFAULT_PACKAGE = "@opencode/ai/providers/openai-compatible"` (legacy `"@ai-sdk/openai-compatible"` in user config is auto-mapped), `DEFAULT_TIMEOUT_MS = 8000`, `DEFAULT_MODEL_LIMIT = {context:200000, output:32000}`, `DEFAULT_MODALITIES = {input:["text","image"], output:["text"]}`.

## File map

- types (`ProviderEntry`, `CustomConfigFile`, …)
- helpers (`humanizeModelId`, `resolveModelsUrl`, `resolveStringValue*`, `stripJsonComments`)
- `normalizeProviders`, `loadCustomConfig`, `buildModelInfo`
- fetch, filter, `Plugin.define({ id, setup })`
