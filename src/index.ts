import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// ---------------------------------------------------------------------------
// Opencode Custom Provider - generic multi-gateway plugin for 1.18.25
// Reads its own JSON file and syncs each gateway on startup via `config` hook
// ---------------------------------------------------------------------------

const SERVICE = "opencode-custom-provider"
const DEFAULT_NPM = "@ai-sdk/openai-compatible"
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
// helpers
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
  providerOptions: Record<string, any> | undefined,
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
  // 3. providerOptions.apiKey (opencode.json fallback, already resolved by opencode env substitution but handle placeholder)
  if (providerOptions?.apiKey) {
    const v = await resolveStringValueAsync(providerOptions.apiKey as string, env)
    if (v) return v
    const plain = resolveStringValue(providerOptions.apiKey as string, env)
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
    const keys = Object.keys(raw).filter((k) => !k.startsWith("$") && k !== "defaults")
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

  if (Array.isArray(providersRaw)) {
    for (const entry of providersRaw) {
      if (!entry || typeof entry !== "object" || typeof entry.baseURL !== "string") continue
      const id = (entry.id ?? entry.providerId ?? "").trim()
      if (!id) continue
      out[id] = {
        id,
        name: entry.name,
        npm: entry.npm ?? defaults?.npm,
        baseURL: entry.baseURL,
        apiKey: entry.apiKey,
        apiKeyEnv: entry.apiKeyEnv,
        timeoutMs: entry.timeoutMs ?? defaults?.timeoutMs,
        enabled: entry.enabled,
        modelDefaults: entry.modelDefaults ?? defaults?.modelDefaults,
        include: entry.include,
        exclude: entry.exclude,
        models: entry.models,
      }
    }
  } else if (typeof providersRaw === "object") {
    for (const [key, val] of Object.entries(providersRaw as Record<string, any>)) {
      if (!val || typeof val !== "object") continue
      const entry = val as ProviderEntry
      if (typeof entry.baseURL !== "string" || !entry.baseURL.trim()) {
        // allow entry being just baseURL string?
        if (typeof val === "string") {
          out[key] = { id: key, baseURL: val, npm: defaults?.npm, timeoutMs: defaults?.timeoutMs, modelDefaults: defaults?.modelDefaults }
          continue
        }
        continue
      }
      out[key] = {
        id: key,
        name: entry.name,
        npm: entry.npm ?? defaults?.npm,
        baseURL: entry.baseURL,
        apiKey: entry.apiKey,
        apiKeyEnv: entry.apiKeyEnv,
        timeoutMs: entry.timeoutMs ?? defaults?.timeoutMs,
        enabled: entry.enabled,
        modelDefaults: entry.modelDefaults ?? defaults?.modelDefaults,
        include: entry.include,
        exclude: entry.exclude,
        models: entry.models,
      }
    }
  }

  // apply defaults where missing
  for (const [id, e] of Object.entries(out)) {
    if (!e.npm && defaults?.npm) e.npm = defaults.npm
    if (!e.timeoutMs && defaults?.timeoutMs) e.timeoutMs = defaults.timeoutMs
    if (!e.modelDefaults && defaults?.modelDefaults) e.modelDefaults = defaults.modelDefaults
    if (!e.id) e.id = id
  }

  return out
}

async function loadCustomConfig(
  directory: string,
  env: Record<string, string | undefined>,
  log: (level: "debug" | "info" | "warn" | "error", msg: string, extra?: any) => Promise<void>,
): Promise<{ config: Record<string, ProviderEntry>; path: string | undefined; raw: CustomConfigFile | undefined }> {
  const candidates = [
    path.join(directory, ".opencode", "esuyo-opencode-custom-provider.json"),
    path.join(directory, ".opencode", "esuyo-opencode-custom-provider.jsonc"),
    path.join(directory, ".opencode", "opencode-custom-provider.json"),
    path.join(directory, ".opencode", "opencode-custom-provider.jsonc"),
    path.join(directory, ".opencode", "custom-providers.json"),
    path.join(directory, ".opencode", "custom-providers.jsonc"),
    path.join(directory, "esuyo-opencode-custom-provider.json"),
    path.join(directory, "opencode-custom-provider.json"),
    path.join(directory, "opencode-custom-provider.jsonc"),
  ]

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

  // env override (highest priority)
  const envPath = env["OPENCODE_CUSTOM_PROVIDER_CONFIG"] ?? process.env["OPENCODE_CUSTOM_PROVIDER_CONFIG"]
  if (envPath) candidates.unshift(envPath)

  for (const p of candidates) {
    try {
      const text = await fs.readFile(p, "utf8")
      let json: CustomConfigFile
      try {
        json = JSON.parse(text)
      } catch {
        json = JSON.parse(stripJsonComments(text))
      }
      await log("info", `Loaded custom provider config`, { path: p, providers: Object.keys((json as any).providers ?? json).length })
      const defaults = (json as any).defaults
      const providers = normalizeProviders(json, defaults)
      if (Object.keys(providers).length === 0) {
        await log("warn", `Custom provider config at ${p} has no providers`, { path: p })
      }
      return { config: providers, path: p, raw: json }
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        await log("warn", `Failed to read custom provider config at ${p}: ${err?.message}`, { path: p })
      }
    }
  }

  await log("info", `No custom provider config found, checked ${candidates.join(", ")} - will fallback to opencode.json providers if any have baseURL`)
  return { config: {}, path: undefined, raw: undefined }
}

function buildModelConfig(
  id: string,
  existing: Record<string, any> | undefined,
  raw: Record<string, any> | undefined,
  defaults: ModelDefaults | undefined,
) {
  const defaultModalities = defaults?.modalities ?? DEFAULT_MODALITIES
  const defaultLimit = defaults?.limit ?? DEFAULT_MODEL_LIMIT
  const defaultAttachment = defaults?.attachment ?? true

  if (existing) {
    const merged: Record<string, any> = { ...existing }
    if (raw) {
      const ctx = raw.context_length ?? raw.contextLength ?? raw.max_context ?? raw.limit?.context
      if (typeof ctx === "number" && ctx > 0) merged.limit = { ...(merged.limit ?? {}), context: ctx }
      const out = raw.max_output_tokens ?? raw.maxOutputTokens ?? raw.limit?.output ?? raw.output_length
      if (typeof out === "number" && out > 0) merged.limit = { ...(merged.limit ?? {}), output: out }
      if (typeof raw.supports_vision === "boolean" || typeof raw.supportsImage === "boolean") {
        const vision = raw.supports_vision ?? raw.supportsImage
        merged.modalities = merged.modalities ?? { input: ["text"], output: ["text"] }
        const input = new Set<string>(merged.modalities.input ?? ["text"])
        if (vision) input.add("image")
        merged.modalities.input = Array.from(input)
      }
    }
    return merged
  }

  const name = humanizeModelId(id)
  const cfg: Record<string, any> = {
    name,
    modalities: { ...defaultModalities, input: [...(defaultModalities.input as any)], output: [...(defaultModalities.output as any)] },
    attachment: defaultAttachment,
    limit: { ...defaultLimit },
  }

  if (raw) {
    if (typeof raw.display_name === "string" && raw.display_name.trim()) cfg.name = raw.display_name.trim()
    else if (typeof raw.name === "string" && raw.name.trim() && raw.name !== id) cfg.name = raw.name.trim()
    const ctx = raw.context_length ?? raw.contextLength ?? raw.limit?.context ?? raw.max_context
    if (typeof ctx === "number" && ctx > 0) cfg.limit.context = ctx
    const out = raw.max_output_tokens ?? raw.maxOutputTokens ?? raw.limit?.output ?? raw.max_tokens
    if (typeof out === "number" && out > 0) cfg.limit.output = out
  }

  // apply defaults override for known tiny models if defaults not specific
  return cfg
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

export const OpencodeCustomProviderPlugin: Plugin = async ({ client, directory }) => {
  const log = async (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, any>) => {
    try {
      await client.app.log({ body: { service: SERVICE, level, message, extra: { directory, ...extra } } })
    } catch {}
  }

  // per-baseURL cache
  const cache = new Map<string, { models: RawGatewayModel[]; at: number }>()

  async function getDiscoveredModels(baseURL: string, apiKey: string | undefined, timeoutMs: number): Promise<RawGatewayModel[]> {
    const now = Date.now()
    const hit = cache.get(baseURL)
    if (hit && now - hit.at < 30_000) return hit.models
    const models = await fetchGatewayModels(baseURL, apiKey, timeoutMs)
    cache.set(baseURL, { models, at: now })
    return models
  }

  // ---------------------------------------------------------------------------
  // x-opencode-session injection state (OpenCode Go/Zen compliance)
  // Opencode core only sends x-opencode-session for providerIDs starting with
  // "opencode"; custom gateways get x-session-affinity/X-Session-Id instead.
  // The chat.headers hook below backfills x-opencode-session with the current
  // opencode sessionID so gateways proxying to Go stay compliant after 09/06.
  // Populated by the config hook; read by the chat.headers hook.
  // ---------------------------------------------------------------------------
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

  return {
    config: async (config) => {
      try {
        await log("info", "Opencode Custom Provider startup - loading custom config")
        if (!config.provider) config.provider = {}

        const env: Record<string, string | undefined> = (typeof process !== "undefined" ? (process.env as any) : {}) as any

        const { config: providers, path: configPath, raw: rawJson } = await loadCustomConfig(directory, env, log)
        applySessionHeadersConfig(rawJson)

        // Fallback: if no custom config, sync providers already in opencode.json that have baseURL and no explicit models or dynamic flag
        // This keeps backward compat with existing esuyo-gateway hard-coded in opencode.json
        let providerEntries: Record<string, ProviderEntry> = providers
        if (Object.keys(providerEntries).length === 0) {
          await log("info", "No custom providers - checking opencode.json providers with baseURL for backward compat")
          for (const [id, p] of Object.entries((config.provider as any) ?? {})) {
            const opts = (p as any)?.options
            if (opts?.baseURL && typeof opts.baseURL === "string") {
              providerEntries[id] = {
                id,
                name: (p as any).name,
                npm: (p as any).npm,
                baseURL: opts.baseURL,
                apiKey: opts.apiKey,
                enabled: true,
              }
            }
          }
          if (Object.keys(providerEntries).length > 0) {
            await log("info", `Fallback discovered ${Object.keys(providerEntries).length} providers from opencode.json`, { providers: Object.keys(providerEntries) })
          } else {
            await log("warn", "No providers to sync - create .opencode/opencode-custom-provider.json")
            return
          }
        }

        const disabled: string[] = (config as any).disabled_providers ?? []
        const enabledAllow: string[] | null = (config as any).enabled_providers ? [...(config as any).enabled_providers] : null

        // Seed per-provider session-header opts (config hook runs before any
        // chat.headers call, so the headers hook can rely on this map).
        // Seed the managed set here too (not only after a successful fetch)
        // so injection still works when the gateway is unreachable and the
        // plugin keeps existing models.
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

        // Prepare sync tasks in parallel
        const tasks = Object.entries(providerEntries).map(async ([providerId, entry]) => {
          const enabled = entry.enabled !== false
          if (!enabled) {
            await log("info", `Provider ${providerId} disabled via custom config, skipping`, { providerId, configPath })
            return
          }
          if (disabled.includes(providerId)) {
            await log("info", `Provider ${providerId} in disabled_providers, skipping`, { providerId })
            return
          }
          if (enabledAllow && !enabledAllow.includes(providerId)) {
            await log("info", `Provider ${providerId} not in enabled_providers, skipping`, { providerId })
            return
          }

          // Ensure provider entry exists in opencode config
          let provider: any = (config.provider as any)[providerId]
          const npm = entry.npm ?? DEFAULT_NPM
          const name = entry.name ?? provider?.name ?? providerId
          const baseURL = entry.baseURL
          const timeoutMs = entry.timeoutMs ?? DEFAULT_TIMEOUT_MS

          if (!provider) {
            await log("info", `Provider ${providerId} not in opencode.json - auto-creating`, { providerId, baseURL, configPath })
            provider = { npm, name, options: { baseURL } }
            ;(config.provider as any)[providerId] = provider
          } else {
            if (!provider.npm) provider.npm = npm
            if (!provider.name) provider.name = name
            if (!provider.options) provider.options = {}
            if (!provider.options.baseURL) provider.options.baseURL = baseURL
            // if custom config specifies baseURL different from opencode.json, prefer custom config but log
            if (entry.baseURL && provider.options.baseURL !== entry.baseURL) {
              await log("info", `Provider ${providerId} baseURL overridden by custom config`, { providerId, from: provider.options.baseURL, to: entry.baseURL })
              provider.options.baseURL = entry.baseURL
            }
          }

          let apiKey = await resolveApiKeyAsync(entry, provider.options, env)
          if (!apiKey) {
            // Fallback: reuse apiKey from any other provider with same baseURL (e.g. multiple gateways sharing same backend)
            for (const [otherId, otherProv] of Object.entries((config.provider as any) ?? {})) {
              if (otherId === providerId) continue
              const otherOpts = (otherProv as any)?.options
              if (otherOpts?.baseURL === baseURL && typeof otherOpts?.apiKey === "string" && otherOpts.apiKey.trim() && otherOpts.apiKey.trim() !== "none") {
                const v = (await resolveStringValueAsync(otherOpts.apiKey as string, env)) ?? resolveStringValue(otherOpts.apiKey as string, env)
                if (v) {
                  apiKey = v
                  await log("info", `Using fallback apiKey from ${otherId} for ${providerId} (same baseURL)`, { providerId, fallback: otherId })
                  break
                }
              }
            }
          }
          if (!apiKey) {
            await log("warn", `No apiKey for ${providerId} - attempting unauthenticated`, { providerId, baseURL, hint: `Set apiKey or apiKeyEnv in custom config or ${providerId.toUpperCase()}_API_KEY env` })
          } else {
            await log("debug", `Using apiKey for ${providerId}`, { providerId, baseURL, hasKey: true })
            // Persist apiKey for LLM requests - provider chat needs options.apiKey
            if (provider.options) provider.options.apiKey = apiKey
          }

          const existingModels: Record<string, any> = provider.models ?? {}
          const existingCount = Object.keys(existingModels).length
          const modelsUrl = resolveModelsUrl(baseURL)
          await log("info", `Fetching models for ${providerId}`, { providerId, baseURL: modelsUrl, existingCount, timeoutMs })

          let discovered: RawGatewayModel[]
          try {
            discovered = await getDiscoveredModels(baseURL, apiKey, timeoutMs)
          } catch (err: any) {
            const msg = err?.message ?? String(err)
            await log("warn", `Gateway fetch failed for ${providerId}, keeping ${existingCount} existing`, { providerId, baseURL, error: msg })
            if (existingCount === 0) await log("error", `No models and gateway unreachable for ${providerId}`, { providerId, error: msg })
            return
          }

          // apply include/exclude filtering
          const filtered = filterModels(discovered, entry.include, entry.exclude)
          if (filtered.length !== discovered.length) {
            await log("info", `Filtered ${providerId}: ${discovered.length} -> ${filtered.length}`, { providerId, include: entry.include, exclude: entry.exclude })
          }
          discovered = filtered

          if (discovered.length === 0) {
            await log("warn", `Gateway returned 0 models for ${providerId}, keeping existing`, { providerId, existingCount })
            return
          }

          await log("info", `Discovered ${discovered.length} models for ${providerId}`, { providerId, sample: discovered.slice(0, 3).map((m) => m.id) })

          const nextModels: Record<string, any> = {}
          let added = 0
          let reused = 0
          for (const { id, raw } of discovered) {
            const existing = existingModels[id]
            // also consider static models override from custom config entry.models[id]
            const staticOverride = entry.models?.[id]
            const mergedExisting = staticOverride ? { ...(existing ?? {}), ...staticOverride } : existing
            const cfg = buildModelConfig(id, mergedExisting, raw, entry.modelDefaults)
            nextModels[id] = cfg
            if (existing || staticOverride) reused++
            else added++
          }

          // also preserve static models that are not in discovered but explicitly defined in entry.models?
          // Optionally keep them - we merge them in addition
          if (entry.models) {
            for (const [mid, mcfg] of Object.entries(entry.models)) {
              if (!(mid in nextModels)) {
                nextModels[mid] = mcfg
                await log("info", `Keeping static model ${mid} for ${providerId} not in gateway`, { providerId, modelId: mid })
              }
            }
          }

          const removed = Object.keys(existingModels).filter((id) => !(id in nextModels))
          if (removed.length > 0) await log("info", `Removing ${removed.length} stale models for ${providerId}`, { providerId, removed })

          provider.models = nextModels
          managedProviderIds.add(providerId)
          await log("info", `Provider ${providerId} models synced`, { providerId, total: discovered.length, added, reused, removed: removed.length })
        })

        await Promise.allSettled(tasks)
        await log("info", "Opencode Custom Provider sync complete", { providers: Object.keys(providerEntries) })
      } catch (err: any) {
        await log("error", `Unexpected error: ${err?.message ?? String(err)}`, { error: String(err?.stack ?? err) })
      }
    },

    "chat.headers": async (input, output) => {
      try {
        if (!sessionHeadersEnabled) return
        const sessionID = (input as { sessionID?: unknown }).sessionID
        if (typeof sessionID !== "string" || !sessionID) return
        const model = (input as { model?: { providerID?: unknown } }).model
        const providerCtx = (input as { provider?: { info?: { id?: unknown } } }).provider
        const providerID =
          (typeof model?.providerID === "string" && model.providerID) ||
          (typeof providerCtx?.info?.id === "string" && (providerCtx.info.id as string)) ||
          ""
        if (!providerID) return
        // Opencode core already sends x-opencode-session for first-party
        // opencode providers — setting it again to the same sessionID is a
        // harmless no-op, so just skip them and only backfill custom gateways.
        if (providerID.startsWith("opencode")) return
        if (sessionHeaderAllowlist && !sessionHeaderAllowlist.has(providerID)) return
        // Default scope: only providers managed by this plugin, so we never
        // touch the user's unrelated providers (anthropic, openai, ...).
        // An explicit sessionHeaders.providers allowlist opts in unmanaged IDs.
        if (!sessionHeaderAllowlist && !managedProviderIds.has(providerID)) return
        const perProvider = perProviderSessionOpts.get(providerID)
        if (perProvider && perProvider.enabled === false) return
        const headerName = perProvider?.header || sessionHeaderName || DEFAULT_SESSION_HEADER
        output.headers[headerName] = sessionID
      } catch {
        // header injection must never break the request
      }
    },
  }
}

export default OpencodeCustomProviderPlugin



