#!/usr/bin/env node
// Print the exact model JSON Opencode sees after this plugin's transforms run.
//
//   node scripts/models-json.mjs                        # all models
//   node scripts/models-json.mjs --provider esuyo-gateway
//   node scripts/models-json.mjs --id muse-spark-1.3    # substring filter
//   node scripts/models-json.mjs --server http://127.0.0.1:4096 --password <pw>
//
// By default it starts a private `opencode serve`, waits for the plugin to
// finish its background sync (gateway fetch + models.dev enrichment), queries
// GET /api/model, prints the JSON, and stops the server. This is the same data
// the TUI/model picker consumes: limit, capabilities, cost, variants, etc.

import { spawn } from "node:child_process"
import { Buffer } from "node:buffer"

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`))
  if (i === -1) return fallback
  const eq = args[i].indexOf("=")
  return eq === -1 ? (args[i + 1] ?? fallback) : args[i].slice(eq + 1)
}

const providerFilter = arg("--provider", "")
const idFilter = arg("--id", "")
const timeoutMs = Number(arg("--timeout", "60000")) || 60000
const directory = arg("--directory", process.cwd())
const serverArg = arg("--server", "")
const passwordArg = arg("--password", "")

if (args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      "Usage: node scripts/models-json.mjs [options]",
      "",
      "  --provider <id>     only models from this provider (e.g. esuyo-gateway)",
      "  --id <substring>    only model ids containing this text",
      "  --directory <path>  location to query (default: cwd)",
      "  --timeout <ms>      wait budget for plugin sync (default: 60000)",
      "  --server <url>      use an already-running server instead of starting one",
      "  --password <pw>     server password for --server",
      "  --show-secrets      do not redact apiKey/authorization fields",
    ].join("\n"),
  )
  process.exit(0)
}

function authHeader(password) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
}

async function queryModels(baseUrl, password) {
  const url = new URL("/api/model", baseUrl)
  url.searchParams.set("location[directory]", directory)
  const res = await fetch(url, { headers: { Authorization: authHeader(password) } })
  if (!res.ok) throw new Error(`GET ${url.pathname} -> ${res.status} ${res.statusText}`)
  const body = await res.json()
  return Array.isArray(body) ? body : (body.data ?? [])
}

function select(models) {
  return models.filter(
    (m) =>
      (!providerFilter || m.providerID === providerFilter) &&
      (!idFilter || String(m.id ?? m.modelID ?? "").includes(idFilter)),
  )
}

const showSecrets = args.includes("--show-secrets")

/** Redact credentials (apiKey, auth headers) before printing. */
function redact(value) {
  if (showSecrets) return value
  const secretKey = /^(apikey|api_key|authorization|x-api-key|password|token)$/i
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk)
    if (!node || typeof node !== "object") return node
    const out = {}
    for (const [k, v] of Object.entries(node)) {
      out[k] = secretKey.test(k) && typeof v === "string" ? "<redacted>" : walk(v)
    }
    return out
  }
  return walk(value)
}

async function waitFor(baseUrl, password) {
  const started = Date.now()
  let last = []
  while (Date.now() - started < timeoutMs) {
    try {
      last = await queryModels(baseUrl, password)
      // The plugin syncs in the background: a provider appears only after its
      // gateway fetch (and models.dev enrichment) completes.
      if (providerFilter ? select(last).length > 0 : last.length > 0) return last
    } catch {
      // server still booting
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return last
}

if (serverArg) {
  if (!passwordArg) {
    console.error("[models-json] --server requires --password (see `opencode serve` output)")
    process.exit(2)
  }
  const models = await waitFor(serverArg, passwordArg)
  const selected = select(models)
  process.stdout.write(JSON.stringify(redact(selected), null, 2) + "\n")
  process.exit(selected.length > 0 ? 0 : 1)
}

const child = spawn("opencode", ["serve", "--port", "0"], {
  cwd: directory,
  stdio: ["ignore", "pipe", "pipe"],
})

let output = ""
let settled = false
const stop = () => {
  if (settled) return
  settled = true
  child.kill("SIGTERM")
}
process.on("exit", stop)
process.on("SIGINT", () => {
  stop()
  process.exit(130)
})

function onData(chunk) {
  output += String(chunk)
  const url = output.match(/server listening on (https?:\/\/\S+)/)?.[1]
  const password = output.match(/server password (\S+)/)?.[1]
  if (!url || !password) return
  child.stdout.off("data", onData)
  child.stderr.off("data", onData)
  waitFor(url.replace(/\/+$/, ""), password)
    .then((models) => {
      const selected = select(models)
      process.stdout.write(JSON.stringify(redact(selected), null, 2) + "\n")
      if (selected.length === 0) {
        console.error(
          `[models-json] no models matched (provider=${providerFilter || "*"}, id=${idFilter || "*"}) after ${timeoutMs}ms`,
        )
      }
      stop()
      process.exit(selected.length > 0 ? 0 : 1)
    })
    .catch((err) => {
      console.error(`[models-json] ${err?.message ?? err}`)
      stop()
      process.exit(1)
    })
}
child.stdout.on("data", onData)
child.stderr.on("data", onData)
child.on("exit", (code) => {
  if (settled) return
  settled = true
  console.error(`[models-json] opencode serve exited (code ${code}) before becoming ready:\n${output}`)
  process.exit(1)
})
