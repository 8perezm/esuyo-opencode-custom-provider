# Architecture

## Goal

On every `opencode` start, turn any OpenAI-compatible gateway (`/v1/models`) into first-class `opencode` providers with models auto-discovered — no manual `opencode.json:provider.*.models` maintenance.

## Entry

`src/index.ts:464` exports `OpencodeCustomProviderPlugin: Plugin` (`@opencode-ai/plugin`). Opencode loads it via `plugin: ["@esuyo/esuyo-opencode-custom-provider"]` in `opencode.json` (global `~/.config/opencode/opencode.json` or project `opencode.json`).

## Load order

Per [opencode.ai/docs/plugins#load-order](https://opencode.ai/docs/plugins#load-order): global config → project config → global plugins dir → project plugins dir. Duplicate `npm` spec + version is deduped.

## Config hook

`return { config: async (config) => { ... } }` (`src/index.ts:484`) runs before models are selected.

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
- `config.disabled_providers` / `config.enabled_providers` → skip

### 3. Ensure provider in opencode config

If `config.provider[providerId]` missing, auto-create:
`{ npm: "@ai-sdk/openai-compatible", name: entry.name ?? id, options: { baseURL } }`.

### 4. Resolve apiKey

`resolveApiKeyAsync()` (`src/index.ts:134`): `apiKey` (`{env:}`, `{file:}`, plain) → `apiKeyEnv` → `provider.options.apiKey` → `${ID}_API_KEY`/`_TOKEN` → `ESUYO_*` fallbacks. Also reuses key from another provider with same `baseURL`.

### 5. Fetch + sync models

- `fetchGatewayModels(baseURL, apiKey, timeoutMs)` (`src/index.ts:397`): `GET ${baseURL}/v1/models` (handles `/v1`, `/models` suffixes), headers `Authorization: Bearer` + `x-api-key`, parses `[]` or `{data:[]}` or `{models:[]}`, dedupes by `id`.
- `filterModels()` regex `include`/`exclude`.
- `buildModelConfig()` humanizes IDs, merges `raw.context_length` etc. into `limit`/`modalities`, respects `entry.models` static overrides and preserves existing `provider.models[id]` if present.
- Cache per `baseURL` 30s (`src/index.ts:472`).
- Stale models removed, new added, `provider.models = nextModels`.

Logs at each step via `client.app.log({ service: "opencode-custom-provider" })`.

## Error handling

- No config → warn `create .opencode/opencode-custom-provider.json` and return.
- Gateway fetch fails → keep `existingCount`, warn, don't clear models.
- 0 models → warn, keep existing.

## Constants

`DEFAULT_NPM = "@ai-sdk/openai-compatible"`, `DEFAULT_TIMEOUT_MS = 8000`, `DEFAULT_MODEL_LIMIT = {context:200000, output:32000}`, `DEFAULT_MODALITIES = {input:["text","image"], output:["text"]}`.

## File map

- `src/index.ts:60-55` types
- `src/index.ts:76-182` helpers (`humanizeModelId`, `resolveModelsUrl`, `resolveStringValue*`, `stripJsonComments`)
- `src/index.ts:184-346` `normalizeProviders`, `loadCustomConfig`, `buildModelConfig`
- `src/index.ts:397-651` fetch, filter, plugin export
