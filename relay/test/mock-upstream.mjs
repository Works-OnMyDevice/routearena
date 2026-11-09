// Mock TokenRouter Management API for local integration tests. The relay never forwards chat traffic, so there is
// no /v1 surface here at all: any request to it is a bug and gets a 404.
// Prints its port on stdout as JSON {"port":N}. Management calls are recorded and exposed at GET /_mgmt_log.
// Test hooks:
//   POST /_seed_key   { key, name, fail_quota? }      create a key; fail_quota makes PUT quota return 500
//   POST /_seed_usage { rows: [{ request_id, key_name, model_name, prompt_tokens, completion_tokens, cost, created_at? }] }
//   POST /_usage_429  { on: boolean }                 make GET hour/usages answer 429 while on
import http from "node:http";

const mgmtLog = [];
const keys = new Map(); // key -> { name, unlimited_quota, remain_quota, used_quota, status, fail_quota }
const usages = [];
let usage429 = false;

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

  // ---- test hooks ----
  if (url.pathname === "/_mgmt_log") return json(200, { calls: mgmtLog, keys: [...keys.entries()].map(([k, v]) => ({ key_tail: k.slice(-4), ...v })) });
  if (url.pathname === "/_seed_key") {
    keys.set(body.key, { name: body.name, unlimited_quota: true, remain_quota: 0, used_quota: 0, status: 1, fail_quota: body.fail_quota === true });
    return json(200, { ok: true });
  }
  if (url.pathname === "/_seed_usage") {
    const now = Math.floor(Date.now() / 1000);
    for (const r of body.rows ?? []) usages.push({ created_at: now, ...r });
    return json(200, { ok: true, total: usages.length });
  }
  if (url.pathname === "/_usage_429") {
    usage429 = body.on === true;
    return json(200, { ok: true, usage429 });
  }

  // ---- Management API ----
  if (req.headers.authorization !== "Bearer mock-mgmt" && url.pathname.startsWith("/api/management")) return json(401, { success: false, message: "management key is invalid" });
  if (url.pathname === "/api/management/api-keys/quota" && req.method === "PUT") {
    mgmtLog.push({ path: "quota", key_tail: String(body.key).slice(-4), unlimited: body.unlimited_quota, remain: body.remain_quota });
    const k = keys.get(body.key);
    if (!k) return json(400, { success: false, message: "api key not found" });
    if (k.fail_quota) return json(500, { success: false, message: "mock: quota service unavailable" });
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
  if (url.pathname === "/api/management/hour/usages" && req.method === "GET") {
    const start = Number(url.searchParams.get("start_timestamp"));
    const end = Number(url.searchParams.get("end_timestamp"));
    const page = Number(url.searchParams.get("page") ?? 1);
    const size = Number(url.searchParams.get("page_size") ?? 100);
    mgmtLog.push({ path: "usages", start, end, page });
    if (usage429) return json(429, { success: false, message: "too many requests, please try again later" });
    if (end - start > 3600) return json(400, { success: false, message: "time range must not exceed 1 hour" });
    const inRange = usages.filter((r) => r.created_at >= start && r.created_at <= end);
    return json(200, { success: true, data: { page, page_size: size, total: inRange.length, total_cost: inRange.reduce((s, r) => s + Number(r.cost ?? 0), 0), items: inRange.slice((page - 1) * size, page * size) } });
  }

  json(404, { error: "mock: not found" });
});
server.listen(0, "127.0.0.1", () => {
  console.log(JSON.stringify({ port: server.address().port }));
});
