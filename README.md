# ✨ Esuyo Custom Provider for Opencode

**Your AI gateway, automatically connected to Opencode. No copy-pasting models. Ever.**

> If you can copy and paste, you can do this — even if you're 10.

This tiny plugin finds all the models from your AI gateway and adds them to Opencode for you, every time you start Opencode. You tell it *where* your gateway is, it does the rest.

---

### Why you'll love it

- **Zero maintenance** — new models appear automatically, old ones disappear
- **One place to configure** — works in every project once you set it up globally
- **Safe with secrets** — your API key stays in an environment variable, not in the file

---

## 🚀 Quick Start — 3 Steps (2 minutes)

Do this once and it works everywhere.

### Step 1 — Install the plugin

Open your terminal (PowerShell on Windows, Terminal on Mac) and run:

```bash
opencode plugin @esuyo/esuyo-opencode-custom-provider --global
```

That's it. Opencode will download it and remember it.

> **What just happened?** You told Opencode: “Hey, please also load the Esuyo helper.”

### Step 2 — Tell it where your gateway is

Create a file at:

- **Windows:** `C:\Users\YOUR_NAME\.config\opencode\esuyo-opencode-custom-provider.json`
- **Mac / Linux:** `~/.config/opencode/esuyo-opencode-custom-provider.json`

You can create it with Notepad, VS Code, or this command:

**Windows (PowerShell):**
```powershell
New-Item -ItemType Directory -Force -Path "$HOME\.config\opencode" | Out-Null
notepad "$HOME\.config\opencode\esuyo-opencode-custom-provider.json"
```

**Mac / Linux:**
```bash
mkdir -p ~/.config/opencode
nano ~/.config/opencode/esuyo-opencode-custom-provider.json
```

Paste this inside (replace the `baseURL` with yours):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "esuyo-gateway": {
      "name": "Esuyo Gateway",
      "baseURL": "https://gateway.example.com/v1",
      "apiKey": "{env:ESUYO_GATEWAY_API_KEY}"
    }
  }
}
```

> **Don't know your baseURL?** Ask your team or check your gateway dashboard. It always ends with `/v1`.

### Step 3 — Add your secret key

Your API key is like a password. We keep it **outside** the file so you can share the file safely.

**Windows (PowerShell) — run once, remembers forever:**
```powershell
[Environment]::SetEnvironmentVariable("ESUYO_GATEWAY_API_KEY", "sk-your-key-here", "User")
# then restart your terminal
```

**Mac / Linux — add to `~/.zshrc` or `~/.bashrc`:**
```bash
export ESUYO_GATEWAY_API_KEY="sk-your-key-here"
```

Restart your terminal after this.

### Step 4 — Check it works 🎉

```bash
opencode debug config
```

You should see a new section called `esuyo-gateway` with a list of models like `esuyo/opencode/qwen3.8-flash`. If you see that, you did it!

If not, see [“Help, it doesn’t work”](#-help-it-doesnt-work) below.

---

## 🧩 What does it actually do?

Imagine your gateway is a toy store with many toys (models). Normally you’d have to write down every toy name by hand into Opencode. This plugin is like a helper who runs to the store every time you open Opencode, writes down all the toy names for you, and hands you the list. New toys? Added. Removed toys? Gone.

You never touch the list again.

## 📁 Global vs. Project — which one?

- **Global** (`~/.config/opencode/esuyo-opencode-custom-provider.json`) — recommended. One file, works in **all** your projects. This is what we did above.
- **Project** (`YOUR_PROJECT/.opencode/esuyo-opencode-custom-provider.json`) — only for that project. If this file exists, it **wins** over the global one.

You don’t need both. Start with global.

> **Super power:** You can also set `OPENCODE_CUSTOM_PROVIDER_CONFIG` to point to any file you want. Project > Global > this env var wins above all.

## 🔧 Want more control?

You can filter models, set timeouts, or add a second gateway. It’s all optional — the simple file above is enough for 95% of people.

**Example with two gateways and filters:**

```json
{
  "defaults": {
    "npm": "@ai-sdk/openai-compatible",
    "timeoutMs": 8000
  },
  "providers": {
    "esuyo-gateway": {
      "name": "Esuyo Gateway",
      "baseURL": "https://gateway.example.com/v1",
      "apiKey": "{env:ESUYO_GATEWAY_API_KEY}",
      "include": ["^esuyo/.*"],
      "exclude": ["embedding"]
    },
    "second-gateway": {
      "name": "Second Gateway",
      "baseURL": "https://other.example.com/v1",
      "apiKey": "{env:SECOND_GATEWAY_API_KEY}"
    }
  }
}
```

See the full example at [`examples/esuyo-opencode-custom-provider.example.json`](./examples/esuyo-opencode-custom-provider.example.json).

**For grown-ups who want every option, see:**

- 📖 [Advanced Configuration](./docs/CONFIGURATION.md) — every `apiKey`, `include`, `modelDefaults` trick
- 🏗️ [Architecture](./docs/ARCHITECTURE.md) — how the magic works

## 🔄 Updating

When we release a new version, run:

```bash
opencode plugin @esuyo/esuyo-opencode-custom-provider --global --force
```

Or if that doesn’t work:

```powershell
Remove-Item -Recurse -Force "$HOME\.cache\opencode\packages" -ErrorAction SilentlyContinue
opencode debug config
```

That’s from the official docs: [opencode.ai/docs/plugins](https://opencode.ai/docs/plugins) and [opencode.ai/docs/cli#plugin](https://opencode.ai/docs/cli#plugin).

## 🆘 Help, it doesn’t work!

**1. I ran `opencode debug config` and don’t see `esuyo-gateway`:**

- Did you create the file at the *exact* path? Check for typos: `esuyo-opencode-custom-provider.json` (not `.txt`).
- Did you set the API key and **restart** your terminal? Run `$env:ESUYO_GATEWAY_API_KEY` (Windows) or `echo $ESUYO_GATEWAY_API_KEY` (Mac) to see it.
- Is your `baseURL` reachable? Try opening `https://your-gateway/v1/models` in a browser.

**2. It says `Gateway fetch failed`:**

- Your gateway might be down, or the `baseURL` is wrong (missing `/v1`).
- Your `apiKey` might be wrong. The plugin tries several env names: `ESUYO_GATEWAY_API_KEY`, then `<PROVIDER_ID>_API_KEY`. Check with `opencode --print-logs`.

**3. I see models but not the one I want:**

- Add `"include"` or remove `"exclude"` filters in your JSON.

Still stuck? Open an issue: `https://github.com/8perezm/esuyo-opencode-custom-provider/issues` — we’ll help!

---

## 👩‍💻 For Plugin Developers

You’re in the wrong place! This README is for **users**. If you want to change the plugin code itself:

- 🛠️ [Development Guide](./docs/DEVELOPMENT.md) — setup, build, local testing
- 📦 [Publishing](./docs/PUBLISHING.md) — how releases to npm work
- 🧠 [Architecture](./docs/ARCHITECTURE.md) — code walkthrough

## 📄 License

MIT — see [LICENSE](./LICENSE)
