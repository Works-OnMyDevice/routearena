import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Hosted relay (free TokenRouter credits metering + published reports). Open source in ./relay. */
export const RELAY_URL = process.env.ROUTEARENA_RELAY_URL || "https://routearena-api.routearena-api.workers.dev";

export const CONFIG_DIR = ".routearena";
export const REPORT_DIR = "routearena-report";

export const PRIMARIES = {
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
  },
} as const;

export type PrimaryId = keyof typeof PRIMARIES;

export const KEY_ENVS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "TOKENROUTER_API_KEY",
  "TOGETHER_API_KEY",
  "GROQ_API_KEY",
  "DEEPINFRA_API_KEY",
  "FIREWORKS_API_KEY",
  "OPENROUTER_MANAGEMENT_KEY",
] as const;

export interface Credits {
  /** Relay token (ra_…) in relay mode, or a capped TokenRouter key (sk-…) in key mode. Never logged. */
  token: string;
  claimId: string;
  expiresAt: string; // ISO
  budgetUsd: number;
  /** "key": mirrors go straight to TokenRouter with a capped key. "relay": mirrors pass through the relay. */
  mode?: "key" | "relay";
}

export interface Config {
  primary: PrimaryId;
  sample: number;
  port: number;
  targets?: string[];
  byok?: boolean;
  mirrorImages?: boolean;
  maxInputTokens?: number;
  hourlyCap?: number;
  /**
   * Per-target model overrides: target id -> (model id as the client sends it -> id to send to that target).
   * Set by the user's agent; RouteArena ships no mappings. Without an entry a mirror receives the client's
   * model id unchanged. Persisted in .routearena/config.json and read by the proxy on start.
   */
  model_map?: Record<string, Record<string, string>>;
  createdAt: string;
}

export const DEFAULT_CONFIG: Omit<Config, "createdAt"> = {
  primary: "openrouter",
  sample: 0.1,
  port: 4000,
  byok: false,
  mirrorImages: false,
  maxInputTokens: 32_000,
  hourlyCap: 500,
};

export function pkgRoot(): string {
  // dist/config.js or src/config.ts -> package root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function pkgVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot(), "package.json"), "utf8"));
    return pkg.version as string;
  } catch {
    return "0.0.0";
  }
}

export function configDir(cwd = process.cwd()): string {
  return path.join(cwd, CONFIG_DIR);
}

export function ensureConfigDir(cwd = process.cwd()): string {
  const dir = configDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function configPath(cwd = process.cwd()): string {
  return path.join(configDir(cwd), "config.json");
}
export function logPath(cwd = process.cwd()): string {
  return path.join(configDir(cwd), "log.jsonl");
}
export function pidPath(cwd = process.cwd()): string {
  return path.join(configDir(cwd), "proxy.pid");
}
export function creditsPath(cwd = process.cwd()): string {
  return path.join(configDir(cwd), "credits.json");
}

export function loadConfig(cwd = process.cwd()): Config | null {
  try {
    const raw = fs.readFileSync(configPath(cwd), "utf8");
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<Config>) } as Config;
  } catch {
    return null;
  }
}

export function saveConfig(cfg: Config, cwd = process.cwd()): void {
  ensureConfigDir(cwd);
  fs.writeFileSync(configPath(cwd), JSON.stringify(cfg, null, 2) + "\n");
}

export function loadCredits(cwd = process.cwd()): Credits | null {
  try {
    const c = JSON.parse(fs.readFileSync(creditsPath(cwd), "utf8")) as Credits;
    if (!c.token || !c.expiresAt) return null;
    return c;
  } catch {
    return null;
  }
}

export function saveCredits(c: Credits, cwd = process.cwd()): void {
  ensureConfigDir(cwd);
  fs.writeFileSync(creditsPath(cwd), JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Minimal .env loader: reads ./.env (and ./.env.local) without overriding variables
 * that are already set. Never logs values.
 */
export function loadDotenv(cwd = process.cwd()): string[] {
  const found: string[] = [];
  for (const file of [".env", ".env.local"]) {
    const p = path.join(cwd, file);
    let text: string;
    try {
      text = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      } else {
        const hash = val.indexOf(" #");
        if (hash >= 0) val = val.slice(0, hash).trim();
      }
      if (process.env[key] === undefined) {
        process.env[key] = val;
        found.push(key);
      }
    }
  }
  return found;
}

/** Replace anything that looks like a key or bearer token in a string. */
export function redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/\b(sk|tr|ra|gsk|fw|or)[-_][A-Za-z0-9._-]{12,}/g, "[redacted-key]")
    .replace(/\bsk-or-v1-[A-Za-z0-9]{16,}/g, "[redacted-key]");
}

export class CliError extends Error {
  fix: string;
  exitCode: number;
  constructor(message: string, fix: string, exitCode = 1) {
    super(message);
    this.fix = fix;
    this.exitCode = exitCode;
  }
}
