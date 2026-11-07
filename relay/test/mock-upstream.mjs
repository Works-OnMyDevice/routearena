// Mock TokenRouter for local integration tests: chat completions (stream/non-stream), models, Management API.
// Behaviors are selected per request through the user message text:
//   "nousage"  -> response without a usage object
//   "slow"     -> 300ms per chunk so the client can cancel mid-stream
//   "fail"     -> HTTP 500
// Prints its port on stdout as JSON {"port":N}. Management calls are recorded and exposed at GET /_mgmt_log.
import http from "node:http";

const mgmtLog = [];
const keys = new Map(); // key -> { name, unlimited_quota, remain_quota, used_quota, status }
const PRICE_TOKENS = { prompt_tokens: 1000, completion_tokens: 2000 }; // 1000 in + 2000 out
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    /* ignore */
  }
  const url = new URL(req.url, "http://x");
  const json = (status, obj) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === "/_mgmt_log") return json(200, { calls: mgmtLog, keys: [...keys.entries()].map(([k, v]) => ({ key_tail: k.slice(-4), ...v })) });
  if (url.pathname === "/_seed_key") {
    keys.set(body.key, { name: body.name, unlimited_quota: true, remain_quota: 0, used_quota: 0, status: 1 });
    return json(200, { ok: true });
  }
  if (url.pathname === "/v1/models") return json(200, { object: "list", data: [{ id: "openai/gpt-4o-mini" }, { id: "z-ai/glm-5.3-flash" }] });

  // Management API
  if (url.pathname === "/api/management/api-keys/quota" && req.method === "PUT") {
    mgmtLog.push({ path: "quota", key_tail: String(body.key).slice(-4), unlimited: body.unlimited_quota, remain: body.remain_quota });
    const k = keys.get(body.key);
    if (!k) return json(400, { success: false, message: "api key not found" });
    k.unlimited_quota = !!body.unlimited_quota;
    k.remain_quota = Number(body.remain_quota ?? 0);
    return json(200, { success: true, data: { name: k.name, key: "sk-****", status: 1, unlimited_quota: k.unlimited_quota, remain_quota: k.remain_quota, used_quota: k.used_quota, expired_time: -1 } });
  }
  if (url.pathname === "/api/management/api-keys/disable" && req.method === "PUT") {
    mgmtLog.push({ path: "disable", key_tail: String(body.key).slice(-4) });
    const k = keys.get(body.key);
    if (k) k.status = 2;
    return json(200, { success: true });
  }
  if (url.pathname === "/api/management/api-keys" && req.method === "GET") {
    mgmtLog.push({ path: "list" });
    return json(200, { success: true, data: { page: 1, page_size: 100, total: keys.size, items: [...keys.values()].map((k) => ({ name: k.name, key: "sk-****", status: k.status, unlimited_quota: k.unlimited_quota, remain_quota: k.remain_quota, used_quota: k.used_quota, expired_time: -1, created_time: 0 })) } });
  }

  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    if (req.headers.authorization !== "Bearer mock-master") return json(401, { error: { message: "Invalid token" } });
    const text = String(body.messages?.[body.messages.length - 1]?.content ?? "");
    if (text.includes("fail")) return json(500, { error: { message: "mock upstream failure" } });
    const usage = text.includes("nousage") ? undefined : PRICE_TOKENS;
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const slow = text.includes("slow");
      for (let i = 0; i < 20; i++) {
        send({ id: "x", choices: [{ index: 0, delta: { content: `tok${i} ` }, finish_reason: null }] });
        if (slow) await sleep(300);
      }
      send({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    return json(200, { id: "x", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "mock answer" }, finish_reason: "stop" }], ...(usage ? { usage } : {}) });
  }
  json(404, { error: "mock: not found" });
});
server.listen(0, "127.0.0.1", () => {
  console.log(JSON.stringify({ port: server.address().port }));
});
