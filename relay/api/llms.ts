import { AGENTS_TXT } from "../lib/agents";

/** GET /llms.txt -> the agent protocol (AGENTS.md), same text as the repo. */
export async function GET(): Promise<Response> {
  return new Response(AGENTS_TXT, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
