import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import {
  CliError,
  DEFAULT_CONFIG,
  KEY_ENVS,
  PRIMARIES,
  RELAY_URL,
  REPORT_DIR,
  configDir,
  ensureConfigDir,
  loadConfig,
  loadCredits,
  loadDotenv,
  logPath,
  pidPath,
  pkgRoot,
  pkgVersion,
  redact,
  saveConfig,
  type Config,
  type PrimaryId,
} from "./config.js";
import { fetchBalance, startClaim, waitForVerification } from "./credits/claim.js";
import { startProxy } from "./proxy/server.js";
import { buildReport } from "./report/build.js";
import { fmtMs, fmtPct, fmtUsd } from "./report/html.js";
import { publishAggregates } from "./report/publish.js";
import { loadTargets, targetStatus, unknownTargetIds } from "./targets/index.js";

const program = new Command();
const VERSION = pkgVersion();

function agentProtocol(): string {
  for (const p of [path.join(pkgRoot(), "AGENTS.md"), path.join(path.dirname(fileURLToPath(import.meta.url)), "AGENTS.md")]) {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      /* next */
    }
  }
  return "";
}

type Out = { json: boolean };
function out(o: Out, obj: Record<string, unknown>, human: () => void): void {
  if (o.json) process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  else human();
}
function fail(o: Out, err: unknown): never {
  const e = err instanceof CliError ? err : new CliError(err instanceof Error ? err.message : String(err), "If this keeps happening, open an issue at https://github.com/Works-OnMyDevice/routearena/issues with the command you ran.");
  const payload = { error: redact(e.message), fix: redact(e.fix) };
  if (o.json) process.stdout.write(JSON.stringify(payload) + "\n");
  else process.stderr.write(`error: ${payload.error}\n  fix: ${payload.fix}\n`);
  process.exit(e.exitCode);
}
const log = (s: string) => process.stderr.write(s + "\n");

function jsonOpt(cmd: Command): Command {
  return cmd.option("--json", "print a single JSON object to stdout", false);
}


/** Parse repeated `--map <target>:<model>=<targetModel>` into a model_map. */
function parseMaps(raw: string[] | undefined, into: Record<string, Record<string, string>> = {}): Record<string, Record<string, string>> {
  for (const m of raw ?? []) {
    const match = /^([^:=\s]+):([^=\s]+)=(\S+)$/.exec(m.trim());
    if (!match) throw new CliError(`Cannot parse --map "${m}".`, "Format: --map <target>:<model>=<targetModel>, e.g. --map groq:openai/gpt-4o-mini=gpt-4o-mini. Repeat --map for each model.");
    const [, target, model, targetModel] = match;
    const unknown = unknownTargetIds([target]);
    if (unknown.length) throw new CliError(`Unknown target in --map: ${target}`, `Known targets: ${loadTargets().map((t) => t.id).join(", ")}`);
    into[target] = { ...(into[target] ?? {}), [model.toLowerCase()]: targetModel };
  }
  return into;
}

program
  .name("routearena")
  .description("See what your LLM traffic costs on other providers, from what each provider reports. Your keys stay on your machine.")
  .version(VERSION)
  .addHelpText("after", `\nExamples:\n  $ npx routearena@latest check --json\n  $ npx routearena@latest init --primary openrouter --free-credits --email you@example.com\n  $ npx routearena@latest start          # then set baseURL to http://localhost:4000/v1\n  $ npx routearena@latest report --publish\n\n${agentProtocol()}`);

// ---------- check ----------
jsonOpt(program.command("check"))
  .description("verify Node, find keys in env or .env, list usable primaries and targets")
  .addHelpText("after", "\nExample:\n  $ routearena check --json")
  .action(async (o: Out) => {
    try {
      const found = loadDotenv();
      const nodeVer = process.versions.node;
      const major = Number(nodeVer.split(".")[0]);
      const primaries = (Object.keys(PRIMARIES) as PrimaryId[]).filter((p) => !!process.env[PRIMARIES[p].keyEnv]);
      const credits = loadCredits();
      const cfg = loadConfig();
      const targets: Record<string, string> = {};
      for (const t of loadTargets()) targets[t.id] = targetStatus(t, process.env, credits);
      const keysFound = KEY_ENVS.filter((k) => !!process.env[k]);
      const primaryBalance = await probePrimaryBalance(process.env.OPENROUTER_API_KEY, () => { if (!o.json) log("  openrouter balance reads $0.00; sending one 1-token request to openai/gpt-4o-mini to check whether requests are actually refused…"); });
      let creditsInfo: Record<string, unknown> = { claimed: false };
      if (credits) {
        creditsInfo = { claimed: true, expires_at: credits.expiresAt, budget_usd: credits.budgetUsd };
        try {
          const b = await fetchBalance(credits);
          creditsInfo = { ...creditsInfo, remaining_usd: Number(b.remaining_usd.toFixed(4)), spent_usd: Number(b.spent_usd.toFixed(4)) };
        } catch {
          creditsInfo.remaining_usd = null;
        }
      }
      const result = {
        node: nodeVer,
        node_ok: major >= 20,
        version: VERSION,
        keys_found: keysFound,
        keys_from_dotenv: found.filter((k) => (KEY_ENVS as readonly string[]).includes(k)),
        primaries,
        primary_balance: primaryBalance,
        targets,
        credits: creditsInfo,
        config: cfg ? { exists: true, primary: cfg.primary, sample: cfg.sample, port: cfg.port } : { exists: false },
        log_records: fs.existsSync(logPath()) ? fs.readFileSync(logPath(), "utf8").split("\n").filter(Boolean).length : 0,
        ready: { live: primaries.length > 0 && Object.values(targets).some((s) => s !== "no-key") },
        next: primaryBalance?.empty ? "Your OpenRouter balance is at or below zero. OpenRouter reserves an estimate for every in-flight request and refuses with 402 when the balance cannot cover it, so parallel requests fail first. Add credits at openrouter.ai/settings/credits, then run check again." : nextStep(primaries, targets, cfg),
      };
      out(o, result, () => {
        log(`routearena v${VERSION} · node ${nodeVer}${major < 20 ? " (needs 20+)" : ""}`);
        log(`primaries: ${primaries.length ? primaries.join(", ") : "none (set OPENROUTER_API_KEY or OPENAI_API_KEY)"}`);
        if (primaryBalance) log(`  openrouter balance: ${primaryBalance.remaining_usd === null ? "unknown" : fmtUsd(primaryBalance.remaining_usd)}${primaryBalance.empty ? "  (at or below zero: OpenRouter will refuse parallel requests with 402)" : primaryBalance.note ? `  (${primaryBalance.note})` : ""}`);
        for (const [id, s] of Object.entries(targets)) log(`  target ${id.padEnd(12)} ${s}`);
        log(`credits: ${credits ? `claimed, expires ${credits.expiresAt.slice(0, 10)}${"remaining_usd" in creditsInfo && creditsInfo.remaining_usd !== null ? `, ${fmtUsd(creditsInfo.remaining_usd as number)} left` : ""}` : "not claimed"}`);
        log(`config: ${cfg ? configDir() : "none (run routearena init)"}`);
        log(`next: ${result.next}`);
      });
    } catch (e) {
      fail(o, e);
    }
  });

/**
 * OpenRouter exposes purchased credit at /api/v1/credits, but promotional and free-tier credit does not appear there
 * (measured 2026-11-08: total_credits 0 while paid models kept answering). So a non-positive balance is confirmed with
 * one minimal request and reported as empty only when OpenRouter actually refuses with 402.
 */
async function probePrimaryBalance(key: string | undefined, announce?: () => void): Promise<{ provider: "openrouter"; remaining_usd: number | null; empty: boolean; note?: string; probe?: { sent: true; model: string; status: number; error?: string } } | null> {
  if (!key) return null;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/credits", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return { provider: "openrouter", remaining_usd: null, empty: false };
    const j: any = await res.json();
    const total = Number(j?.data?.total_credits), used = Number(j?.data?.total_usage);
    if (!Number.isFinite(total) || !Number.isFinite(used)) return { provider: "openrouter", remaining_usd: null, empty: false };
    const remaining = Number((total - used).toFixed(4));
    if (remaining > 0) return { provider: "openrouter", remaining_usd: remaining, empty: false };
    announce?.();
    const probe = await openrouterCreditProbe(key);
    const base = { provider: "openrouter" as const, remaining_usd: remaining, probe };
    if (probe.status === 402) return { ...base, empty: true, note: "the balance endpoint shows no purchased credit and a 1-token test request was refused with 402" };
    if (probe.status >= 200 && probe.status < 300) return { ...base, empty: false, note: "the balance endpoint shows no purchased credit, but a 1-token test request succeeded (promotional or free-tier credit is not shown there)" };
    return { ...base, empty: false, note: `the balance endpoint shows no purchased credit; a 1-token test request did not get a clear answer (${probe.status ? "HTTP " + probe.status : probe.error ?? "no response"}), so the balance is unknown` };
  } catch {
    return { provider: "openrouter", remaining_usd: null, empty: false };
  }
}

/** One 1-token request to a common model. Only sent when the balance endpoint reads zero. */
async function openrouterCreditProbe(key: string): Promise<{ sent: true; model: string; status: number; error?: string }> {
  const model = "openai/gpt-4o-mini";
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "OK" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15_000),
    });
    return { sent: true, model, status: res.status };
  } catch (e) {
    return { sent: true, model, status: 0, error: String((e as Error)?.name ?? e).slice(0, 60) };
  }
}

function nextStep(primaries: string[], targets: Record<string, string>, cfg: Config | null): string {
  if (!primaries.length) return "Add OPENROUTER_API_KEY or OPENAI_API_KEY to .env, then run check again.";
  if (!Object.values(targets).some((s) => s !== "no-key")) return "No target is reachable. Run: routearena init --primary " + primaries[0] + " --free-credits --email you@example.com  (or add a target key such as GROQ_API_KEY).";
  if (!cfg) return "Run: routearena init --primary " + primaries[0];
  return "Run: routearena start   (then point baseURL at http://localhost:" + cfg.port + "/v1)";
}

// ---------- init ----------
jsonOpt(program.command("init"))
  .description("write .routearena/config.json; optionally claim free TokenRouter mirror credits")
  .addOption(new Option("--primary <provider>", "openrouter or openai").choices(["openrouter", "openai"]))
  .option("--sample <fraction>", "fraction of eligible requests to mirror (0..1)", parseFloat)
  .option("--port <port>", "proxy port", (v) => parseInt(v, 10))
  .option("--targets <ids>", "comma-separated target ids to mirror to (default: every target with a key or credits)")
  .option("--map <spec>", "send <model> to <target> as <targetModel>: --map <target>:<model>=<targetModel> (repeatable; default: the same id)", (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option("--free-credits", "claim $1 of free TokenRouter mirror credits (needs --email)")
  .option("--email <email>", "email for the free-credits magic link")
  .option("--no-credits", "skip free credits")
  .option("--resume <claimId>", "resume waiting on a claim you already started")
  .addHelpText("after", "\nExamples:\n  $ routearena init --primary openrouter --free-credits --email you@example.com\n  $ routearena init --primary openai --no-credits --sample 0.25\n  $ routearena init --map groq:openai/gpt-4o-mini=gpt-4o-mini --map groq:meta-llama/llama-3.1-8b-instruct=llama-3.1-8b-instant")
  .action(async (opts: any) => {
    const o: Out = { json: !!opts.json };
    try {
      loadDotenv();
      const existing = loadConfig();
      let primary: PrimaryId | undefined = opts.primary;
      if (!primary) {
        primary = existing?.primary ?? ((Object.keys(PRIMARIES) as PrimaryId[]).find((p) => !!process.env[PRIMARIES[p].keyEnv]) ?? "openrouter");
      }
      if (opts.sample !== undefined && !(opts.sample >= 0 && opts.sample <= 1)) throw new CliError("--sample must be between 0 and 1.", "Example: --sample 0.1 mirrors 10% of requests.");
      let targets: string[] | undefined = existing?.targets;
      if (opts.targets) {
        targets = String(opts.targets).split(",").map((s: string) => s.trim()).filter(Boolean);
        const unknown = unknownTargetIds(targets);
        if (unknown.length) throw new CliError(`Unknown target(s): ${unknown.join(", ")}`, `Known targets: ${loadTargets().map((t) => t.id).join(", ")}`);
      }
      const model_map = parseMaps(opts.map, { ...(existing?.model_map ?? {}) });
      const cfg: Config = {
        ...DEFAULT_CONFIG,
        ...(existing ?? {}),
        primary,
        sample: opts.sample ?? existing?.sample ?? DEFAULT_CONFIG.sample,
        port: opts.port ?? existing?.port ?? DEFAULT_CONFIG.port,
        targets,
        ...(Object.keys(model_map).length ? { model_map } : {}),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      saveConfig(cfg);
      ensureConfigDir();

      let credits: Record<string, unknown> = { claimed: !!loadCredits() };
      if (opts.freeCredits || opts.resume) {
        if (opts.credits === false) throw new CliError("--free-credits and --no-credits conflict.", "Pass one of them.");
        if (!opts.email && !opts.resume) throw new CliError("--free-credits needs --email.", "Example: --free-credits --email you@example.com");
        let claimId: string = opts.resume;
        if (!claimId) {
          const c = await startClaim(opts.email);
          claimId = c.id;
          if (!o.json) log(`A verification link was sent to ${opts.email}. Click it; waiting up to 10 minutes...`);
          else log(JSON.stringify({ event: "claim_sent", id: claimId, email: opts.email, waiting_minutes: 10 }));
        }
        const cr = await waitForVerification(claimId, { onTick: (ms) => (!o.json && ms % 30_000 < 3_000 ? log(`  still waiting (${Math.round(ms / 1000)}s)`) : undefined) });
        credits = { claimed: true, budget_usd: cr.budgetUsd, expires_at: cr.expiresAt };
      }
      out(o, { ok: true, config: cfg, config_path: path.join(configDir(), "config.json"), credits, relay: RELAY_URL }, () => {
        log(`wrote ${path.join(configDir(), "config.json")} (primary ${cfg.primary}, sample ${cfg.sample}${Object.keys(model_map).length ? `, ${Object.values(model_map).reduce((n, m) => n + Object.keys(m).length, 0)} model mappings` : ""})`);
        if (credits.claimed) log(`free TokenRouter credits: ${"budget_usd" in credits ? fmtUsd(credits.budget_usd as number) : "claimed"}${credits.expires_at ? `, expire ${String(credits.expires_at).slice(0, 10)}` : ""}`);
        log("next: routearena start");
      });
    } catch (e) {
      fail(o, e);
    }
  });

// ---------- start / stop ----------
jsonOpt(program.command("start"))
  .description("start the local proxy; point your OpenAI SDK baseURL at it")
  .option("--port <port>", "port (default from config or 4000)", (v) => parseInt(v, 10))
  .option("--sample <fraction>", "override sampling fraction", parseFloat)
  .option("--targets <ids>", "comma-separated target ids")
  .option("--daemon", "run in the background and write a pid file")
  .option("--no-inject-usage", "do not add stream_options.include_usage to streamed requests")
  .option("--cors", "allow browser (cross-origin) clients; off by default so web pages cannot drive the proxy")
  .addHelpText("after", "\nExample:\n  $ routearena start --daemon --json\n  then in your code: new OpenAI({ baseURL: 'http://localhost:4000/v1', apiKey: process.env.OPENROUTER_API_KEY })")
  .action(async (opts: any) => {
    const o: Out = { json: !!opts.json };
    try {
      loadDotenv();
      const cfg = loadConfig() ?? { ...DEFAULT_CONFIG, createdAt: new Date().toISOString() };
      if (!loadConfig()) {
        const p = (Object.keys(PRIMARIES) as PrimaryId[]).find((x) => !!process.env[PRIMARIES[x].keyEnv]);
        if (p) cfg.primary = p;
        saveConfig(cfg);
      }
      if (opts.port) cfg.port = opts.port;
      if (opts.sample !== undefined) cfg.sample = opts.sample;
      if (opts.targets) {
        cfg.targets = String(opts.targets).split(",").map((s: string) => s.trim());
        const unknown = unknownTargetIds(cfg.targets);
        if (unknown.length) throw new CliError(`Unknown target(s): ${unknown.join(", ")}`, `Known targets: ${loadTargets().map((t) => t.id).join(", ")}`);
      }
      const key = process.env[PRIMARIES[cfg.primary].keyEnv];
      if (!key) throw new CliError(`${PRIMARIES[cfg.primary].keyEnv} is not set.`, `Add it to .env in this directory (the proxy forwards to ${PRIMARIES[cfg.primary].name} with it), then run start again.`);

      if (opts.daemon) {
        if (isRunning()) throw new CliError("A proxy is already running.", "Run: routearena stop   then start again.");
        const args = process.argv.slice(2).filter((a) => a !== "--daemon");
        const child = spawn(process.execPath, [process.argv[1], ...args], { detached: true, stdio: "ignore", cwd: process.cwd(), env: process.env });
        child.unref();
        ensureConfigDir();
        fs.writeFileSync(pidPath(), String(child.pid));
        // give it a moment to bind
        await new Promise((r) => setTimeout(r, 1200));
        const health = await fetch(`http://127.0.0.1:${cfg.port}/health`).then((r) => r.json()).catch(() => null);
        if (!health) throw new CliError(`The proxy did not come up on port ${cfg.port}.`, `Run without --daemon to see the error: routearena start --port ${cfg.port}`);
        out(o, { ok: true, pid: child.pid, base_url: `http://localhost:${cfg.port}/v1`, primary: cfg.primary, sample: cfg.sample, targets: (health as any).targets, log: logPath() }, () => {
          log(`proxy running in background (pid ${child.pid})`);
          log(`baseURL: "http://localhost:${cfg.port}/v1"`);
          log(`stop with: routearena stop`);
        });
        return;
      }

      const credits = loadCredits();
      const proxy = await startProxy({ config: cfg, primaryKey: key, credits, injectUsage: opts.injectUsage !== false, cors: !!opts.cors });
      const active = proxy.targets.filter((t) => t.status !== "no-key").map((t) => `${t.target.id} (${t.status})`);
      const banner = {
        ok: true,
        base_url: `http://localhost:${proxy.port}/v1`,
        primary: cfg.primary,
        sample: cfg.sample,
        targets: proxy.targets.map((t) => ({ id: t.target.id, status: t.status })),
        log: proxy.logger.path(),
      };
      if (o.json) process.stdout.write(JSON.stringify(banner) + "\n");
      else {
        log(`RouteArena proxy on http://localhost:${proxy.port}  (primary: ${PRIMARIES[cfg.primary].name}, mirroring ${Math.round(cfg.sample * 100)}% to ${active.length ? active.join(", ") : "no targets — add a key or claim credits"})`);
        log("");
        log(`  change one line in your code:  baseURL: "http://localhost:${proxy.port}/v1"`);
        log("");
        log(`  log: ${proxy.logger.path()}   report: routearena report   stop: Ctrl+C`);
      }
      const shutdown = async () => {
        if (!o.json) log(`\nstopping… (${proxy.engine.pending()} mirrors in flight)`);
        await proxy.close();
        try {
          if (fs.existsSync(pidPath()) && fs.readFileSync(pidPath(), "utf8").trim() === String(process.pid)) fs.unlinkSync(pidPath());
        } catch {
          /* ignore */
        }
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      // keep alive
      await new Promise(() => {});
    } catch (e) {
      fail(o, e);
    }
  });

function isRunning(): boolean {
  try {
    const pid = parseInt(fs.readFileSync(pidPath(), "utf8"), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

jsonOpt(program.command("stop"))
  .description("stop a proxy started with --daemon")
  .action(async (o: Out) => {
    try {
      let pid: number | null = null;
      try {
        pid = parseInt(fs.readFileSync(pidPath(), "utf8"), 10);
      } catch {
        /* none */
      }
      if (!pid) {
        out(o, { ok: true, stopped: false, reason: "no pid file" }, () => log("no background proxy found"));
        return;
      }
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      try {
        fs.unlinkSync(pidPath());
      } catch {
        /* ignore */
      }
      out(o, { ok: true, stopped: true, pid }, () => log(`stopped proxy (pid ${pid}). Remember to revert your baseURL.`));
    } catch (e) {
      fail(o, e);
    }
  });

// ---------- report ----------
jsonOpt(program.command("report"))
  .description("aggregate the log into routearena-report/index.html and report.json")
  .option("--publish", "upload aggregates (never prompts) to the relay and print a shareable URL")
  .option("--no-judge", "skip agreement judging")
  .option("--judge-sample <fraction>", "fraction of pairs to judge for agreement (default 0.25; 1 judges every pair)", parseFloat)
  .option("--open", "open the HTML report in your browser")
  .addHelpText("after", "\nExamples:\n  $ routearena report\n  $ routearena report --publish --json\n\nCosts are what each provider reported or billed. TokenRouter reports none per response: with free credits the relay fills in TokenRouter's billed amounts; with your own TokenRouter key the report shows token counts and leaves dollars to you.")
  .action(async (opts: any) => {
    const o: Out = { json: !!opts.json };
    try {
      loadDotenv();
      if (!fs.existsSync(logPath())) throw new CliError("No log found at " + logPath(), "Run routearena start and send traffic through the proxy, then report again.");
      const r = await buildReport({ judge: opts.judge !== false, judgeSample: opts.judgeSample, onProgress: (m) => (!o.json ? log(m) : undefined) });
      if (r.records === 0) throw new CliError("The log has no records yet.", "Send requests through the proxy (baseURL http://localhost:4000/v1).");
      let published: { url: string; id: string } | null = null;
      if (opts.publish) published = await publishAggregates(r.aggregates);
      const summary = await summarize(r.aggregates);
      if (opts.open) {
        const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", r.htmlPath]] : process.platform === "darwin" ? ["open", [r.htmlPath]] : ["xdg-open", [r.htmlPath]];
        spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: "ignore" }).unref();
      }
      out(o, { ok: true, html: r.htmlPath, json: r.jsonPath, records: r.records, published, summary }, () => {
        printSummary(summary, r.htmlPath);
        if (published) log(`published: ${published.url}  (aggregates only)`);
      });
    } catch (e) {
      fail(o, e);
    }
  });

/**
 * The ASCII comparison lives in src/report/ascii.ts (another agent's file). Loaded dynamically so this CLI builds and
 * runs before that module lands; once it exists this can become a static import.
 */
async function asciiComparison(a: import("./report/aggregate.js").ReportAggregates): Promise<string | null> {
  try {
    const spec = "./report/ascii.js";
    const mod: any = await import(spec);
    const fn = mod?.renderAsciiComparison;
    return typeof fn === "function" ? String(fn(a, { width: Math.max(60, Math.min(120, process.stderr.columns ?? 100)) })) : null;
  } catch {
    return null;
  }
}

async function summarize(a: import("./report/aggregate.js").ReportAggregates) {
  const r4 = (n: number | null | undefined) => (n === null || n === undefined ? null : round4(n));
  const r1 = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);
  return {
    /** Plain-text comparison table of the same aggregates, for terminals and chat. */
    ascii: await asciiComparison(a),
    period: a.period,
    /** "low" when the log spans under 24 h or fewer than 50 pairs were measured; monthly figures are then rough extrapolations. */
    projection_confidence: a.projection?.confidence ?? "ok",
    projection_basis: a.projection?.basis ?? "calendar_days",
    projection_reason: a.projection?.reason ?? null,
    primary: {
      provider: a.primary.provider,
      requests: a.primary.requests,
      no_output: a.primary.no_output ?? 0,
      cost_usd: round4(a.primary.cost_usd),
      /** "reported": every ok response carried a provider cost; "mixed": some did; "not_reported": none did. */
      cost_source: a.primary.cost_source,
      cost_not_reported: a.primary.cost_not_reported ?? 0,
      avg_cost_per_request_usd: a.primary.avg_cost_per_request_usd === null ? null : Math.round(a.primary.avg_cost_per_request_usd * 1e6) / 1e6,
      monthly_usd: round4(a.primary.monthly_usd),
      latency_p50_ms: a.primary.latency.p50,
      latency_p95_ms: a.primary.latency.p95,
      ttft_p50_ms: a.primary.ttft.p50,
      ttft_method: a.primary.ttft_method ?? null,
    },
    mirrored: a.sampling.mirrored,
    sample_size_note: a.method.sample_size_note,
    targets: a.targets.map((t) => ({
      target: t.target,
      projected_monthly_usd: r4(t.projected_monthly_usd),
      delta_usd: r4(t.delta_usd),
      delta_pct: r1(t.delta_pct),
      /** The delta to quote first: reported-or-billed costs over pairs with a cost on both sides. delta_pct null when the target has no cost; `note` says why and what to do. */
      headline: t.headline ? { delta_pct: r1(t.headline.delta_pct), basis: t.headline.basis, note: t.headline.note } : null,
      /** Cost over pairs where both sides have one (reported on the response, or billed and read via the relay), no projection. */
      reported: t.reported ? { pairs: t.reported.pairs, primary_cost_usd: round4(t.reported.primary_cost_usd), target_cost_usd: round4(t.reported.target_cost_usd), delta_pct: r1(t.reported.delta_pct), target_cost_origin: t.target_cost_origin ?? null } : null,
      /** Ok sides in pairs with no reported or billed cost, per side; excluded from cost figures. */
      cost_not_reported: t.cost_not_reported ?? { primary: 0, target: 0 },
      cost_complete_pairs: t.cost_complete_pairs ? { pairs: t.cost_complete_pairs.pairs, delta_pct: r1(t.cost_complete_pairs.delta_pct) } : null,
      tokens: t.tokens ?? null,
      cache_share: t.cache_share ?? null,
      cache_warning: t.cache_warning ?? null,
      no_output: t.no_output ?? { primary: 0, target: 0 },
      truncated: t.truncated ?? { pairs: 0, primary_only: 0, target_only: 0, both: 0 },
      reasoning_leak: t.reasoning_leak ?? { pairs: 0, primary: 0, target: 0 },
      /** Share of mirrored requests the target accepted (not rejected as model_not_found, bad_request, unsupported_parameter or auth). */
      coverage_pct: t.coverage_pct === null ? null : Math.round(t.coverage_pct),
      /** Models the target rejected: "<model> -> <target_model> (<error_type>, n attempts)". */
      rejected: (t.rejected ?? []).map((f) => ({ model: f.model, target_model: f.target_model, attempts: f.attempts, error_type: f.error_type })),
      latency_p50_ms: t.latency.p50,
      latency_p95_ms: t.latency.p95,
      ttft_p50_ms: t.ttft.p50,
      primary_ttft_p50_ms: t.primary_ttft?.p50 ?? null,
      ttft_method: t.ttft_method ?? null,
      ttft_not_comparable: t.ttft_not_comparable ?? 0,
      error_rate: t.error_rate,
      agreement_rate: t.agreement_rate,
      agreement_judged: t.agreement_judged,
      judge_fraction: t.judge_fraction ?? 0.25,
      disagreement_reasons: t.disagreement_reasons ?? [],
    })),
  };
}
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

function printSummary(s: Awaited<ReturnType<typeof summarize>>, htmlPath: string) {
  const low = s.projection_confidence === "low";
  if (s.ascii) {
    log("");
    log(s.ascii);
  }
  log("");
  log(
    `${s.primary.provider}: ${s.primary.requests} requests, ${fmtUsd(s.primary.cost_usd)} (${s.primary.cost_source}${s.primary.cost_not_reported ? `, ${s.primary.cost_not_reported} without a reported cost` : ""}), ${fmtUsd(s.primary.avg_cost_per_request_usd, 5)} per request, lat p50 ${fmtMs(s.primary.latency_p50_ms)} / p95 ${fmtMs(s.primary.latency_p95_ms)}, ${s.mirrored} mirrored${s.primary.no_output ? `, ${s.primary.no_output} returned no output` : ""}`,
  );
  log(low ? `monthly: ${fmtUsd(s.primary.monthly_usd)} rough extrapolation (${s.projection_reason ?? "low confidence"})` : `monthly: ${fmtUsd(s.primary.monthly_usd)} scaled from ${s.projection_basis === "elapsed_time" ? "elapsed time" : "calendar days"}`);
  for (const t of s.targets) {
    const r = t.reported;
    log("");
    const origin = r?.target_cost_origin === "billed" ? "billed" : r?.target_cost_origin === "mixed" ? "reported or billed" : "reported";
    const head = t.headline && t.headline.delta_pct !== null ? `${fmtPct(t.headline.delta_pct)} (${origin}, over ${r?.pairs ?? 0} pairs)` : "no cost delta";
    log(`${t.target}: ${head}  |  Δ ${origin} ${fmtPct(r?.delta_pct)}${t.cost_not_reported.target || t.cost_not_reported.primary ? ` (no cost: target ${t.cost_not_reported.target}, primary ${t.cost_not_reported.primary})` : ""}  complete pairs ${fmtPct(t.cost_complete_pairs?.delta_pct)} (n=${t.cost_complete_pairs?.pairs ?? 0})`);
    if (t.headline && t.headline.delta_pct === null && t.headline.note) log(`  ${t.headline.note}`);
    if (t.tokens) log(`  tokens in/out: primary ${t.tokens.primary.prompt_tokens}/${t.tokens.primary.completion_tokens}, target ${t.tokens.target.prompt_tokens}/${t.tokens.target.completion_tokens}${t.tokens.primary.reasoning_tokens || t.tokens.target.reasoning_tokens ? ` (reasoning ${t.tokens.primary.reasoning_tokens}/${t.tokens.target.reasoning_tokens})` : ""}`);
    log(
      `  lat p50/p95 ${fmtMs(t.latency_p50_ms)} / ${fmtMs(t.latency_p95_ms)}   TTFT p50 ${t.ttft_method ? `${fmtMs(t.primary_ttft_p50_ms)} vs ${fmtMs(t.ttft_p50_ms)} (${t.ttft_method})` : "not comparable"}   errors ${t.error_rate === null ? "–" : fmtPct(t.error_rate * 100, false)}   no output ${t.no_output.primary}/${t.no_output.target}   truncated ${t.truncated.pairs} (primary ${t.truncated.primary_only}, target ${t.truncated.target_only}, both ${t.truncated.both})${t.reasoning_leak.pairs ? `   reasoning leak ${t.reasoning_leak.primary}/${t.reasoning_leak.target}` : ""}   agreement ${t.agreement_rate === null ? "not judged" : `${fmtPct(t.agreement_rate * 100, false)} (n=${t.agreement_judged})`}   accepted ${t.coverage_pct === null ? "–" : t.coverage_pct + "%"}`,
    );
    if (t.projected_monthly_usd !== null) log(`  monthly ${fmtUsd(t.projected_monthly_usd)} (${fmtPct(t.delta_pct)}, ${low ? "rough extrapolation" : "projected"})`);
    if (t.cache_warning) log(`  cache: ${t.cache_warning}`);
    if (t.rejected.length) log(`  rejected by ${t.target}: ${t.rejected.map((f) => `${f.model}${f.target_model && f.target_model !== f.model ? ` -> ${f.target_model}` : ""} (${f.error_type}, ${f.attempts})`).join(", ")}`);
  }
  if (s.sample_size_note) log(`note: ${s.sample_size_note}`);
  log(`report: ${htmlPath}`);
}

// ---------- credits ----------
jsonOpt(program.command("credits"))
  .description("show remaining free TokenRouter credit budget and expiry")
  .action(async (o: Out) => {
    try {
      const c = loadCredits();
      if (!c) {
        out(o, { claimed: false }, () => log("no free credits claimed. Run: routearena init --free-credits --email you@example.com"));
        return;
      }
      const b = await fetchBalance(c);
      out(o, { claimed: true, ...b }, () => log(`free TokenRouter credits: ${fmtUsd(b.remaining_usd)} of ${fmtUsd(b.budget_usd)} left, ${b.requests} requests, expires ${b.expires_at.slice(0, 10)}`));
    } catch (e) {
      fail(o, e);
    }
  });

// ---------- targets ----------
jsonOpt(program.command("targets"))
  .description("list targets, the env var each needs, and whether a key or free credits are present")
  .action((o: Out) => {
    loadDotenv();
    const credits = loadCredits();
    const rows = loadTargets().map((t) => ({ id: t.id, name: t.name, status: targetStatus(t, process.env, credits), key_env: t.keyEnv, reports_cost: !!t.reportsCost, free_credits: !!t.supportsFreeCredits }));
    out(o, { targets: rows }, () => {
      for (const r of rows) log(`${r.id.padEnd(12)} ${r.status.padEnd(13)} ${r.key_env}${r.reports_cost ? "  reports cost per request" : ""}${r.free_credits ? "  free credits available" : ""}`);
    });
  });

program.showHelpAfterError("(run with --help for usage)");
program.parseAsync(process.argv).catch((e) => fail({ json: process.argv.includes("--json") }, e));

export { REPORT_DIR };
