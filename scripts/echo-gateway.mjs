// Echo gateway — verifies `x-opencode-session` injection from the plugin's
// `chat.headers` hook. Plain HTTP on localhost so headers are visible.
//
// Usage:
//   node scripts/echo-gateway.mjs [--port 4311] [--verbose]
//   npm run echo-gateway -- --port 4311
//
// Then point a test provider at it (in esuyo-opencode-custom-provider.json):
//   { "providers": { "echo-test": { "baseURL": "http://127.0.0.1:4311/v1", "apiKey": "test" } } }
// And run:
//   opencode debug config
//   opencode run "say hi" --model echo-test/echo-model
//
// Every POST /v1/chat/completions line below should show
//   x-opencode-session: ses_...
// If it shows (MISSING), the hook isn't firing (plugin not loaded / provider
// not managed / injection disabled).

import http from "node:http";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const idx = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (idx === -1) return fallback;
  const eq = args[idx].indexOf("=");
  if (eq !== -1) return args[idx].slice(eq + 1);
  return args[idx + 1] ?? fallback;
}
const PORT = Number(argValue("--port", process.env.PORT ?? "4311")) || 4311;
const VERBOSE = args.includes("--verbose") || args.includes("-v");

let chatSeen = 0;
let chatWithSession = 0;

const server = http.createServer((req, res) => {
  const session = req.headers["x-opencode-session"];
  const isChat = req.method === "POST" && /\/chat\/completions$/.test(req.url ?? "");

  if (isChat) {
    chatSeen++;
    if (typeof session === "string" && session) chatWithSession++;
  }

  console.log(
    `${req.method} ${req.url}  x-opencode-session: ${typeof session === "string" && session ? session : "(MISSING)"}`,
  );
  if (VERBOSE) {
    for (const [k, v] of Object.entries(req.headers)) console.log(`    ${k}: ${v}`);
  }

  if ((req.url ?? "").endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "echo-model" }] }));
    return;
  }

  if (isChat) {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      if (!body.includes('"stream":true')) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-echo",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "echo-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "hello from echo gateway" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
          }),
        );
      } else {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const chunk = (content, finish) =>
          `data: ${JSON.stringify({
            id: "chatcmpl-echo",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "echo-model",
            choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish ?? null }],
          })}\n\n`;
        res.end(`${chunk("hello from echo gateway", null)}${chunk("", "stop")}data: [DONE]\n\n`);
      }
    });
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found (echo gateway only serves /models and /chat/completions)" }));
});

server.on("clientError", (_err, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));

server.listen(PORT, "127.0.0.1", () => {
  console.log(`echo gateway on http://127.0.0.1:${PORT}`);
  console.log(`models URL: http://127.0.0.1:${PORT}/v1/models`);
  console.log(`waiting for requests — chat completions with session header: ${chatWithSession}/${chatSeen}`);
});

process.on("SIGINT", () => {
  console.log(`\nsummary: ${chatWithSession}/${chatSeen} chat completions carried x-opencode-session`);
  process.exit(0);
});
