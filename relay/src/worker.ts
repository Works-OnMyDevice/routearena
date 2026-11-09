import { emailsGet, expireSweep, logGet, poolGet, poolPost, statsGet } from "../api/admin";
import { GET as balance } from "../api/balance";
import { POST as claim } from "../api/claim";
import { GET as claimStatus } from "../api/claim/status";
import { GET as claimUsage } from "../api/claim/usage";
import { GET as index } from "../api/index";
import { GET as llms } from "../api/llms";
import { POST as publish } from "../api/publish";
import { GET as report } from "../api/r";
import { GET as verify } from "../api/verify";
import { json, setEnv } from "../lib/env";
import { runWithState } from "../lib/store";
import { RelayState } from "./state";

export { RelayState };

export interface Env {
  RELAY: DurableObjectNamespace<RelayState>;
  [k: string]: unknown;
}

function stubFor(env: Env) {
  setEnv(env);
  return env.RELAY.get(env.RELAY.idFromName("global"));
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return runWithState(stubFor(env), (p) => ctx.waitUntil(p), () => route(req));
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await runWithState(stubFor(env), (p) => ctx.waitUntil(p), () => expireSweep().then(() => undefined));
  },
};

async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const m = req.method;
    try {
      if (path === "/" && m === "GET") return index();
      if (path === "/llms.txt" && m === "GET") return llms();
      if (path === "/api/claim" && m === "POST") return claim(req);
      if (path === "/api/claim/status" && m === "GET") return claimStatus(req);
      if (path === "/api/claim/usage" && m === "GET") return claimUsage(req);
      if (path === "/api/verify" && m === "GET") return verify(req);
      if (path === "/api/balance" && m === "GET") return balance(req);
      if (path === "/api/publish" && m === "POST") return publish(req);
      const r = path.match(/^\/r\/([a-f0-9]{16})$/);
      if (r && m === "GET") {
        url.searchParams.set("id", r[1]);
        return report(new Request(url.toString(), req));
      }
      if (path === "/api/admin/pool" && m === "GET") return poolGet(req);
      if (path === "/api/admin/pool" && m === "POST") return poolPost(req);
      if (path === "/api/admin/stats" && m === "GET") return statsGet(req);
      if (path === "/api/admin/log" && m === "GET") return logGet(req);
      if (path === "/api/admin/emails" && m === "GET") return emailsGet(req);
      if (path === "/health" && m === "GET") return json({ ok: true });
      return json({ error: "not found" }, 404);
    } catch (e) {
      console.log(JSON.stringify({ t: new Date().toISOString(), event: "unhandled", path, err: String(e).slice(0, 200) }));
      return json({ error: "internal error" }, 500);
    }
}
