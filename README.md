# esuyo-opencode-custom-provider

Opencode plugin that auto-discovers models from any OpenAI-compatible gateway on every `opencode` start. No more manually maintaining `opencode.json` models.

Published as `@esuyo/esuyo-opencode-custom-provider` on npm (scoped to [Esuyo org](https://www.npmjs.com/org/esuyo)). Install via `opencode` plugin system.

## Install

**Global (recommended — available in every project):**

```bash
opencode plugin @esuyo/esuyo-opencode-custom-provider --global
# alias: opencode plug @esuyo/esuyo-opencode-custom-provider -g
```

Or add to global config `~/.config/opencode/opencode.json` (`%USERPROFILE%\.config\opencode\opencode.json` on Windows):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@esuyo/esuyo-opencode-custom-provider"]
}
```

**Per-project:**

```json
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@esuyo/esuyo-opencode-custom-provider"]
}
```

Plugins are auto-installed via `Bun` at startup and cached in `~/.cache/opencode/packages` (see [opencode.ai/docs/plugins](https://opencode.ai/docs/plugins#how-plugins-are-installed)).

## Configuration

Plugin reads the first found config (in order):

1. `OPENCODE_CUSTOM_PROVIDER_CONFIG` env (absolute path) — highest priority
2. Project: `.opencode/esuyo-opencode-custom-provider.json` / `.jsonc`
3. Project: `.opencode/opencode-custom-provider.json` / `.jsonc`
4. Project: `.opencode/custom-providers.json` / `.jsonc`
5. Project: `esuyo-opencode-custom-provider.json` (root) / `opencode-custom-provider.json` / `.jsonc`
6. **Global:** `~/.config/opencode/esuyo-opencode-custom-provider.json` / `.jsonc` (`$XDG_CONFIG_HOME/opencode` if set, plus `%APPDATA%\opencode` on Windows)
7. Global variants: `opencode-custom-provider.json`, `custom-providers.json`
8. Fallback: `opencode.json` `provider.*.options.baseURL` (backward compat)

Project overrides global; env overrides all.

**Global example:** `~/.config/opencode/esuyo-opencode-custom-provider.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "defaults": {
    "npm": "@ai-sdk/openai-compatible",
    "timeoutMs": 8000
  },
  "providers": {
    "esuyo-gateway": {
      "name": "Esuyo Gateway",
      "baseURL": "https://gateway.example.com/v1",
      "apiKey": "{env:ESUYO_GATEWAY_API_KEY}"
    },
    "second-gateway": {
      "name": "Second Gateway",
      "baseURL": "https://other.example.com/v1",
      "apiKey": "{env:SECOND_GATEWAY_API_KEY}",
      "include": ["^esuyo/.*"],
      "exclude": ["embedding"]
    }
  }
}
```

**Project override:** `C:\SERVER\REPOS\Esuyo\esuyo-tmp-test2\.opencode\esuyo-opencode-custom-provider.json` (same schema) takes precedence when present.

See `examples/esuyo-opencode-custom-provider.example.json` for full schema (`defaults`, `include`/`exclude`, `{env:}`, `{file:}`, `modelDefaults`).

Set keys:

```powershell
$env:ESUYO_GATEWAY_API_KEY="sk-..."
# persistent (Windows):
[Environment]::SetEnvironmentVariable("ESUYO_GATEWAY_API_KEY","sk-...","User")
```

Verify:

```powershell
opencode debug config
# provider.esuyo-gateway with auto-discovered models
```

## Updating

Plugins are cached by `opencode` (`~/.cache/opencode/packages/@esuyo/esuyo-opencode-custom-provider@latest` pinned to install-time version). After a new npm release:

```powershell
opencode plugin @esuyo/esuyo-opencode-custom-provider --global --force
# -f = Replace existing plugin version (opencode --help)
```

Or manual:

```powershell
Remove-Item -Recurse -Force "$HOME\.cache\opencode\packages" -ErrorAction SilentlyContinue
opencode debug config
```

See [opencode.ai/docs/plugins](https://opencode.ai/docs/plugins) and `opencode plugin --help`.

## Development

```bash
npm ci
npm run build      # builds to dist/
npm run typecheck
```

Plugin source is `src/index.ts`. `.opencode/` in this repo is dev config only (not published).

## Publishing

Push to `main` triggers `.github/workflows/publish.yml`:
- auto-bumps version from commit message (`feat:` -> minor, `BREAKING CHANGE:` -> major, else patch)
- builds, tags `v*`, publishes `npm publish --access public`, creates GitHub Release
- requires `NPM_TOKEN` secret (publishes `@esuyo` scoped to Esuyo npm org)

Previous unscoped `esuyo-opencode-custom-provider@0.2.4` is deprecated; use `@esuyo/esuyo-opencode-custom-provider`.

## License

MIT
