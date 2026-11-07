import { html } from "../lib/env";
import { renderReportHtml } from "../lib/reportHtml";
import { state } from "../lib/store";

/** GET /r/:id renders a published report from stored aggregates. Static, no scripts. */
export async function GET(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[a-f0-9]{16}$/.test(id)) return html("<!doctype html><title>Not found</title><p>No such report.</p>", 404);
  const raw = await state().getReport(id);
  if (!raw) return html("<!doctype html><title>Not found</title><p>This report does not exist or has expired (reports are kept 180 days).</p>", 404);
  return html(renderReportHtml(JSON.parse(raw), { published: true }), 200, { "cache-control": "public, max-age=300", "x-robots-tag": "noindex" });
}
