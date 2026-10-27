# Advanced Configuration

> New to this? Start with the [README.md](../README.md) 3-step guide. This doc is the full reference.

## Where to put the file

The plugin checks **in order**, stops at first found:

| Priority | Path | For |
|---|---|---|
| 1 | `$OPENCODE_CUSTOM_PROVIDER_CONFIG` | Absolute path override (anywhere) |
| 2 | `PROJECT/.opencode/esuyo-opencode-custom-provider.json` | Per-project (recommended for teams) |
| 3 | `PROJECT/.opencode/esuyo-opencode-custom-provider.jsonc` | same, with comments |
| 4 | `PROJECT/.opencode/opencode-custom-provider.json[c]` | alias |
| 5 | `PROJECT/.opencode/custom-providers.json[c]` | alias |
| 6 | `PROJECT/esuyo-opencode-custom-provider.json` | project root |
| 7 | `PROJECT/opencode-custom-provider.json[c]` | root alias |
| **8** | `~/.config/opencode/esuyo-opencode-custom-provider.json[c]` | **Global — works in every project** (`$XDG_CONFIG_HOME/opencode` if set, plus `%APPDATA%\opencode` on Windows) |
| 9 | Global variants: `opencode-custom-provider.json`, `custom-providers.json` | global aliases |
| 10 | `opencode.json` `provider.<id>.options.baseURL` | Fallback (no file) |

Project overrides global; env overrides all.

## Minimal example

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "esuyo-gateway": {
      "baseURL": "https://gateway.example.com/v1",
      "apiKey": "{env:ESUYO_GATEWAY_API_KEY}"
    }
  }
}
```

Full example: [`examples/esuyo-opencode-custom-provider.example.json`](../examples/esuyo-opencode-custom-provider.example.json)

## Full schema

```json
{
  "$schema": "https://opencode.ai/config.json",
  "defaults": {
    "npm": "@opencode/ai/providers/openai-compatible",   // provider runtime package (V1 "@ai-sdk/openai-compatible" still accepted, auto-mapped)
    "timeoutMs": 8000,                    // fetch /v1/models timeout
    "modelDefaults": {                    // applied to every discovered model
      "modalities": { "input": ["text", "image"], "output": ["text"] },
      "attachment": true,
      "limit": { "context": 200000, "output": 32000 }
    }
  },
  "providers": {
    "my-gateway": {
      "name": "My Gateway",               // display name
      "baseURL": "https://gateway.example.com/v1",
      "apiKey": "{env:MY_KEY}",           // see ApiKey section
      "apiKeyEnv": "MY_KEY",              // alt: env var name
      "npm": "@opencode/ai/providers/openai-compatible", // override defaults.npm
      "timeoutMs": 5000,                  // override defaults.timeoutMs
      "enabled": true,                    // false = skip
      "include": ["^esuyo/.*"],           // regex filter (allow)
      "exclude": ["embedding"],           // regex filter (deny)
      "modelDefaults": { "...": "..." },  // per-provider override
      "models": {                         // static overrides merged after discovery
        "esuyo/opencode/my-model": { "name": "My Model", "limit": { "context": 100000 } }
      }
    }
  }
}
```

You can also use **array form** for `providers`:

```json
"providers": [
  { "id": "my-gateway", "baseURL": "https://...", "apiKey": "{env:MY_KEY}" }
]
```

Or a **bare map** without `providers` wrapper (top-level keys are providers):

```json
{
  "esuyo-gateway": { "baseURL": "https://...", "apiKey": "sk-..." }
}
```

## ApiKey resolution (in order)

1. `providers.<id>.apiKey` — supports `{env:VAR}`, `{file:~/path/to/key.txt}`, or plain string. `{file:}` is read async (`src/index.ts:110`).
2. `providers.<id>.apiKeyEnv` — env var name (e.g. `"ESUYO_GATEWAY_API_KEY"`).
3. `provider.<id>.options.apiKey` from `opencode.json` (if you put baseURL there).
4. Env fallbacks: `<PROVIDER_ID>_API_KEY`, `<PROVIDER_ID>_TOKEN`, then `ESUYO_GATEWAY_API_KEY` / `ESUYO_API_KEY` (uppercased ID, non-alphanum → `_`).

Examples:

```json
"apiKey": "{env:ESUYO_GATEWAY_API_KEY}"
"apiKey": "{file:~/.secrets/gateway-key}"
"apiKey": "sk-plain-key-not-recommended"
"apiKeyEnv": "ESUYO_GATEWAY_API_KEY"
```

Set via:

```powershell
$env:ESUYO_GATEWAY_API_KEY="sk-..."
[Environment]::SetEnvironmentVariable("ESUYO_GATEWAY_API_KEY","sk-...","User") # persistent
```

## Filtering models

`include` / `exclude` are arrays of **regex strings** matched against `model.id` (`src/index.ts:417`):

```json
"include": ["^esuyo/opencode/.*", "deepseek"],
"exclude": ["embedding", "vision"]
```

## Model defaults

If gateway returns `context_length`, `max_output_tokens`, `supports_vision` etc., they are merged into the model config (`src/index.ts:348`). `humanizeModelId()` turns `esuyo/opencode/qwen3.8-flash` → `Qwen3.8 Flash`.

`modelDefaults` (global or per-provider) are **fallbacks**, not overrides: they
only fill values no better source provides. A generic
`"modelDefaults": { "limit": { "context": 256000 } }` therefore no longer
shrinks a model the catalog knows is 1M tokens. To hard-pin a specific model,
use a static `models:` entry (applied last, always wins).

### Precedence

`built-in defaults < modelDefaults < models.dev < gateway /v1/models < static
models: overrides`

Live gateway values win over the catalog by default (`preferGateway: false`
swaps those two); static `models:` entries always win.

## models.dev enrichment (thinking levels, input types, context limits)

Gateways usually expose `/v1/models` as bare IDs with no metadata. When
enabled (the default), the plugin looks each discovered model up in the
[models.dev](https://models.dev) catalog (via the `@opencode-ai/models`
client) and maps the result onto `Model.Info`:

| models.dev | Opencode `Model.Info` | Why it matters |
|---|---|---|
| `modalities.input` / `.output` | `capabilities.input` / `.output` | image/pdf/video support in the picker |
| `tool_call` | `capabilities.tools` | function-calling capability |
| `reasoning_options` effort values | `variants` | `/variants` lists e.g. `low`/`medium`/`high`; select as `provider/model:high` |
| `limit.context` / `.input` / `.output` | `limit` | compaction + max tokens |
| `cost` (+ context tiers) | `cost` | cost display |
| `family`, `status` | `family`, `status` | grouping, deprecated flags |
| `name` | `name` | only when the gateway has no display name |

Each effort variant carries `settings: { reasoningEffort: "<level>" }` — the
option name the `openai-compatible` provider maps onto the `reasoning_effort`
request parameter. Variants only take effect when you explicitly select them,
so generating them is safe even for endpoints that ignore the parameter.
Toggle-only or budget-only models expose no discrete levels and get no
variants; neither do non-chat types (`embedding`, …) or non-reasoning models.
No catalog match (e.g. a custom gateway model unknown to models.dev) also
means no variants — define them yourself via a static `models:` override
(see below), or disable generation with `"variants": false`.

Precedence per field: built-in defaults < `modelDefaults` < models.dev <
gateway `/v1/models` < static `models:` overrides. So live gateway values win
on conflict; set `preferGateway: false` to let the catalog win instead (useful
for stale gateways). `modelDefaults` act as fallbacks — they never shrink a
value the catalog or gateway reports.

Matching: exact ID matches win; otherwise the last `/`-separated segment is
compared case-insensitively (`esuyo/opencode/qwen3.8-flash` → `qwen3.8-flash`).
Ambiguous suffixes resolve deterministically: exact string > pinned provider >
**canonical owner** (the provider namespace that owns the model's
`canonical_model_id`, e.g. `meta` for `meta/muse-spark-1.3`) > unlinked
"lab original" entries > non-deprecated. Canonical owners carry authoritative
capabilities: some reseller mirrors advertise extra reasoning levels (e.g.
`max`) that the real deployment does not support, so they must not win. This
also keeps pricing near list price. Entries with a non-chat `type` (e.g.
`embedding`, `image`) only enrich factual fields (name/limit/cost/family/status)
— capability fields are left alone. To force a specific catalog namespace for a
provider (e.g. a gateway that re-serves a known upstream), set
`"modelsDev": { "provider": "opencode-go" }`.

The catalog is fetched once per setup (shared by all providers) and cached in
memory for `cacheTtlMs`. If the live fetch fails, the bundled snapshot from
`@opencode-ai/models` (at most ~24h old) is used; if that is unavailable too,
the plugin falls back to gateway-only metadata with a warning.

```json
{
  "modelsDev": {
    "enabled": true,          // false = gateway metadata only
    "baseUrl": "https://models.dev",
    "timeoutMs": 8000,
    "cacheTtlMs": 3600000,    // 1h in-memory cache
    "modelTypes": "all",       // "all" (?type=all) or "standard"
    "preferGateway": true,     // false = catalog wins over gateway metadata
    "variants": true,          // false = no reasoning-effort variants
    "excludeDeprecated": false,
    "excludeTypes": ["embedding"],  // skip enrichment for these model types
    "provider": "openai"       // optional global namespace pin for matching
  },
  "providers": {
    "my-gateway": {
      "baseURL": "https://gateway.example.com/v1",
      "apiKey": "{env:MY_KEY}",
      "modelsDev": { "enabled": true, "provider": "openai", "variants": true },
      // ...or "modelsDev": false to opt this provider out
      "models": {
        // Static overrides win over the catalog. Define `variants` yourself
        // for gateway models the catalog doesn't know (or `[]` to clear
        // catalog-generated variants for a model):
        "my-custom-model": {
          "name": "My Custom Model",
          "limit": { "context": 200000, "output": 32000 },
          "variants": [{ "id": "high", "settings": { "reasoningEffort": "high" } }]
        }
      }
    }
  }
}
```

## Disabled / enabled providers

- Per-provider: `"enabled": false` in your custom file skips it.
- (V1-only, removed in V2: `opencode.json` `disabled_providers` / `enabled_providers` keys no longer exist, so the plugin does not read them.)

## Comments in JSON

`.jsonc` files support `//` and `/* */` comments (`src/index.ts:176` strips them).

## Session headers (OpenCode Go/Zen compliance)

Opencode core only sends `x-opencode-session` for first-party `opencode*`
providers. Custom gateways get `x-session-affinity` / `X-Session-Id` instead —
which OpenCode Go flags as missing (may error after 09/06).

This plugin backfills `x-opencode-session: <opencode sessionID>` via the
`model.request` session hook for every provider it manages. Enabled by default;
first-party `opencode*` providers are skipped (core already handles them) and
unrelated providers (e.g. `anthropic` direct) are never touched.

```json
{
  "sessionHeaders": {
    "enabled": true,
    "header": "x-opencode-session",
    "providers": ["esuyo-gateway"]
  },
  "providers": {
    "esuyo-gateway": {
      "baseURL": "https://gateway.example.com/v1",
      "apiKey": "{env:ESUYO_GATEWAY_API_KEY}"
    }
  }
}
```

Options:

| Key | Default | Meaning |
|---|---|---|
| `sessionHeaders` | enabled | `false` disables injection entirely; `true`/omitted uses defaults |
| `sessionHeaders.header` | `"x-opencode-session"` | header name to inject |
| `sessionHeaders.providers` | all managed providers | allowlist — only these provider IDs get the header (also opts in unmanaged IDs) |
| `providers.<id>.sendSessionHeaders` | `true` | per-provider opt-out: `false` leaves that provider untouched |
| `providers.<id>.sessionHeader` | global header | per-provider header name override |
