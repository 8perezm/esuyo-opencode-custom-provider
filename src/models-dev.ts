// ---------------------------------------------------------------------------
// models.dev enrichment for the Esuyo Custom Provider (Opencode).
//
// models.dev (https://models.dev) publishes a curated catalog of model
// metadata: thinking/reasoning levels (`reasoning`, `reasoning_options`),
// supported input/output modalities (`modalities`), and token limits
// (`limit.context` / `limit.input` / `limit.output`), plus cost, family and
// lifecycle status. Gateways usually expose `/v1/models` as bare IDs with no
// metadata, so this module looks each discovered model up in the catalog and
// maps the result onto Opencode V2 `Model.Info` fields:
//
//   modalities.input/output -> capabilities.input/output  (e.g. image, pdf)
//   tool_call               -> capabilities.tools        (function calling)
//   limit                   -> limit.context/input/output (compaction, caps)
//   cost                    -> cost (+ context-size tiers)
//   family / status         -> family / status
//   name                    -> name (only when the gateway has no display name)
//
// Opencode `Model.Info` has no first-class reasoning-level knob, so
// reasoning is surfaced where the harness consumes it:
//   - `capabilities.tools` from `tool_call` (function calling), and
//   - `Model.Info.variants` from `reasoning_options` effort values — one
//     variant per level (e.g. `low`/`medium`/`high`), listed by `/variants`
//     and selectable as `provider/model:<level>`, each carrying
//     `settings: { reasoningEffort: "<level>" }` (the option name the
//     openai-compatible provider maps onto the `reasoning_effort` request
//     parameter). Variants only take effect when explicitly selected.
// Reasoning support is also logged per model at sync time.
//
// Precedence for every field:
//   built-in defaults < models.dev < gateway /v1/models < modelDefaults <
//   static `models:` overrides. (`preferGateway: false` swaps the middle two
//   so the catalog wins over stale gateway metadata.)
// ---------------------------------------------------------------------------

import type {
  Catalog,
  Model,
  ModelMetadata,
  ModelMetadataMap,
  ProviderMap,
} from "@opencode-ai/models"

// ---------------------------------------------------------------------------
// Config types (also referenced from src/index.ts)
// ---------------------------------------------------------------------------

export interface ModelsDevGlobalOptions {
  /** Master switch. Default true (silent no-op when the catalog is unreachable). */
  enabled?: boolean
  /** Catalog base URL. Default "https://models.dev". */
  baseUrl?: string
  /** Live catalog fetch timeout. Default 8000ms. */
  timeoutMs?: number
  /** In-memory catalog cache TTL. Default 3600000ms (1h). */
  cacheTtlMs?: number
  /** "all" fetches specialized types too (?type=all). Default "all". */
  modelTypes?: "all" | "standard"
  /** When true (default) gateway metadata wins over the catalog on conflict. */
  preferGateway?: boolean
  /**
   * Generate `Model.Info.variants` from the catalog's reasoning effort levels
   * (one variant per level, e.g. `low`/`medium`/`high`, selectable in opencode
   * as `provider/model:variant` and listed by `/variants`). Default true.
   * Variants only take effect when explicitly selected, so generating them is
   * safe for endpoints that ignore `reasoning_effort`.
   */
  variants?: boolean
  /** Skip enrichment for catalog entries flagged deprecated. Default false. */
  excludeDeprecated?: boolean
  /** Skip enrichment for these models.dev `type` values (e.g. ["embedding"]). */
  excludeTypes?: string[]
  /** Global models.dev provider-namespace pin used for match ranking. */
  provider?: string
}

export interface ModelsDevProviderOverride {
  enabled?: boolean
  /** Pin match ranking to one models.dev provider namespace (e.g. "openai"). */
  provider?: string
  /** Generate reasoning-effort variants for this provider. Default true. */
  variants?: boolean
}

export type ModelsDevProviderSetting = boolean | ModelsDevProviderOverride | undefined

export interface ResolvedModelsDevTarget {
  enabled: boolean
  provider?: string
  variants: boolean
}

export function resolveModelsDevForProvider(
  globalOpts: Required<ModelsDevGlobalOptions>,
  setting: ModelsDevProviderSetting,
): ResolvedModelsDevTarget {
  if (setting === false) return { enabled: false, variants: false }
  if (setting === true || setting === undefined || setting === null) {
    return { enabled: globalOpts.enabled, provider: globalOpts.provider, variants: globalOpts.variants }
  }
  if (typeof setting === "object") {
    const enabled = setting.enabled ?? globalOpts.enabled
    return {
      enabled,
      provider: setting.provider ?? globalOpts.provider,
      variants: enabled ? (setting.variants ?? globalOpts.variants) : false,
    }
  }
  return { enabled: globalOpts.enabled, provider: globalOpts.provider, variants: globalOpts.variants }
}

export function defaultModelsDevOptions(raw?: ModelsDevGlobalOptions): Required<ModelsDevGlobalOptions> {
  return {
    enabled: raw?.enabled ?? true,
    baseUrl: (raw?.baseUrl ?? "https://models.dev").replace(/\/+$/, ""),
    timeoutMs: raw?.timeoutMs ?? 8000,
    cacheTtlMs: raw?.cacheTtlMs ?? 3600000,
    modelTypes: raw?.modelTypes ?? "all",
    preferGateway: raw?.preferGateway ?? true,
    variants: raw?.variants ?? true,
    excludeDeprecated: raw?.excludeDeprecated ?? false,
    excludeTypes: Array.isArray(raw?.excludeTypes) ? [...(raw as ModelsDevGlobalOptions).excludeTypes!] : [],
    provider: typeof raw?.provider === "string" && raw.provider.trim() ? raw.provider.trim() : undefined as any,
  }
}

// ---------------------------------------------------------------------------
// Normalized catalog entry (provider-specific Model + lab ModelMetadata share
// this shape; cost is optional because models.json entries carry no pricing).
// ---------------------------------------------------------------------------

export interface NormalizedModelsDevModel {
  id: string
  name?: string
  /** models.dev `type` (absent for standard chat models). */
  type?: string
  reasoning: boolean
  reasoningOptions: Array<Record<string, any>>
  toolCall: boolean
  attachment: boolean
  modalitiesInput: string[]
  modalitiesOutput: string[]
  limitContext?: number
  limitInput?: number
  limitOutput?: number
  hasCost: boolean
  costInput: number
  costOutput: number
  costCacheRead: number
  costCacheWrite: number
  costTiers: Array<{
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    inputTokensAbove: number
  }>
  family?: string
  /** Only set for alpha/beta/deprecated (absent means generally available). */
  status?: "alpha" | "beta" | "deprecated"
  /** True when the entry came from models.json (lab metadata, no pricing). */
  fromMetadata: boolean
  /** True when the entry is a lab original (no canonical_model_id link). */
  labOriginal: boolean
}

export interface ModelsDevMatch {
  entry: NormalizedModelsDevModel
  /** models.dev provider namespace the match came from ("" for models.json). */
  providerId: string
  /** models.dev model key (or canonical id for models.json matches). */
  modelKey: string
}

export interface ModelsDevCatalogResult {
  providers: ProviderMap
  models: ModelMetadataMap
  source: "live" | "snapshot"
  generatedAt?: string
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

function cleanStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of v) {
    if (typeof item !== "string") continue
    const t = item.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

function normalizeLimit(raw: any): { context?: number; input?: number; output?: number } {
  const out: { context?: number; input?: number; output?: number } = {}
  if (!raw || typeof raw !== "object") return out
  if (isFiniteNumber(raw.context) && raw.context > 0) out.context = raw.context
  if (isFiniteNumber(raw.input) && raw.input > 0) out.input = raw.input
  if (isFiniteNumber(raw.output) && raw.output > 0) out.output = raw.output
  return out
}

export function normalizeProviderModel(model: Model, fromMetadata = false): NormalizedModelsDevModel {
  const m = model as unknown as Record<string, any>
  const limit = normalizeLimit(m.limit)
  const cost = m.cost && typeof m.cost === "object" ? m.cost : undefined
  const tiers: NormalizedModelsDevModel["costTiers"] = []
  if (Array.isArray(cost?.tiers)) {
    for (const t of cost.tiers) {
      const size = t?.tier?.size
      if (!isFiniteNumber(t?.input) || !isFiniteNumber(t?.output) || !isFiniteNumber(size) || size <= 0) continue
      tiers.push({
        input: t.input,
        output: t.output,
        cacheRead: isFiniteNumber(t.cache_read) ? t.cache_read : 0,
        cacheWrite: isFiniteNumber(t.cache_write) ? t.cache_write : 0,
        inputTokensAbove: size,
      })
    }
  }
  const status = m.status
  return {
    id: typeof m.id === "string" ? m.id : "",
    name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : undefined,
    type: typeof m.type === "string" && m.type.trim() ? m.type.trim() : undefined,
    reasoning: m.reasoning === true,
    reasoningOptions: Array.isArray(m.reasoning_options) ? m.reasoning_options.filter((o) => o && typeof o === "object") : [],
    toolCall: m.tool_call === true,
    attachment: m.attachment === true,
    modalitiesInput: cleanStringList(m.modalities?.input),
    modalitiesOutput: cleanStringList(m.modalities?.output),
    limitContext: limit.context,
    limitInput: limit.input,
    limitOutput: limit.output,
    hasCost: !!cost && isFiniteNumber(cost.input) && isFiniteNumber(cost.output),
    costInput: isFiniteNumber(cost?.input) ? cost.input : 0,
    costOutput: isFiniteNumber(cost?.output) ? cost.output : 0,
    costCacheRead: isFiniteNumber(cost?.cache_read) ? cost.cache_read : 0,
    costCacheWrite: isFiniteNumber(cost?.cache_write) ? cost.cache_write : 0,
    costTiers: tiers,
    family: typeof m.family === "string" && m.family.trim() ? m.family.trim() : undefined,
    status: status === "alpha" || status === "beta" || status === "deprecated" ? status : undefined,
    fromMetadata,
    labOriginal: fromMetadata
      ? false
      : !(typeof m.canonical_model_id === "string" && m.canonical_model_id.trim()),
  }
}

export function normalizeMetadataModel(meta: ModelMetadata): NormalizedModelsDevModel {
  const base = normalizeProviderModel(meta as unknown as Model, true)
  base.hasCost = false
  base.labOriginal = false
  return base
}

// ---------------------------------------------------------------------------
// Catalog loading (live fetch with bundled-snapshot fallback, TTL cached).
// The @opencode-ai/models package is imported lazily so a missing install
// degrades to snapshot/no-enrichment instead of breaking plugin startup.
// ---------------------------------------------------------------------------

export interface ModelsDevLoaderDeps {
  fetchCatalog?: (request: { signal?: AbortSignal; modelTypes?: "all" }) => Promise<Catalog>
  loadSnapshot?: () => Promise<{ providers: ProviderMap; models: ModelMetadataMap; generatedAt?: string }>
}

interface CacheEntry {
  catalog: ModelsDevCatalogResult
  at: number
}

const catalogCache = new Map<string, CacheEntry>()

export function clearModelsDevCache(): void {
  catalogCache.clear()
}

async function defaultFetchCatalog(
  baseUrl: string,
  modelTypes: "all" | "standard",
  timeoutMs: number,
): Promise<Catalog> {
  const mod = await import("@opencode-ai/models")
  const client = (mod as any).Models.make({ baseUrl })
  const opts: any = { signal: AbortSignal.timeout(timeoutMs) }
  if (modelTypes === "all") opts.modelTypes = "all"
  return await client.catalog(opts)
}

async function defaultLoadSnapshot(): Promise<{
  providers: ProviderMap
  models: ModelMetadataMap
  generatedAt?: string
}> {
  const snap = await import("@opencode-ai/models/snapshot")
  return {
    providers: (snap as any).providers as ProviderMap,
    models: (snap as any).models as ModelMetadataMap,
    generatedAt: (snap as any).generatedAt as string | undefined,
  }
}

export async function loadModelsDevCatalog(
  opts: Required<ModelsDevGlobalOptions>,
  log?: (level: "debug" | "info" | "warn" | "error", msg: string, extra?: any) => void,
  deps?: ModelsDevLoaderDeps,
): Promise<ModelsDevCatalogResult | null> {
  const cacheKey = `${opts.baseUrl}|${opts.modelTypes}`
  const now = Date.now()
  const hit = catalogCache.get(cacheKey)
  if (hit && now - hit.at < opts.cacheTtlMs) {
    log?.("debug", `models.dev catalog cache hit (${hit.catalog.source})`)
    return hit.catalog
  }

  // 1) Live catalog.
  try {
    const catalog = deps?.fetchCatalog
      ? await deps.fetchCatalog({
          signal: AbortSignal.timeout(opts.timeoutMs),
          modelTypes: opts.modelTypes === "all" ? "all" : undefined,
        })
      : await defaultFetchCatalog(opts.baseUrl, opts.modelTypes, opts.timeoutMs)
    const result: ModelsDevCatalogResult = {
      providers: catalog?.providers ?? {},
      models: catalog?.models ?? {},
      source: "live",
    }
    if (Object.keys(result.providers).length > 0) {
      catalogCache.set(cacheKey, { catalog: result, at: now })
      log?.("info", `models.dev catalog loaded (live)`, {
        providers: Object.keys(result.providers).length,
      })
      return result
    }
    throw new Error("live catalog is empty")
  } catch (err: any) {
    log?.("warn", `models.dev live catalog unavailable (${err?.message ?? String(err)}), trying snapshot`)
  }

  // 2) Bundled snapshot fallback (ships inside @opencode-ai/models, <=24h old).
  try {
    const snap = deps?.loadSnapshot ? await deps.loadSnapshot() : await defaultLoadSnapshot()
    const result: ModelsDevCatalogResult = {
      providers: snap?.providers ?? {},
      models: snap?.models ?? {},
      source: "snapshot",
      generatedAt: snap?.generatedAt,
    }
    if (Object.keys(result.providers).length > 0) {
      catalogCache.set(cacheKey, { catalog: result, at: now })
      log?.("info", `models.dev catalog loaded (snapshot fallback)`, {
        providers: Object.keys(result.providers).length,
        generatedAt: result.generatedAt,
      })
      return result
    }
    throw new Error("snapshot catalog is empty")
  } catch (err: any) {
    log?.("warn", `models.dev snapshot unavailable (${err?.message ?? String(err)}), enrichment disabled`)
  }
  return null
}

// ---------------------------------------------------------------------------
// Matching. Gateway IDs vary ("gpt-4o", "openai/gpt-4o",
// "esuyo/opencode/qwen3.8-flash"); catalog keys vary too (bare lab ids like
// "gpt-4o" vs namespaced "openai/gpt-4o"). Exact matches win; otherwise the
// last path segment is compared. Ambiguous suffixes resolve deterministically:
// exact string > pinned provider > the canonical owner (the provider namespace
// that owns the model's canonical_model_id, e.g. `meta` for
// `meta/muse-spark-1.3`) > unlinked "lab original" entries > non-deprecated.
// Canonical owners carry authoritative capabilities; some reseller mirrors
// advertise extra reasoning levels (e.g. `max`) the real deployment does not
// support. Costs can differ across mirrors, so preferring the canonical
// owner/lab entry also keeps pricing closest to list price.
// ---------------------------------------------------------------------------

interface Candidate {
  providerId: string
  key: string
  entry: NormalizedModelsDevModel
  fullLower: string
  suffixLower: string
  canonicalLower: string
  canonicalSuffixLower: string
}

const indexCache = new WeakMap<ModelsDevCatalogResult, { providerPool: Candidate[]; metaPool: Candidate[] }>()

function lastSegment(v: string): string {
  const i = v.lastIndexOf("/")
  return i === -1 ? v : v.slice(i + 1)
}

function buildIndex(catalog: ModelsDevCatalogResult): {
  providerPool: Candidate[]
  metaPool: Candidate[]
} {
  const cached = indexCache.get(catalog)
  if (cached) return cached
  const providerPool: Candidate[] = []
  for (const [providerId, provider] of Object.entries(catalog.providers ?? {})) {
    const models = (provider as any)?.models
    if (!models || typeof models !== "object") continue
    for (const [key, model] of Object.entries(models)) {
      if (!model || typeof model !== "object") continue
      const m = model as unknown as Record<string, any>
      const canon = typeof m.canonical_model_id === "string" ? m.canonical_model_id.trim() : ""
      const keyTrim = key.trim()
      if (!keyTrim) continue
      providerPool.push({
        providerId,
        key: keyTrim,
        entry: normalizeProviderModel(model as Model),
        fullLower: keyTrim.toLowerCase(),
        suffixLower: lastSegment(keyTrim).toLowerCase(),
        canonicalLower: canon.toLowerCase(),
        canonicalSuffixLower: canon ? lastSegment(canon).toLowerCase() : "",
      })
    }
  }
  const metaPool: Candidate[] = []
  for (const [key, meta] of Object.entries(catalog.models ?? {})) {
    if (!meta || typeof meta !== "object") continue
    const keyTrim = key.trim()
    if (!keyTrim) continue
    metaPool.push({
      providerId: "",
      key: keyTrim,
      entry: normalizeMetadataModel(meta as ModelMetadata),
      fullLower: keyTrim.toLowerCase(),
      suffixLower: lastSegment(keyTrim).toLowerCase(),
      canonicalLower: "",
      canonicalSuffixLower: "",
    })
  }
  const built = { providerPool, metaPool }
  indexCache.set(catalog, built)
  return built
}

function normalizeName(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/**
 * True when a candidate is offered by the namespace that owns its canonical
 * model id — i.e. the lab/provider the model actually comes from
 * (`meta/...` for a `meta/muse-spark-1.3` canonical, `openai/gpt-4o` for
 * `openai`, `xai/...` for an `x-ai` listing). These entries carry the
 * authoritative capability set; reseller mirrors occasionally advertise extra
 * reasoning levels (e.g. an unlinked `kilo`/`openrouter` listing adding `max`)
 * that the canonical deployment does not support.
 */
function isCanonicalOwner(c: Candidate): boolean {
  const slash = c.canonicalLower.indexOf("/")
  if (slash === -1) return false
  return normalizeName(c.providerId) === normalizeName(c.canonicalLower.slice(0, slash))
}

function rankCandidates(cands: Array<{ c: Candidate; score: number }>, providerPin?: string): Candidate | null {
  if (cands.length === 0) return null
  const pin = providerPin?.trim().toLowerCase()
  cands.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (pin) {
      const ap = a.c.providerId.toLowerCase() === pin ? 1 : 0
      const bp = b.c.providerId.toLowerCase() === pin ? 1 : 0
      if (bp !== ap) return bp - ap
    }
    // Canonical owner beats resellers, then unlinked (lab-original) entries.
    const aown = isCanonicalOwner(a.c) ? 1 : 0
    const bown = isCanonicalOwner(b.c) ? 1 : 0
    if (bown !== aown) return bown - aown
    const alab = a.c.entry.labOriginal ? 1 : 0
    const blab = b.c.entry.labOriginal ? 1 : 0
    if (blab !== alab) return blab - alab
    const adep = a.c.entry.status === "deprecated" ? 0 : 1
    const bdep = b.c.entry.status === "deprecated" ? 0 : 1
    if (bdep !== adep) return bdep - adep
    if (a.c.providerId !== b.c.providerId) return a.c.providerId < b.c.providerId ? -1 : 1
    return a.c.key < b.c.key ? -1 : a.c.key > b.c.key ? 1 : 0
  })
  return cands[0].c
}

function searchPool(
  pool: Candidate[],
  lower: string,
  suffix: string,
): Array<{ c: Candidate; score: number }> {
  const out: Array<{ c: Candidate; score: number }> = []
  for (const c of pool) {
    if (c.fullLower === lower || (c.canonicalLower && c.canonicalLower === lower)) {
      out.push({ c, score: 3 })
    } else if (c.suffixLower === suffix || (c.canonicalSuffixLower && c.canonicalSuffixLower === suffix)) {
      out.push({ c, score: 1 })
    }
  }
  return out
}

export function findModelsDevMatch(
  gatewayId: string,
  catalog: ModelsDevCatalogResult | null | undefined,
  providerPin?: string,
): ModelsDevMatch | null {
  if (!catalog) return null
  const gid = (gatewayId ?? "").trim()
  if (!gid) return null
  const lower = gid.toLowerCase()
  const suffix = lastSegment(lower)
  if (!suffix || suffix.length < 2) return null
  const { providerPool, metaPool } = buildIndex(catalog)
  const ranked = rankCandidates(searchPool(providerPool, lower, suffix), providerPin)
  if (ranked) return { entry: ranked.entry, providerId: ranked.providerId, modelKey: ranked.key }
  const metaRanked = rankCandidates(searchPool(metaPool, lower, suffix), providerPin)
  if (metaRanked) return { entry: metaRanked.entry, providerId: "", modelKey: metaRanked.key }
  return null
}

// ---------------------------------------------------------------------------
// Gating + Opencode mapping
// ---------------------------------------------------------------------------

/** False when the entry is opted out via excludeTypes/excludeDeprecated. */
export function shouldEnrichModelsDevMatch(
  entry: NormalizedModelsDevModel,
  opts: Required<ModelsDevGlobalOptions>,
): boolean {
  if (opts.excludeDeprecated && entry.status === "deprecated") return false
  if (opts.excludeTypes.length > 0 && entry.type) {
    const t = entry.type.toLowerCase()
    if (opts.excludeTypes.some((x) => x.toLowerCase() === t)) return false
  }
  return true
}

/** True for standard chat models (models.dev leaves `type` absent for those). */
export function isChatLikeModelsDevModel(entry: NormalizedModelsDevModel): boolean {
  return !entry.type || entry.type.toLowerCase() === "chat"
}

/**
 * Build opencode `Model.Info.variants` from the catalog's reasoning effort
 * levels. Each effort value becomes a selectable variant
 * (`provider/model:<level>`, listed by `/variants`) carrying
 * `settings: { reasoningEffort: "<level>" }` — the same option name the
 * openai-compatible provider maps onto the `reasoning_effort` request
 * parameter. `"default"` is skipped (it names the endpoint default, not a
 * level); `null` (explicitly disableable) maps onto `"none"`.
 * Toggle-only or budget-only models expose no discrete levels, so they (and
 * non-chat types, and non-reasoning models) yield no variants.
 */
export const MODELS_DEV_EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

export interface ModelsDevVariant {
  id: string
  settings: { reasoningEffort: string }
}

export function buildModelsDevVariants(entry: NormalizedModelsDevModel): ModelsDevVariant[] {
  if (!isChatLikeModelsDevModel(entry)) return []
  if (!entry.reasoning) return []
  const effort = entry.reasoningOptions.find((o) => o && (o as any).type === "effort")
  const values = effort && Array.isArray((effort as any).values) ? (effort as any).values : []
  const seen = new Set<string>()
  const out: ModelsDevVariant[] = []
  for (const v of values) {
    const id = v === null ? "none" : v
    if (typeof id !== "string") continue
    if (id === "default") continue
    if (!(MODELS_DEV_EFFORT_LEVELS as readonly string[]).includes(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, settings: { reasoningEffort: id } })
  }
  return out
}

/**
 * Apply catalog metadata onto a mutable V2 `Model.Info`-shaped object.
 * Capability-ish fields (tools/input/output) only apply to chat-like entries;
 * factual fields (name/limit/cost/family/status) apply to any matched type.
 * Reasoning-effort variants are set for chat-like reasoning models unless
 * `opts.variants` is false. Returns whether a catalog display name was applied.
 */
export function applyModelsDevToOpencodeInfo(
  info: Record<string, any>,
  entry: NormalizedModelsDevModel,
  opts?: { variants?: boolean },
): { named: boolean } {
  let named = false
  if (isChatLikeModelsDevModel(entry)) {
    info.capabilities = info.capabilities ?? { tools: true, input: ["text"], output: ["text"] }
    if (entry.modalitiesInput.length > 0) info.capabilities.input = [...entry.modalitiesInput]
    if (entry.modalitiesOutput.length > 0) info.capabilities.output = [...entry.modalitiesOutput]
    info.capabilities.tools = entry.toolCall
  }
  if (entry.name) {
    info.name = entry.name
    named = true
  }
  if (entry.limitContext !== undefined || entry.limitInput !== undefined || entry.limitOutput !== undefined) {
    info.limit = info.limit ?? {}
    if (entry.limitContext !== undefined) info.limit.context = entry.limitContext
    if (entry.limitInput !== undefined) info.limit.input = entry.limitInput
    if (entry.limitOutput !== undefined) info.limit.output = entry.limitOutput
  }
  if (entry.hasCost) {
    const base: Record<string, any> = {
      input: entry.costInput,
      output: entry.costOutput,
      cache: { read: entry.costCacheRead, write: entry.costCacheWrite },
    }
    const costs: Record<string, any>[] = [base]
    for (const t of entry.costTiers) {
      costs.push({
        tier: { type: "context", size: t.inputTokensAbove },
        input: t.input,
        output: t.output,
        cache: { read: t.cacheRead, write: t.cacheWrite },
      })
    }
    info.cost = costs
  }
  if (entry.family) info.family = entry.family
  if (entry.status) info.status = entry.status
  if (opts?.variants !== false) {
    const variants = buildModelsDevVariants(entry)
    if (variants.length > 0) info.variants = variants
  }
  return { named }
}
