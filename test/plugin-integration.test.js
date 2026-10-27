// End-to-end test of the opencode plugin wiring (gateway discovery +
// models.dev enrichment) with a mocked Opencode ctx, a local fake gateway,
// and an injected models.dev catalog (warmed into the module cache, so no
// network is touched).
// Run: npm test
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearModelsDevCache, defaultModelsDevOptions, loadModelsDevCatalog } from "../dist/models-dev.js";

function labGpt4o() {
    return {
        id: "gpt-4o",
        name: "GPT-4o",
        reasoning: false,
        reasoning_options: [],
        tool_call: true,
        attachment: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 128000, output: 16384 },
        cost: { input: 2.5, output: 10, cache_read: 1.25 },
        family: "gpt",
    };
}

function embeddingModel() {
    return {
        id: "text-embedding-3-small",
        type: "embedding",
        name: "Text Embedding 3 Small",
        reasoning: false,
        tool_call: false,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 8191, output: 0 },
        cost: { input: 0.02, output: 0 },
    };
}

function reasoningModel() {
    return {
        id: "test-reasoner",
        name: "Test Reasoner",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
        tool_call: true,
        attachment: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 200000, output: 32000 },
        cost: { input: 3, output: 15 },
        family: "test",
    };
}

const FAKE_CATALOG = {
    providers: {
        openai: {
            models: {
                "gpt-4o": labGpt4o(),
                "text-embedding-3-small": embeddingModel(),
                "test-reasoner": reasoningModel(),
            },
        },
        reseller: {
            models: {
                "openai/gpt-4o": {
                    ...labGpt4o(),
                    canonical_model_id: "openai/gpt-4o",
                    cost: { input: 99, output: 99 },
                    status: "deprecated",
                },
            },
        },
    },
    models: {},
    source: "live",
};

// Gateway payload per test run (mutable so preferGateway cases can inject
// conflicting raw metadata).
let gatewayModels = [{ id: "gpt-4o" }, { id: "text-embedding-3-small" }, { id: "local-custom-model" }, { id: "test-reasoner" }];

let server;
let gatewayBase;

async function startGateway() {
    server = http.createServer((req, res) => {
        if ((req.url ?? "").endsWith("/models")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ data: gatewayModels }));
            return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    gatewayBase = `http://127.0.0.1:${server.address().port}/v1`;
}

function makeCtx() {
    const providers = new Map(); // id -> { info, models: Map }
    let transformFn = null;
    let reloadedResolve;
    const reloaded = new Promise((resolve) => (reloadedResolve = resolve));
    const editor = {
        get: (id) => providers.get(id),
        add: ({ info, models }) => {
            const m = new Map();
            for (const model of models) m.set(model.id, model);
            providers.set(info.id, { info: { ...info }, models: m });
        },
        update: (id, fn) => fn(providers.get(id).info),
        models: {
            set: (pid, models) => {
                const rec = providers.get(pid);
                const m = new Map();
                for (const model of models) m.set(model.id, model);
                if (rec) rec.models = m;
                else providers.set(pid, { info: { id: pid }, models: m });
            },
        },
    };
    const ctx = {
        location: { project: { directory: process.cwd() }, directory: process.cwd() },
        provider: {
            transform: async (fn) => {
                transformFn = fn;
            },
            reload: async () => {
                transformFn(editor);
                reloadedResolve();
            },
            list: async () => [],
        },
        session: { hook: async () => {} },
    };
    return { ctx, providers, reloaded };
}

async function writeConfig(dir, json) {
    const p = path.join(dir, ".opencode", "esuyo-opencode-custom-provider.json");
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(json));
    return p;
}

async function runSetup(configJson, { envKey = "TEST_GATEWAY_KEY", envVal = "test-key-123" } = {}) {
    const { default: plugin } = await import("../dist/index.js");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-md-"));
    const configPath = await writeConfig(dir, configJson);
    const { ctx, providers, reloaded } = makeCtx();
    const prevEnv = process.env.OPENCODE_CUSTOM_PROVIDER_CONFIG;
    const prevKey = process.env[envKey];
    process.env.OPENCODE_CUSTOM_PROVIDER_CONFIG = configPath;
    process.env[envKey] = envVal;
    try {
        await plugin.setup(ctx);
        await Promise.race([
            reloaded,
            new Promise((_, rej) => setTimeout(() => rej(new Error("timed out waiting for provider reload")), 10000)),
        ]);
    } finally {
        if (prevEnv === undefined) delete process.env.OPENCODE_CUSTOM_PROVIDER_CONFIG;
        else process.env.OPENCODE_CUSTOM_PROVIDER_CONFIG = prevEnv;
        if (prevKey === undefined) delete process.env[envKey];
        else process.env[envKey] = prevKey;
        await fs.rm(dir, { recursive: true, force: true });
    }
    return providers;
}

describe("opencode plugin models.dev integration", () => {
    before(async () => {
        await startGateway();
        clearModelsDevCache();
        // Warm the module cache with the fake catalog under the default key
        // (baseUrl https://models.dev + modelTypes all) so setup never hits network.
        await loadModelsDevCatalog(defaultModelsDevOptions(), undefined, {
            fetchCatalog: async () => structuredClone(FAKE_CATALOG),
        });
    });

    after(() => server.close());

    it("enriches discovered models and prefers lab entries", async () => {
        gatewayModels = [{ id: "gpt-4o" }, { id: "text-embedding-3-small" }, { id: "local-custom-model" }, { id: "test-reasoner" }];
        const providers = await runSetup({
            providers: {
                "test-gateway": { baseURL: gatewayBase, apiKey: "{env:TEST_GATEWAY_KEY}" },
            },
        });
        const rec = providers.get("test-gateway");
        assert.ok(rec, "provider should be registered");
        assert.equal(rec.models.size, 4);

        const gpt = rec.models.get("gpt-4o");
        assert.equal(gpt.name, "GPT-4o"); // catalog name beats humanized id
        assert.deepEqual(gpt.capabilities.input, ["text", "image"]);
        assert.equal(gpt.capabilities.tools, true);
        assert.equal(gpt.limit.context, 128000);
        assert.equal(gpt.limit.output, 16384);
        assert.equal(gpt.family, "gpt");
        assert.equal(gpt.cost[0].input, 2.5); // lab list price, not the reseller mirror (99)
        assert.deepEqual(gpt.variants, []); // non-reasoning model: no variants
        assert.ok(!gpt.modelsDev, "no stray metadata keys should leak onto Model.Info");

        const emb = rec.models.get("text-embedding-3-small");
        assert.equal(emb.limit.context, 8191); // factual fields still enriched...
        assert.deepEqual(emb.capabilities.input, ["text", "image"]); // ...capabilities untouched
        assert.equal(emb.capabilities.tools, true);
        assert.deepEqual(emb.variants ?? [], []);

        const custom = rec.models.get("local-custom-model");
        assert.equal(custom.name, "Local Custom Model"); // humanized fallback, no catalog match
        assert.equal(custom.limit.context, 200000); // built-in default preserved

        // Reasoning effort levels surface as selectable variants (/variants).
        const reasoner = rec.models.get("test-reasoner");
        assert.deepEqual(reasoner.variants, [
            { id: "low", settings: { reasoningEffort: "low" } },
            { id: "medium", settings: { reasoningEffort: "medium" } },
            { id: "high", settings: { reasoningEffort: "high" } },
        ]);
    });

    it("static variants replace catalog variants; variants:false disables them", async () => {
        gatewayModels = [{ id: "test-reasoner" }, { id: "gpt-4o" }];
        const providers = await runSetup({
            providers: {
                "static-gateway": {
                    baseURL: gatewayBase,
                    apiKey: "k",
                    models: {
                        "test-reasoner": {
                            variants: [{ id: "custom", settings: { reasoningEffort: "high" } }],
                        },
                    },
                },
                "novar-gateway": { baseURL: gatewayBase, apiKey: "k", modelsDev: { variants: false } },
            },
        });
        // Static config wins: catalog variants replaced...
        assert.deepEqual(
            providers.get("static-gateway").models.get("test-reasoner").variants,
            [{ id: "custom", settings: { reasoningEffort: "high" } }],
        );
        // ...but other enrichment (limits) still applies to that model.
        assert.equal(providers.get("static-gateway").models.get("test-reasoner").limit.context, 200000);
        // Per-provider opt-out: enriched, but no variants.
        const novar = providers.get("novar-gateway").models.get("test-reasoner");
        assert.equal(novar.limit.context, 200000);
        assert.deepEqual(novar.variants ?? [], []);
    });

    it("gateway metadata wins by default, catalog wins with preferGateway:false", async () => {
        gatewayModels = [{ id: "gpt-4o", context_length: 64000, display_name: "Gateway 4o" }];
        const base = { providers: { "test-gateway": { baseURL: gatewayBase, apiKey: "k" } } };

        const gw = await runSetup(structuredClone(base));
        assert.equal(gw.get("test-gateway").models.get("gpt-4o").limit.context, 64000);
        assert.equal(gw.get("test-gateway").models.get("gpt-4o").name, "Gateway 4o");

        const cat = await runSetup({ ...structuredClone(base), modelsDev: { preferGateway: false } });
        assert.equal(cat.get("test-gateway").models.get("gpt-4o").limit.context, 128000);
    });

    it("modelDefaults are fallbacks; static overrides are hard pins", async () => {
        gatewayModels = [{ id: "gpt-4o" }, { id: "local-custom-model" }, { id: "unknown-model-zzz" }];
        const providers = await runSetup({
            providers: {
                "test-gateway": {
                    baseURL: gatewayBase,
                    apiKey: "k",
                    // Generic fallback must not shrink a model the catalog knows
                    // (real bug: 256k fallback hid Muse's 1M context).
                    modelDefaults: { limit: { context: 111, output: 222 } },
                    models: {
                        "gpt-4o": { name: "Pinned Name" },
                        // Static override is an explicit hard pin and still wins.
                        "local-custom-model": { limit: { context: 999, output: 888 } },
                    },
                },
            },
        });
        const models = providers.get("test-gateway").models;
        const gpt = models.get("gpt-4o");
        assert.equal(gpt.name, "Pinned Name");
        assert.equal(gpt.limit.context, 128000); // catalog wins over modelDefaults
        assert.equal(gpt.limit.output, 16384);

        const custom = models.get("local-custom-model"); // no catalog match
        assert.equal(custom.limit.context, 999); // static override
        assert.equal(custom.limit.output, 888);

        const unknown = models.get("unknown-model-zzz");
        assert.equal(unknown.limit.context, 111); // fallback applies without catalog data
        assert.equal(unknown.limit.output, 222);
    });

    it("modelsDev:false opts a provider out", async () => {
        gatewayModels = [{ id: "gpt-4o" }];
        const providers = await runSetup({
            providers: {
                "test-gateway": { baseURL: gatewayBase, apiKey: "k", modelsDev: false },
            },
        });
        const gpt = providers.get("test-gateway").models.get("gpt-4o");
        assert.equal(gpt.name, "Gpt 4o");
        assert.equal(gpt.limit.context, 200000);
    });
});

// Opencode resolves a configured local plugin *directory* by importing its
// `server` or `index` module — `package.json` "main" is not consulted. The
// repo-root `index.js` exists for that; if it breaks, local installs silently
// register nothing (no providers, no error). This guards against that.
describe("repo root local-plugin entrypoint", () => {
    it("re-exports the built plugin default with id + setup", async () => {
        const mod = await import("../index.js");
        assert.ok(mod.default, "index.js must export a default plugin definition");
        assert.equal(mod.default.id, "esuyo-custom-provider");
        assert.equal(typeof mod.default.setup, "function");
        const md = await import("../dist/models-dev.js");
        assert.equal(typeof md.clearModelsDevCache, "function");
    });
});
