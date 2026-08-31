# esuyo-opencode-custom-provider

Opencode plugin that auto-discovers models from any OpenAI-compatible gateway on every `opencode` start. No more manually maintaining `opencode.json` models.

Published as `@esuyo/esuyo-opencode-custom-provider` on npm. Install via `opencode` plugin system.

## Install

```bash
# once published
npm install @esuyo/esuyo-opencode-custom-provider
# or via opencode
opencode plugin add @esuyo/esuyo-opencode-custom-provider
```

Then add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@esuyo/esuyo-opencode-custom-provider"]
}
```

## Configuration

Plugin reads (first found):

1. `OPENCODE_CUSTOM_PROVIDER_CONFIG` env (absolute path)
2. `.opencode/esuyo-opencode-custom-provider.json (or examples/ for reference)`
3. `.opencode/esuyo-opencode-custom-provider.json (or examples/ for reference)c`
4. `.opencode/custom-providers.json`
5. `opencode-custom-provider.json` (project root)

If none found, falls back to `opencode.json` providers with `options.baseURL`.

### Example `.opencode/esuyo-opencode-custom-provider.json (or examples/ for reference)`

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

See `examples/esuyo-opencode-custom-provider.example.json` for full schema (`defaults`, `include`/`exclude`, `{env:}`, `{file:}`, `modelDefaults`).

Set keys:

```powershell
$env:ESUYO_GATEWAY_API_KEY="sk-..."
```

Verify:

```powershell
opencode debug config
# esuyo-gateway 21 models auto-created
```

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
- builds, tags `v*`, publishes with provenance, creates GitHub Release
- requires `NPM_TOKEN` secret

## License

MIT
