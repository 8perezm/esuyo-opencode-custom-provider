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
    "npm": "@ai-sdk/openai-compatible",   // provider npm package
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
      "npm": "@ai-sdk/openai-compatible", // override defaults.npm
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

Override per-provider via `modelDefaults`.

## Disabled / enabled providers

- Per-provider: `"enabled": false` in your custom file skips it.
- Global: `opencode.json` `disabled_providers: ["esuyo-gateway"]` or `enabled_providers: ["only-this"]` also filter (`src/index.ts:519`).

## Comments in JSON

`.jsonc` files support `//` and `/* */` comments (`src/index.ts:176` strips them).
