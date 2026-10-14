import { Model, Plugin, Provider } from "@opencode/plugin"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// ---------------------------------------------------------------------------
// Esuyo Custom Provider - generic multi-gateway plugin for Opencode V2
// Reads its own JSON file and syncs each gateway on startup via
// `ctx.provider.transform`. V1 (`@opencode-ai/plugin`, `config` hook) is
// no longer supported by the Opencode V2 server, which requires a default
// export of `{ id, setup }` (or `{ id, effect }`).
// ---------------------------------------------------------------------------

const PLUGIN_ID = "esuyo-custom-provider"
const SERVICE = "opencode-custom-provider"
const DEFAULT_PACKAGE = "@opencode/ai/providers/openai-compatible"
const LEGACY_PACKAGE = "@ai-sdk/openai-compatible"
const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_MODEL_LIMIT = { context: 200000, output: 32000 }
const DEFAULT_MODALITIES = { input: ["text", "image"], output: ["text"] } as const

type RawGatewayModel = {
  id: string
  raw: Record<string, any>
}

type ModelDefaults = {
  modalities?: { input: string[]; output: string[] }
  attachment?: boolean
  limit?: { context: number; output: number; input?: number }
}

type SessionHeadersConfig = {
  enabled?: boolean
  /** Header name to inject (default "x-opencode-session" as required by OpenCode Go/Zen). */
  header?: string
  /**
   * Optional allowlist of provider IDs to inject for. Default: all providers
   * managed by this plugin. Useful to target a single gateway.
   */
  providers?: string[]
}

type ProviderEntry = {
  id?: string
  name?: string
  npm?: string
  /** V2 alias for npm. */
  package?: string
  baseURL: string
  apiKey?: string
  apiKeyEnv?: string
  timeoutMs?: number
  enabled?: boolean
  modelDefaults?: ModelDefaults
  // optional filtering by model id regex
  include?: string[]
  exclude?: string[]
  // optional static model overrides merged after discovery
  models?: Record<string, Record<string, any>>
  /**
   * Per-provider opt-out for the x-opencode-session injection
   * (default true — inherits the global sessionHeaders setting).
   * Set to false to leave this provider's headers untouched.
   */
  sendSessionHeaders?: boolean
  /** Override the injected header name for this provider only. */
  sessionHeader?: string
}

type CustomConfigFile = {
  $schema?: string
  defaults?: {
    npm?: string
    package?: string
    timeoutMs?: number
    modelDefaults?: ModelDefaults
  }
  providers?: Record<string, ProviderEntry> | ProviderEntry[]
  /**
   * Session-header injection for OpenCode Go/Zen compliance.
   * - `false` disables entirely (no x-opencode-session is added).
   * - `true` / omitted enables with defaults (all managed providers).
   * - object form allows renaming the header or restricting providers.
   */
  sessionHeaders?: boolean | SessionHeadersConfig
  // also support top-level being directly providers map/array if no wrapper
  [key: string]: any
}

const DEFAULT_SESSION_HEADER = "x-opencode-session"

// ---------------------------------------------------------------------------
// helpers (unchanged from V1 — pure Node, no Opencode API)
// ---------------------------------------------------------------------------

function humanizeModelId(id: string): string {
  const last = id.split("/").pop() ?? id
  const spaced = last.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim()
  return spaced
    .split(" ")
    .map((w) => {
      if (!w) return w
      if (/^\d/.test(w)) return w
      if (/^v\d/i.test(w)) return w.charAt(0).toUpperCase() + w.slice(1)
      if (/[A-Z]/.test(w.slice(1))) return w.charAt(0).toUpperCase() + w.slice(1)
      return w.charAt(0).toUpperCase() + w.slice(1)
    })
    .join(" ")
}

function resolveModelsUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "")
  if (!trimmed) return trimmed + "/v1/models"
  if (trimmed.endsWith("/models")) return trimmed
  if (trimmed.endsWith("/v1")) return `${trimmed}/models`
  if (trimmed.includes("/v1")) return `${trimmed}/models`
  return `${trimmed}/v1/models`
}

function toV2Package(npm: string | undefined): string {
  if (!npm || !npm.trim()) return DEFAULT_PACKAGE
  const trimmed = npm.trim()
  if (trimmed === LEGACY_PACKAGE) return DEFAULT_PACKAGE
  return trimmed
}

function resolveStringValue(
  value: string | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  if (!value || typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  // {env:VAR}
  const envMatch = trimmed.match(/^\{env:([^}]+)\}$/)
  if (envMatch) {
    const v = env[envMatch[1]] ?? process.env[envMatch[1]]
    if (v) return v.trim()
    return undefined
  }
  // {file:path} - read file contents
  const fileMatch = trimmed.match(/^\{file:([^}]+)\}$/)
  if (fileMatch) {
    // file path handling is done async elsewhere; sync fallback returns undefined
    // caller should handle {file:} via async read if needed
    return undefined
  }
  if (trimmed === "none") return undefined
  if (trimmed.startsWith("{env:") || trimmed.startsWith("{file:")) return undefined
  return trimmed
}

async function resolveStringValueAsync(
  value: string | undefined,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  if (!value || typeof value !== "string") return undefined
  const trimmed = value.trim()
  const fileMatch = trimmed.match(/^\{file:([^}]+)\}$/)
  if (fileMatch) {
    const rawPath = fileMatch[1].trim()
    try {
      // expand ~ and env
      let p = rawPath
      if (p.startsWith("~/")) p = path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", p.slice(2))
      // try read
      const data = await fs.readFile(p, "utf8")
      return data.trim()
    } catch {
      return undefined
    }
  }
  return resolveStringValue(value, env)
}

async function resolveApiKeyAsync(
  entry: ProviderEntry,
  providerSettings: Record<string, any> | undefined,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  // 1. entry.apiKey (supports {env:}, {file:})
  if (entry.apiKey) {
    const v = await resolveStringValueAsync(entry.apiKey, env)
    if (v) return v
    // if entry.apiKey is plain key without placeholder, resolveStringValue already handles
    const plain = resolveStringValue(entry.apiKey, env)
    if (plain) return plain
  }
  // 2. entry.apiKeyEnv -> env var name
  if (entry.apiKeyEnv) {
    const v = env[entry.apiKeyEnv] ?? process.env[entry.apiKeyEnv]
    if (v && v.trim() && v.trim() !== "none") return v.trim()
  }
  // 3. existing provider settings.apiKey (V2) or legacy options.apiKey (V1 fallback)
  const settingsKey = providerSettings?.apiKey ?? providerSettings?.api_key
  if (typeof settingsKey === "string" && settingsKey) {
    const v = await resolveStringValueAsync(settingsKey, env)
    if (v) return v
    const plain = resolveStringValue(settingsKey, env)
    if (plain) return plain
  }
  // 4. common env fallbacks per provider id
  const upperId = (entry.id ?? "").replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()
  const candidates = [
    env[`${upperId}_API_KEY`],
    env[`${upperId}_TOKEN`],
    process.env[`${upperId}_API_KEY`],
    process.env[`${upperId}_TOKEN`],
    // generic esuyo fallback for migration
    env["ESUYO_GATEWAY_API_KEY"],
    env["ESUYO_API_KEY"],
    process.env["ESUYO_GATEWAY_API_KEY"],
    process.env["ESUYO_API_KEY"],
  ]
  for (const c of candidates) if (c && c.trim() && c.trim() !== "none") return c.trim()
  return undefined
}

function stripJsonComments(text: string): string {
  // remove // line comments and /* block */ comments, but preserve strings
  // naive but works for config files without tricky strings containing //
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
}

function normalizeProviders(
  raw: CustomConfigFile,
  defaults: CustomConfigFile["defaults"],
): Record<string, ProviderEntry> {
  const out: Record<string, ProviderEntry> = {}

  // Determine providers source
  let providersRaw: any = raw.providers

  // Support file being directly a providers map without wrapper: { "esuyo-gateway": {baseURL...}}
  if (!providersRaw) {
    // if raw has no providers key but looks like a map of provider entries (has baseURL)
    const keys = Object.keys(raw).filter((k) => !k.startsWith("$") && k !== "defaults" && k !== "sessionHeaders")
    const maybeMap = keys.some((k) => {
      const v = (raw as any)[k]
      return v && typeof v === "object" && typeof v.baseURL === "string"
    })
    if (maybeMap) {
      providersRaw = {}
      for (const k of keys) (providersRaw as any)[k] = (raw as any)[k]
    } else if (Array.isArray(raw)) {
      providersRaw = raw
    }
  }

  if (!providersRaw) return out

  const applyDefaults = (entry: ProviderEntry): ProviderEntry => ({
    ...entry,
    npm: entry.npm ?? entry.package ?? defaults?.npm ?? defaults?.package,
    timeoutMs: entry.timeoutMs ?? defaults?.timeoutMs,
    modelDefaults: entry.modelDefaults ?? defaults?.modelDefaults,
  })

  if (Array.isArray(providersRaw)) {
    for (const entry of providersRaw) {
      if (!entry || typeof entry !== "object" || typeof entry.baseURL !== "string") continue
      const id = (entry.id ?? (entry as any).providerId ?? "").trim()
      if (!id) continue
      out[id] = applyDefaults({
        id,
        name: entry.name,
        npm: entry.npm ?? (entry as any).package,
        package: (entry as any).package ?? entry.npm,
        baseURL: entry.baseURL,
        apiKey: entry.apiKey,
        apiKeyEnv: entry.apiKeyEnv,
        timeoutMs: entry.timeoutMs,
        enabled: entry.enabled,
        modelDefaults: entry.modelDefaults,
        include: entry.include,
        exclude: entry.exclude,
        models: entry.models,
        sendSessionHeaders: (entry as any).sendSessionHeaders,
        sessionHeader: (entry as any).sessionHeader,
      })
    }
  } else if (typeof providersRaw === "object") {
    for (const [key, val] of Object.entries(providersRaw as Record<string, any>)) {
      if (!val || typeof val !== "object") continue
      const entry = val as ProviderEntry
      if (typeof entry.baseURL !== "string" || !entry.baseURL.trim()) {
        // allow entry being just baseURL string?
        if (typeof val === "string") {
          out[key] = applyDefaults({ id: key, baseURL: val } as ProviderEntry)
          continue
        }
        continue
      }
      out[key] = applyDefaults({
        id: key,
        name: entry.name,
        npm: entry.npm ?? entry.package,
        package: entry.package ?? entry.npm,
        baseURL: entry.baseURL,
        apiKey: entry.apiKey,
        apiKeyEnv: entry.apiKeyEnv,
        timeoutMs: entry.timeoutMs,
        enabled: entry.enabled,
        modelDefaults: entry.modelDefaults,
        include: entry.include,
        exclude: entry.exclude,
        models: entry.models,
        sendSessionHeaders: entry.sendSessionHeaders,
        sessionHeader: entry.sessionHeader,
      })
    }
  }

  // apply defaults where missing
  for (const [id, e] of Object.entries(out)) {
    const npm = e.npm ?? e.package ?? defaults?.npm ?? defaults?.package
    if (npm) {
      e.npm = npm
      e.package = npm
    }
    if (!e.timeoutMs && defaults?.timeoutMs) e.timeoutMs = defaults.timeoutMs
    if (!e.modelDefaults && defaults?.modelDefaults) e.modelDefaults = defaults.modelDefaults
    if (!e.id) e.id = id
  }

  return out
}

type LogFn = (level: "debug" | "info" | "warn" | "error", msg: string, extra?: any) => void

function consoleLog(level: "debug" | "info" | "warn" | "error", msg: string, extra?: any): void {
  const prefix = `[${SERVICE}]`
  if (extra !== undefined) {
    if (level === "error") console.error(prefix, msg, extra)
    else if (level === "warn") console.warn(prefix, msg, extra)
    else if (level === "debug") console.debug(prefix, msg, extra)
    else console.log(prefix, msg, extra)
  } else {
    if (level === "error") console.error(prefix, msg)
    else if (level === "warn") console.warn(prefix, msg)
    else if (level === "debug") console.debug(prefix, msg)
    else console.log(prefix, msg)
  }
}

async function loadCustomConfig(
  directories: string[],
  env: Record<string, string | undefined>,
  log: LogFn,
): Promise<{ config: Record<string, ProviderEntry>; path: string | undefined; raw: CustomConfigFile | undefined }> {
  const candidates: string[] = []

  // env override (highest priority)
  const envPath = env["OPENCODE_CUSTOM_PROVIDER_CONFIG"] ?? process.env["OPENCODE_CUSTOM_PROVIDER_CONFIG"]
  if (envPath) candidates.push(envPath)

  const projectFiles = [
    ".opencode/esuyo-opencode-custom-provider.json",
    ".opencode/esuyo-opencode-custom-provider.jsonc",
    ".opencode/opencode-custom-provider.json",
    ".opencode/opencode-custom-provider.jsonc",
    ".opencode/custom-providers.json",
    ".opencode/custom-providers.jsonc",
    "esuyo-opencode-custom-provider.json",
    "opencode-custom-provider.json",
    "opencode-custom-provider.jsonc",
  ]
  for (const dir of directories) {
    if (!dir) continue
    for (const rel of projectFiles) candidates.push(path.join(dir, rel))
  }

  // global fallback: ~/.config/opencode/esuyo-opencode-custom-provider.json (and variants)
  // checked after project-level files so project overrides global
  try {
    const home = os.homedir()
    const xdg = process.env.XDG_CONFIG_HOME
    const globalBase = xdg ? path.join(xdg, "opencode") : path.join(home, ".config", "opencode")
    if (home || xdg) {
      candidates.push(
        path.join(globalBase, "esuyo-opencode-custom-provider.json"),
        path.join(globalBase, "esuyo-opencode-custom-provider.jsonc"),
        path.join(globalBase, "opencode-custom-provider.json"),
        path.join(globalBase, "opencode-custom-provider.jsonc"),
        path.join(globalBase, "custom-providers.json"),
        path.join(globalBase, "custom-providers.jsonc"),
      )
      // Windows also checks %APPDATA%\opencode if different from ~/.config/opencode
      const appData = process.env.APPDATA
      if (appData) {
        const winBase = path.join(appData, "opencode")
        if (winBase !== globalBase) {
          candidates.push(
            path.join(winBase, "esuyo-opencode-custom-provider.json"),
            path.join(winBase, "esuyo-opencode-custom-provider.jsonc"),
          )
        }
      }
    }
  } catch {}

  for (const p of candidates) {
    try {
      const text = await fs.readFile(p, "utf8")
      let json: CustomConfigFile
      try {
        json = JSON.parse(text)
      } catch {
        json = JSON.parse(stripJsonComments(text))
      }
      log("info", `Loaded custom provider config`, { path: p })
      const defaults = (json as any).defaults
      const providers = normalizeProviders(json, defaults)
      if (Object.keys(providers).length === 0) {
        log("warn", `Custom provider config at ${p} has no providers`, { path: p })
      }
      return { config: providers, path: p, raw: json }
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        log("warn", `Failed to read custom provider config at ${p}: ${err?.message}`, { path: p })
      }
    }
  }

  log("info", `No custom provider config found - will fallback to existing providers with baseURL if any`)
  return { config: {}, path: undefined, raw: undefined }
}

// ---------------------------------------------------------------------------
// V2 model building: V1 `{ name, modalities, attachment, limit }` becomes
// V2 `Model.Info` `{ name, capabilities, limit }`.
// ---------------------------------------------------------------------------

function applyModelDefaultsToInfo(
  info: Record<string, any>,
  defaults: ModelDefaults | undefined,
): void {
  if (!defaults) return
  info.capabilities = info.capabilities ?? { tools: true, input: ["text", "image"], output: ["text"] }
  if (defaults.modalities) {
    if (Array.isArray(defaults.modalities.input)) info.capabilities.input = [...defaults.modalities.input]
    if (Array.isArray(defaults.modalities.output)) info.capabilities.output = [...defaults.modalities.output]
  }
  if (typeof defaults.attachment === "boolean") info.capabilities.tools = defaults.attachment
  if (defaults.limit) {
    info.limit = info.limit ?? {}
    if (typeof defaults.limit.context === "number" && defaults.limit.context > 0)
      info.limit.context = defaults.limit.context
    if (typeof defaults.limit.output === "number" && defaults.limit.output > 0)
      info.limit.output = defaults.limit.output
    if (typeof defaults.limit.input === "number" && defaults.limit.input > 0)
      info.limit.input = defaults.limit.input
  }
}

function applyStaticOverrideToInfo(info: Record<string, any>, override: Record<string, any>): void {
  if (!override || typeof override !== "object") return
  if (typeof override.name === "string" && override.name.trim()) info.name = override.name.trim()
  if (typeof override.modelID === "string" && override.modelID.trim()) info.modelID = override.modelID.trim()
  // V1 static shape: { name, limit, modalities, attachment }
  const limit = override.limit
  if (limit && typeof limit === "object") {
    info.limit = info.limit ?? {}
    if (typeof limit.context === "number" && limit.context > 0) info.limit.context = limit.context
    if (typeof limit.output === "number" && limit.output > 0) info.limit.output = limit.output
    if (typeof limit.input === "number" && limit.input > 0) info.limit.input = limit.input
  }
  const modalities = override.modalities ?? override.capabilities
  if (modalities && typeof modalities === "object") {
    info.capabilities = info.capabilities ?? { tools: true, input: ["text"], output: ["text"] }
    if (Array.isArray((modalities as any).input)) info.capabilities.input = [...(modalities as any).input]
    if (Array.isArray((modalities as any).output)) info.capabilities.output = [...(modalities as any).output]
    if (typeof (modalities as any).tools === "boolean") info.capabilities.tools = (modalities as any).tools
  }
  if (typeof override.attachment === "boolean") {
    info.capabilities = info.capabilities ?? { tools: true, input: ["text"], output: ["text"] }
    info.capabilities.tools = override.attachment
  }
  if (typeof override.tools === "boolean") {
    info.capabilities = info.capabilities ?? { tools: true, input: ["text"], output: ["text"] }
    info.capabilities.tools = override.tools
  }
  // V2 passthrough fields
  for (const key of ["capabilities", "headers", "body", "settings", "cost", "status", "enabled", "family", "compatibility"]) {
    if (override[key] !== undefined) info[key] = override[key]
  }
}

function buildModelInfo(
  providerID: string,
  id: string,
  raw: Record<string, any> | undefined,
  staticOverride: Record<string, any> | undefined,
  defaults: ModelDefaults | undefined,
): Record<string, any> {
  // Model.Info.default(providerID, modelID) provides V2 defaults
  // (capabilities.tools=true, input [text,image], limit 200k/32k).
  let base: Record<string, any>
  try {
    const pid: any = (Provider as any).ID ? (Provider as any).ID.make(providerID) : providerID
    const mid: any = (Model as any).ID ? (Model as any).ID.make(id) : id
    base = { ...(Model as any).Info.default(pid, mid) }
  } catch {
    base = {
      id,
      modelID: id,
      providerID,
      name: humanizeModelId(id),
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      limit: { ...DEFAULT_MODEL_LIMIT },
      enabled: true,
      status: "active",
    }
  }

  // Ensure plain-string IDs survive Effect branding at runtime.
  base.id = id
  base.modelID = base.modelID ?? id
  base.providerID = providerID
  if (!base.name || base.name === id) base.name = humanizeModelId(id)

  // Gateway-advertised metadata refines the defaults.
  if (raw) {
    if (typeof raw.display_name === "string" && raw.display_name.trim()) base.name = raw.display_name.trim()
    else if (typeof raw.name === "string" && raw.name.trim() && raw.name !== id) base.name = raw.name.trim()
    else base.name = humanizeModelId(id)
    const ctxVal = raw.context_length ?? raw.contextLength ?? raw.limit?.context ?? raw.max_context
    if (typeof ctxVal === "number" && ctxVal > 0) {
      base.limit = base.limit ?? {}
      base.limit.context = ctxVal
    }
    const outVal = raw.max_output_tokens ?? raw.maxOutputTokens ?? raw.limit?.output ?? raw.max_tokens
    if (typeof outVal === "number" && outVal > 0) {
      base.limit = base.limit ?? {}
      base.limit.output = outVal
    }
    if (typeof raw.supports_vision === "boolean" || typeof raw.supportsImage === "boolean") {
      const vision = raw.supports_vision ?? raw.supportsImage
      base.capabilities = base.capabilities ?? { tools: true, input: ["text"], output: ["text"] }
      const input = new Set<string>(base.capabilities.input ?? ["text"])
      if (vision) input.add("image")
      else input.delete("image")
      base.capabilities.input = Array.from(input)
    }
  }

  applyModelDefaultsToInfo(base, defaults)
  if (staticOverride) applyStaticOverrideToInfo(base, staticOverride)

  // Keep capabilities/limit shapes the V2 registry expects.
  base.capabilities = base.capabilities ?? { tools: true, input: [...DEFAULT_MODALITIES.input], output: [...DEFAULT_MODALITIES.output] }
  base.limit = base.limit ?? { ...DEFAULT_MODEL_LIMIT }
  if (typeof base.enabled !== "boolean") base.enabled = true

  return base
}

async function fetchGatewayModels(
  baseURL: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<RawGatewayModel[]> {
  const url = resolveModelsUrl(baseURL)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    }
    if (apiKey && apiKey !== "none" && apiKey !== "") {
      headers["Authorization"] = `Bearer ${apiKey}`
      headers["x-api-key"] = apiKey
    }
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`Gateway ${url} responded ${res.status} ${res.statusText} ${text.slice(0, 500)}`)
    }
    const json: any = await res.json().catch(async () => {
      const t = await res.text()
      throw new Error(`Invalid JSON from ${url}: ${t.slice(0, 500)}`)
    })
    let list: any[] = []
    if (Array.isArray(json)) list = json
    else if (Array.isArray(json.data)) list = json.data
    else if (Array.isArray(json.models)) list = json.models
    else if (json.data && typeof json.data === "object") list = Object.values(json.data)
    else throw new Error(`Unexpected models response shape from ${url}: ${JSON.stringify(json).slice(0, 500)}`)
    const out: RawGatewayModel[] = []
    for (const entry of list) {
      let id: string | undefined
      let raw: Record<string, any> = {}
      if (typeof entry === "string") { id = entry; raw = { id } }
      else if (entry && typeof entry === "object") { id = entry.id ?? entry.model ?? entry.name; raw = entry as Record<string, any> }
      if (!id || typeof id !== "string" || !id.trim()) continue
      out.push({ id: id.trim(), raw })
    }
    const seen = new Set<string>()
    const deduped: RawGatewayModel[] = []
    for (const m of out) if (!seen.has(m.id)) { seen.add(m.id); deduped.push(m) }
    return deduped
  } finally {
    clearTimeout(timer)
  }
}

function filterModels(
  models: RawGatewayModel[],
  include?: string[],
  exclude?: string[],
): RawGatewayModel[] {
  let out = models
  if (include && include.length > 0) {
    const regs = include.map((s) => new RegExp(s))
    out = out.filter((m) => regs.some((r) => r.test(m.id)))
  }
  if (exclude && exclude.length > 0) {
    const regs = exclude.map((s) => new RegExp(s))
    out = out.filter((m) => !regs.some((r) => r.test(m.id)))
  }
  return out
}

// ---------------------------------------------------------------------------
// V2 plugin definition. The default export MUST be `{ id, setup }` — the V2
// server rejects the V1 function shape with:
// "Plugin must export a default definition with an id and an effect or setup
// function."
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const log: LogFn = (level, msg, extra) => consoleLog(level, msg, extra)

    const rawDirs = [
      (ctx.location as any)?.project?.directory,
      (ctx.location as any)?.project?.canonical,
      (ctx.location as any)?.directory,
    ].filter((d) => typeof d === "string" && d.length > 0) as string[]
    const directories = [...new Set(rawDirs)]
    const displayDir = directories[0] ?? process.cwd()

    // per-baseURL discovery cache (30s, same as V1)
    const cache = new Map<string, { models: RawGatewayModel[]; at: number }>()

    async function getDiscoveredModels(baseURL: string, apiKey: string | undefined, timeoutMs: number): Promise<RawGatewayModel[]> {
      const now = Date.now()
      const hit = cache.get(baseURL)
      if (hit && now - hit.at < 30_000) return hit.models
      const models = await fetchGatewayModels(baseURL, apiKey, timeoutMs)
      cache.set(baseURL, { models, at: now })
      return models
    }

    // -----------------------------------------------------------------------
    // x-opencode-session injection state (OpenCode Go/Zen compliance)
    // -----------------------------------------------------------------------
    const managedProviderIds = new Set<string>()
    let sessionHeadersEnabled = true
    let sessionHeaderName = DEFAULT_SESSION_HEADER
    let sessionHeaderAllowlist: Set<string> | null = null
    const perProviderSessionOpts = new Map<string, { enabled: boolean; header?: string }>()

    function applySessionHeadersConfig(raw: CustomConfigFile | undefined): void {
      const cfg = raw?.sessionHeaders
      sessionHeadersEnabled = true
      sessionHeaderName = DEFAULT_SESSION_HEADER
      sessionHeaderAllowlist = null
      if (cfg === false) {
        sessionHeadersEnabled = false
        return
      }
      if (cfg === true || cfg === undefined) return
      if (typeof cfg === "object" && cfg !== null) {
        if ((cfg as SessionHeadersConfig).enabled === false) {
          sessionHeadersEnabled = false
          return
        }
        const header = (cfg as SessionHeadersConfig).header
        if (typeof header === "string" && header.trim()) sessionHeaderName = header.trim()
        const providers = (cfg as SessionHeadersConfig).providers
        if (Array.isArray(providers) && providers.length > 0) {
          sessionHeaderAllowlist = new Set(providers.filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim()))
        }
      }
    }

    try {
      log("info", `Opencode Custom Provider (V2) startup - loading custom config`, { directory: displayDir })
      const env: Record<string, string | undefined> = (typeof process !== "undefined" ? (process.env as any) : {}) as any

      const { config: providersFromFile, path: configPath, raw: rawJson } = await loadCustomConfig(directories, env, log)
      applySessionHeadersConfig(rawJson)

      // Fallback: if no custom config, sync existing providers that already
      // expose a baseURL in settings (keeps backward compat with providers
      // hard-coded in opencode.jsonc). V2 providers live in the provider
      // registry — not in a mutable `config.provider` object.
      let providerEntries: Record<string, ProviderEntry> = providersFromFile
      if (Object.keys(providerEntries).length === 0) {
        log("info", "No custom providers - checking existing providers with baseURL for backward compat")
        try {
          const listResult: any = await (ctx.provider as any).list()
          const arr: any[] = Array.isArray(listResult) ? listResult : (listResult?.data ?? [])
          for (const item of arr) {
            const info = item?.provider ?? item
            const id = info?.id
            const baseURL = info?.settings?.baseURL
            if (typeof id === "string" && id && typeof baseURL === "string" && baseURL.trim()) {
              providerEntries[id] = {
                id,
                name: info?.name,
                npm: info?.package,
                package: info?.package,
                baseURL: baseURL.trim(),
                apiKey: typeof info?.settings?.apiKey === "string" ? info.settings.apiKey : undefined,
                enabled: true,
              }
            }
          }
          if (Object.keys(providerEntries).length > 0) {
            log("info", `Fallback discovered ${Object.keys(providerEntries).length} providers from registry`, {
              providers: Object.keys(providerEntries),
            })
          } else {
            log("warn", "No providers to sync - create .opencode/esuyo-opencode-custom-provider.json")
          }
        } catch (err: any) {
          log("warn", `Provider fallback list failed: ${err?.message ?? String(err)}`)
        }
        if (Object.keys(providerEntries).length === 0) {
          // Still register the session hook so headers work for manually
          // configured providers, then exit early.
          await ctx.session.hook("model.request", (event: any) => {
            try {
              if (!sessionHeadersEnabled) return
              const sessionID = event?.sessionID
              if (typeof sessionID !== "string" || !sessionID) return
              const providerID = event?.model?.providerID
              if (typeof providerID !== "string" || !providerID) return
              if (providerID.startsWith("opencode")) return
              if (sessionHeaderAllowlist && !sessionHeaderAllowlist.has(providerID)) return
              if (!sessionHeaderAllowlist && !managedProviderIds.has(providerID)) return
              const perProvider = perProviderSessionOpts.get(providerID)
              if (perProvider && perProvider.enabled === false) return
              const headerName = perProvider?.header || sessionHeaderName || DEFAULT_SESSION_HEADER
              event.headers[headerName] = sessionID
            } catch {}
          })
          return
        }
      }

      // Seed per-provider session-header opts before any hook can run.
      perProviderSessionOpts.clear()
      managedProviderIds.clear()
      for (const [pid, pentry] of Object.entries(providerEntries)) {
        perProviderSessionOpts.set(pid, {
          enabled: (pentry as ProviderEntry).sendSessionHeaders !== false,
          header: typeof (pentry as ProviderEntry).sessionHeader === "string" && (pentry as ProviderEntry).sessionHeader!.trim()
            ? (pentry as ProviderEntry).sessionHeader!.trim()
            : undefined,
        })
        managedProviderIds.add(pid)
      }

      // Gateway discovery is network I/O and must NOT block setup:
      // locations fail to activate if a plugin's setup is slow
      // ("Location plugins did not finish activating"). Register the
      // transform + hook immediately, sync in the background, then reload.
      type SyncedProvider = { info: Record<string, any>; models: Record<string, any>[] }
      const source: { providers: SyncedProvider[] } = { providers: [] }

      const syncOne = async ([providerId, entry]: [string, ProviderEntry]): Promise<void> => {
        const enabled = entry.enabled !== false
        if (!enabled) {
          log("info", `Provider ${providerId} disabled via custom config, skipping`, { providerId, configPath })
          return
        }

        const rawPackage = entry.package ?? entry.npm
        const pkg = toV2Package(rawPackage)
        const name = entry.name ?? providerId
        const baseURL = entry.baseURL
        const timeoutMs = entry.timeoutMs ?? DEFAULT_TIMEOUT_MS

        let apiKey = await resolveApiKeyAsync(entry, undefined, env)
        if (!apiKey) {
          // Reuse apiKey from another entry with the same baseURL.
          for (const [otherId, otherEntry] of Object.entries(providerEntries)) {
            if (otherId === providerId) continue
            if (otherEntry.baseURL === baseURL && typeof otherEntry.apiKey === "string" && otherEntry.apiKey.trim() && otherEntry.apiKey.trim() !== "none") {
              const v = (await resolveStringValueAsync(otherEntry.apiKey, env)) ?? resolveStringValue(otherEntry.apiKey, env)
              if (v) {
                apiKey = v
                log("info", `Using fallback apiKey from ${otherId} for ${providerId} (same baseURL)`, { providerId, fallback: otherId })
                break
              }
            }
          }
        }
        if (!apiKey) {
          log("warn", `No apiKey for ${providerId} - attempting unauthenticated`, {
            providerId,
            baseURL,
            hint: `Set apiKey or apiKeyEnv in custom config or ${providerId.toUpperCase()}_API_KEY env`,
          })
        }

        const modelsUrl = resolveModelsUrl(baseURL)
        log("info", `Fetching models for ${providerId}`, { providerId, baseURL: modelsUrl, timeoutMs })

        let discovered: RawGatewayModel[]
        try {
          discovered = await getDiscoveredModels(baseURL, apiKey, timeoutMs)
        } catch (err: any) {
          const msg = err?.message ?? String(err)
          log("warn", `Gateway fetch failed for ${providerId}, skipping sync`, { providerId, baseURL, error: msg })
          return
        }

        const filtered = filterModels(discovered, entry.include, entry.exclude)
        if (filtered.length !== discovered.length) {
          log("info", `Filtered ${providerId}: ${discovered.length} -> ${filtered.length}`, {
            providerId,
            include: entry.include,
            exclude: entry.exclude,
          })
        }
        discovered = filtered

        if (discovered.length === 0) {
          log("warn", `Gateway returned 0 models for ${providerId}, skipping sync`, { providerId })
          return
        }

        log("info", `Discovered ${discovered.length} models for ${providerId}`, {
          providerId,
          sample: discovered.slice(0, 3).map((m) => m.id),
        })

        const models: Record<string, any>[] = []
        for (const { id, raw } of discovered) {
          const staticOverride = entry.models?.[id]
          models.push(buildModelInfo(providerId, id, raw, staticOverride, entry.modelDefaults))
        }

        // Preserve explicitly configured static models absent from the gateway.
        if (entry.models) {
          const seen = new Set(models.map((m) => m.id))
          for (const [mid, mcfg] of Object.entries(entry.models)) {
            if (!seen.has(mid)) {
              models.push(buildModelInfo(providerId, mid, undefined, mcfg, entry.modelDefaults))
              log("info", `Keeping static model ${mid} for ${providerId} not in gateway`, { providerId, modelId: mid })
            }
          }
        }

        // Build the V2 provider info. settings carries the runtime options
        // (baseURL + apiKey) for `@opencode/ai/providers/openai-compatible`.
        let providerInfo: Record<string, any>
        try {
          const pid: any = (Provider as any).ID.make(providerId)
          providerInfo = { ...(Provider as any).Info.empty(pid) }
        } catch {
          providerInfo = { id: providerId, name: providerId, activation: "auto", package: "" }
        }
        providerInfo.id = providerId
        providerInfo.name = name
        providerInfo.activation = "enabled"
        providerInfo.package = pkg
        providerInfo.settings = { ...(providerInfo.settings ?? {}), baseURL }
        if (apiKey) providerInfo.settings.apiKey = apiKey

        source.providers.push({ info: providerInfo, models })
        log("info", `Provider ${providerId} models prepared`, { providerId, total: models.length })
      }

      const applySource = (editor: any) => {
        for (const { info, models } of source.providers) {
          const existing = editor.get(info.id)
          if (existing) {
            editor.update(info.id, (provider: any) => {
              provider.name = info.name
              provider.package = info.package
              provider.activation = info.activation
              provider.settings = { ...(provider.settings ?? {}), ...info.settings }
            })
            editor.models.set(info.id, models)
          } else {
            editor.add({ info, models })
          }
        }
      }

      // Register first (fast, non-blocking): replays `source` on every reload.
      await ctx.provider.transform(applySource)

      // Session-header backfill (V1 `chat.headers` -> V2 `model.request`).
      await ctx.session.hook("model.request", (event: any) => {
        try {
          if (!sessionHeadersEnabled) return
          const sessionID = event?.sessionID
          if (typeof sessionID !== "string" || !sessionID) return
          const providerID = event?.model?.providerID
          if (typeof providerID !== "string" || !providerID) return
          // Core already sends x-opencode-session for first-party opencode providers.
          if (providerID.startsWith("opencode")) return
          if (sessionHeaderAllowlist && !sessionHeaderAllowlist.has(providerID)) return
          // Default scope: only providers managed by this plugin.
          if (!sessionHeaderAllowlist && !managedProviderIds.has(providerID)) return
          const perProvider = perProviderSessionOpts.get(providerID)
          if (perProvider && perProvider.enabled === false) return
          const headerName = perProvider?.header || sessionHeaderName || DEFAULT_SESSION_HEADER
          event.headers[headerName] = sessionID
        } catch {
          // header injection must never break the request
        }
      })

      // Background sync: fetch gateway inventories, then reload the provider
      // registry so the transform above replays with real data. Floating
      // promise — never blocks setup, never throws (all errors are logged).
      void (async () => {
        try {
          await Promise.allSettled(Object.entries(providerEntries).map(syncOne))
          const synced = source.providers
          if (synced.length === 0) {
            log("warn", "Opencode Custom Provider sync produced no providers (all fetches failed or filtered out)")
            return
          }
          await ctx.provider.reload()
          log("info", "Opencode Custom Provider sync complete", { providers: synced.map((s) => s.info.id) })
        } catch (err: any) {
          log("error", `Background sync failed: ${err?.message ?? String(err)}`)
        }
      })()
    } catch (err: any) {
      log("error", `Unexpected error: ${err?.message ?? String(err)}`, { error: String(err?.stack ?? err) })
    }
  },
})
