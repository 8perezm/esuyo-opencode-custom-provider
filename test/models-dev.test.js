// Unit tests for src/models-dev.ts (opencode plugin).
// Run: npm test  (builds dist first, then node --test test/)
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    applyModelsDevToOpencodeInfo,
    buildModelsDevVariants,
    clearModelsDevCache,
    defaultModelsDevOptions,
    findModelsDevMatch,
    isChatLikeModelsDevModel,
    loadModelsDevCatalog,
    normalizeProviderModel,
    resolveModelsDevForProvider,
    shouldEnrichModelsDevMatch,
} from "../dist/models-dev.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function labGpt4o(overrides = {}) {
    return {
        id: "gpt-4o",
        name: "GPT-4o",
        reasoning: false,
        tool_call: true,
        attachment: true,
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        limit: { context: 128000, output: 16384 },
        cost: { input: 2.5, output: 10, cache_read: 1.25 },
        family: "gpt",
        ...overrides,
    };
}

function resellerGpt4o() {
    return {
        id: "gpt-4o",
        canonical_model_id: "openai/gpt-4o",
        name: "GPT-4o (reseller)",
        reasoning: false,
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 128000, output: 16384 },
        cost: { input: 5, output: 20, cache_read: 2.5 },
        status: "deprecated",
    };
}

function fakeCatalog() {
    return {
        providers: {
            openai: { models: { "gpt-4o": labGpt4o() } },
            reseller: { models: { "openai/gpt-4o": resellerGpt4o() } },
        },
        models: {
            "anthropic/claude-opus-4-6": {
                id: "anthropic/claude-opus-4-6",
                name: "Claude Opus 4.6",
                reasoning: true,
                reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "max"] }],
                tool_call: true,
                modalities: { input: ["text", "image"], output: ["text"] },
                limit: { context: 200000, output: 32000 },
            },
        },
        source: "live",
    };
}

// ── normalizeProviderModel ───────────────────────────────────────────────────

describe("normalizeProviderModel", () => {
    it("normalizes a full lab entry", () => {
        const e = normalizeProviderModel(labGpt4o());
        assert.equal(e.id, "gpt-4o");
        assert.equal(e.name, "GPT-4o");
        assert.equal(e.reasoning, false);
        assert.equal(e.toolCall, true);
        assert.deepEqual(e.modalitiesInput, ["text", "image", "pdf"]);
        assert.equal(e.limitContext, 128000);
        assert.equal(e.limitOutput, 16384);
        assert.equal(e.hasCost, true);
        assert.equal(e.costInput, 2.5);
        assert.equal(e.costCacheRead, 1.25);
        assert.equal(e.family, "gpt");
        assert.equal(e.labOriginal, true);
        assert.equal(e.status, undefined);
    });

    it("marks reseller mirrors (canonical_model_id) as non-lab", () => {
        assert.equal(normalizeProviderModel(resellerGpt4o()).labOriginal, false);
    });

    it("rejects non-finite / non-positive limits and costs", () => {
        const e = normalizeProviderModel({
            id: "x",
            limit: { context: -5, output: NaN, input: 0 },
            cost: { input: Infinity, output: 1 },
        });
        assert.equal(e.limitContext, undefined);
        assert.equal(e.hasCost, false);
        assert.equal(e.costInput, 0);
    });

    it("maps context-size cost tiers", () => {
        const e = normalizeProviderModel({
            id: "x",
            limit: { context: 100, output: 10 },
            cost: {
                input: 1,
                output: 2,
                tiers: [
                    { input: 2, output: 4, cache_read: 0.1, tier: { type: "context", size: 200000 } },
                    { input: 1, output: 1 }, // no tier size -> dropped
                ],
            },
        });
        assert.equal(e.costTiers.length, 1);
        assert.deepEqual(e.costTiers[0], {
            input: 2,
            output: 4,
            cacheRead: 0.1,
            cacheWrite: 0,
            inputTokensAbove: 200000,
        });
    });
});

// ── findModelsDevMatch ───────────────────────────────────────────────────────

describe("findModelsDevMatch", () => {
    it("matches bare gateway ids to lab entries", () => {
        const m = findModelsDevMatch("gpt-4o", fakeCatalog());
        assert.ok(m);
        assert.equal(m.providerId, "openai");
        assert.equal(m.modelKey, "gpt-4o");
        assert.equal(m.entry.labOriginal, true);
    });

    it("prefers the canonical owner over reseller mirrors that add extra levels", () => {
        // Real-world shape: openrouter/vercel/kilo list `max` for
        // meta/muse-spark-1.3-contributor without a canonical link, while the
        // canonical owner (`meta`) and opencode-go stop at `xhigh`.
        const catalog = {
            providers: {
                kilo: {
                    models: {
                        "meta/muse-spark-1.3-contributor": {
                            id: "meta/muse-spark-1.3-contributor",
                            reasoning: true,
                            reasoning_options: [
                                { type: "effort", values: ["minimal", "low", "medium", "high", "xhigh", "max"] },
                            ],
                        },
                    },
                },
                meta: {
                    models: {
                        "muse-spark-1.3-contributor": {
                            id: "muse-spark-1.3-contributor",
                            canonical_model_id: "meta/muse-spark-1.3",
                            reasoning: true,
                            reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] }],
                        },
                    },
                },
            },
            models: {},
            source: "live",
        };
        const m = findModelsDevMatch("esuyo/opencode/muse-spark-1.3-contributor", catalog);
        assert.ok(m);
        assert.equal(m.providerId, "meta");
        assert.deepEqual(
            buildModelsDevVariants(m.entry).map((v) => v.id),
            ["minimal", "low", "medium", "high", "xhigh"],
        );
        // An explicit pin still wins over the heuristic.
        const pinned = findModelsDevMatch("esuyo/opencode/muse-spark-1.3-contributor", catalog, "kilo");
        assert.ok(pinned);
        assert.equal(pinned.providerId, "kilo");
    });

    it("an exact namespaced match beats a lab suffix match", () => {
        // "openai/gpt-4o" string-equals the reseller mirror key while the lab
        // entry only matches on suffix. Exact string equality wins: a mirror
        // key may carry provider-specific limits/costs, and erring toward the
        // named entry is the conservative choice for context limits.
        const m = findModelsDevMatch("openai/gpt-4o", fakeCatalog());
        assert.ok(m);
        assert.equal(m.providerId, "reseller");
    });

    it("is case-insensitive and matches namespaced gateway ids by suffix", () => {
        const m = findModelsDevMatch("ESUYO/OPenAI/GPT-4o", fakeCatalog());
        assert.ok(m);
        assert.equal(m.providerId, "openai");
    });

    it("honors the provider pin among same-score candidates", () => {
        // "myproxy/gpt-4o" is a suffix match (score 1) for both the lab entry
        // and the reseller mirror; the pin breaks the tie.
        const pinned = findModelsDevMatch("myproxy/gpt-4o", fakeCatalog(), "reseller");
        assert.ok(pinned);
        assert.equal(pinned.providerId, "reseller");
        const unpinned = findModelsDevMatch("myproxy/gpt-4o", fakeCatalog());
        assert.ok(unpinned);
        assert.equal(unpinned.providerId, "openai"); // lab original wins untied
    });

    it("an exact id match still beats the pin", () => {
        // "gpt-4o" exactly equals the lab key; the pin must not redirect an
        // exact match to a different provider's model data.
        const m = findModelsDevMatch("gpt-4o", fakeCatalog(), "reseller");
        assert.ok(m);
        assert.equal(m.providerId, "openai");
    });

    it("falls back to models.json lab metadata when no provider matches", () => {
        const m = findModelsDevMatch("anthropic/claude-opus-4-6", fakeCatalog());
        assert.ok(m);
        assert.equal(m.providerId, "");
        assert.equal(m.entry.fromMetadata, true);
        assert.equal(m.entry.reasoning, true);
        assert.equal(m.entry.hasCost, false);
    });

    it("matches suffixes against canonical ids", () => {
        const catalog = {
            providers: { r: { models: { "x-ai/grok-4.7": { id: "x-ai/grok-4.7", canonical_model_id: "xai/grok-4.7" } } } },
            models: {},
            source: "live",
        };
        const m = findModelsDevMatch("grok-4.7", catalog);
        assert.ok(m);
        assert.equal(m.modelKey, "x-ai/grok-4.7");
    });

    it("returns null for unknown ids and junk input", () => {
        const catalog = fakeCatalog();
        assert.equal(findModelsDevMatch("definitely-not-a-model-zzz", catalog), null);
        assert.equal(findModelsDevMatch("", catalog), null);
        assert.equal(findModelsDevMatch("x", catalog), null);
        assert.equal(findModelsDevMatch("gpt-4o", null), null);
    });
});

// ── gating ───────────────────────────────────────────────────────────────────

describe("shouldEnrichModelsDevMatch / isChatLike", () => {
    const opts = defaultModelsDevOptions();
    it("allows standard models by default", () => {
        assert.equal(shouldEnrichModelsDevMatch(normalizeProviderModel(labGpt4o()), opts), true);
    });
    it("excludeDeprecated drops deprecated entries", () => {
        const o2 = defaultModelsDevOptions({ excludeDeprecated: true });
        assert.equal(shouldEnrichModelsDevMatch(normalizeProviderModel(resellerGpt4o()), o2), false);
        assert.equal(shouldEnrichModelsDevMatch(normalizeProviderModel(labGpt4o()), o2), true);
    });
    it("excludeTypes drops listed types (case-insensitive)", () => {
        const o2 = defaultModelsDevOptions({ excludeTypes: ["embedding"] });
        const emb = normalizeProviderModel({ id: "e", type: "EMBEDDING" });
        assert.equal(shouldEnrichModelsDevMatch(emb, o2), false);
        assert.equal(shouldEnrichModelsDevMatch(emb, opts), true);
    });
    it("chat-like detection", () => {
        assert.equal(isChatLikeModelsDevModel(normalizeProviderModel({ id: "a" })), true);
        assert.equal(isChatLikeModelsDevModel(normalizeProviderModel({ id: "a", type: "chat" })), true);
        assert.equal(isChatLikeModelsDevModel(normalizeProviderModel({ id: "a", type: "embedding" })), false);
    });
});

// ── applyModelsDevToOpencodeInfo ─────────────────────────────────────────────

describe("applyModelsDevToOpencodeInfo", () => {
    it("maps capabilities, limits, cost, family", () => {
        const info = { capabilities: { tools: true, input: ["text", "image"], output: ["text"] }, limit: {} };
        const { named } = applyModelsDevToOpencodeInfo(info, normalizeProviderModel(labGpt4o()));
        assert.equal(named, true);
        assert.equal(info.name, "GPT-4o");
        assert.deepEqual(info.capabilities.input, ["text", "image", "pdf"]);
        assert.deepEqual(info.capabilities.output, ["text"]);
        assert.equal(info.capabilities.tools, true);
        assert.equal(info.limit.context, 128000);
        assert.equal(info.limit.output, 16384);
        assert.equal(info.family, "gpt");
        assert.equal(info.cost.length, 1);
        assert.equal(info.cost[0].input, 2.5);
        assert.deepEqual(info.cost[0].cache, { read: 1.25, write: 0 });
    });

    it("maps tool_call:false onto capabilities.tools for chat-like models", () => {
        const info = { capabilities: { tools: true, input: ["text", "image"], output: ["text"] }, limit: {} };
        applyModelsDevToOpencodeInfo(info, normalizeProviderModel({ id: "no-tools-chat", tool_call: false }));
        assert.equal(info.capabilities.tools, false);
    });

    it("sets reasoning-effort variants unless opted out", () => {
        const entry = normalizeProviderModel({
            id: "r",
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["low", "high"] }],
            tool_call: true,
        });
        const info = { capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: {}, variants: [] };
        applyModelsDevToOpencodeInfo(info, entry);
        assert.deepEqual(info.variants, [
            { id: "low", settings: { reasoningEffort: "low" } },
            { id: "high", settings: { reasoningEffort: "high" } },
        ]);
        const info2 = { capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: {}, variants: [] };
        applyModelsDevToOpencodeInfo(info2, entry, { variants: false });
        assert.deepEqual(info2.variants, []);
    });

    it("gates capability fields for non-chat types but keeps factual fields", () => {
        const info = {
            capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
            limit: {},
            name: "keep",
        };
        const entry = normalizeProviderModel({
            id: "text-embedding-3-small",
            type: "embedding",
            name: "Text Embedding 3 Small",
            tool_call: false,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 8191, output: 0 },
        });
        applyModelsDevToOpencodeInfo(info, entry);
        // factual fields applied...
        assert.equal(info.name, "Text Embedding 3 Small");
        assert.equal(info.limit.context, 8191);
        // ...capability fields untouched.
        assert.deepEqual(info.capabilities.input, ["text", "image"]);
        assert.equal(info.capabilities.tools, true);
    });
});

// ── options resolution ───────────────────────────────────────────────────────

describe("models.dev options", () => {
    it("defaults", () => {
        const o = defaultModelsDevOptions();
        assert.equal(o.enabled, true);
        assert.equal(o.baseUrl, "https://models.dev");
        assert.equal(o.timeoutMs, 8000);
        assert.equal(o.preferGateway, true);
        assert.equal(o.modelTypes, "all");
    });
    it("per-provider resolution", () => {
        const o = defaultModelsDevOptions();
        assert.equal(o.variants, true);
        assert.deepEqual(resolveModelsDevForProvider(o, undefined), {
            enabled: true,
            provider: undefined,
            variants: true,
        });
        assert.equal(resolveModelsDevForProvider(o, false).enabled, false);
        assert.equal(resolveModelsDevForProvider(o, false).variants, false);
        assert.deepEqual(resolveModelsDevForProvider(o, { provider: "openai" }), {
            enabled: true,
            provider: "openai",
            variants: true,
        });
        const disabled = resolveModelsDevForProvider(o, { enabled: false });
        assert.equal(disabled.enabled, false);
        assert.equal(disabled.provider, undefined);
        assert.equal(disabled.variants, false);
        const noVariants = resolveModelsDevForProvider(o, { variants: false });
        assert.equal(noVariants.enabled, true);
        assert.equal(noVariants.variants, false);
        const off = defaultModelsDevOptions({ enabled: false });
        assert.equal(resolveModelsDevForProvider(off, true).enabled, false);
        const globalNoVariants = defaultModelsDevOptions({ variants: false });
        assert.equal(resolveModelsDevForProvider(globalNoVariants, undefined).variants, false);
        // Explicit per-provider `variants: true` wins over the global default.
        assert.equal(resolveModelsDevForProvider(globalNoVariants, { variants: true }).variants, true);
    });
});

// ── buildModelsDevVariants ─────────────────────────────────────────────────

describe("buildModelsDevVariants", () => {
    function reasoningEntry(overrides = {}) {
        return normalizeProviderModel({
            id: "r",
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
            tool_call: true,
            ...overrides,
        });
    }

    it("maps each effort value onto a reasoningEffort variant", () => {
        const variants = buildModelsDevVariants(reasoningEntry());
        assert.deepEqual(variants, [
            { id: "low", settings: { reasoningEffort: "low" } },
            { id: "medium", settings: { reasoningEffort: "medium" } },
            { id: "high", settings: { reasoningEffort: "high" } },
            { id: "xhigh", settings: { reasoningEffort: "xhigh" } },
            { id: "max", settings: { reasoningEffort: "max" } },
        ]);
    });

    it("skips 'default', dedupes, and maps null onto 'none'", () => {
        const variants = buildModelsDevVariants(
            reasoningEntry({ reasoning_options: [{ type: "effort", values: ["none", null, "default", "bogus", "low", "low"] }] }),
        );
        assert.deepEqual(variants, [
            { id: "none", settings: { reasoningEffort: "none" } },
            { id: "low", settings: { reasoningEffort: "low" } },
        ]);
    });

    it("yields no variants without discrete effort levels", () => {
        assert.deepEqual(buildModelsDevVariants(normalizeProviderModel({ id: "a" })), []);
        assert.deepEqual(
            buildModelsDevVariants(reasoningEntry({ reasoning_options: [{ type: "toggle" }] })),
            [],
        );
        assert.deepEqual(buildModelsDevVariants(reasoningEntry({ reasoning_options: [] })), []);
        assert.deepEqual(
            buildModelsDevVariants(reasoningEntry({ type: "embedding", reasoning_options: undefined })),
            [],
        );
        assert.deepEqual(
            buildModelsDevVariants(
                normalizeProviderModel({ id: "e", type: "embedding", reasoning: true, reasoning_options: [{ type: "effort", values: ["high"] }] }),
            ),
            [],
        );
    });
});

// ── loadModelsDevCatalog (injected deps, no network) ─────────────────────────

describe("loadModelsDevCatalog", () => {
    beforeEach(() => clearModelsDevCache());

    it("caches live results within the TTL", async () => {
        let calls = 0;
        const deps = {
            fetchCatalog: async () => {
                calls++;
                return { providers: { a: { models: {} } }, models: {} };
            },
        };
        const opts = defaultModelsDevOptions();
        const first = await loadModelsDevCatalog(opts, undefined, deps);
        const second = await loadModelsDevCatalog(opts, undefined, deps);
        assert.equal(first.source, "live");
        assert.equal(second.source, "live");
        assert.equal(calls, 1);
    });

    it("falls back to the snapshot when live fails", async () => {
        const deps = {
            fetchCatalog: async () => {
                throw new Error("offline");
            },
            loadSnapshot: async () => ({
                providers: { a: { models: {} } },
                models: {},
                generatedAt: "2026-01-01",
            }),
        };
        const catalog = await loadModelsDevCatalog(defaultModelsDevOptions(), undefined, deps);
        assert.equal(catalog.source, "snapshot");
        assert.equal(catalog.generatedAt, "2026-01-01");
    });

    it("returns null when both live and snapshot fail", async () => {
        const deps = {
            fetchCatalog: async () => {
                throw new Error("offline");
            },
            loadSnapshot: async () => {
                throw new Error("no pkg");
            },
        };
        assert.equal(await loadModelsDevCatalog(defaultModelsDevOptions(), undefined, deps), null);
    });

    it("passes modelTypes=all through to the client", async () => {
        let seen;
        const deps = {
            fetchCatalog: async (req) => {
                seen = req;
                return { providers: { a: { models: {} } }, models: {} };
            },
        };
        await loadModelsDevCatalog(defaultModelsDevOptions(), undefined, deps);
        assert.equal(seen.modelTypes, "all");
        assert.ok(seen.signal);
    });
});
