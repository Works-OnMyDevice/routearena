import assert from "node:assert/strict";
import { test } from "node:test";
import { renderAsciiComparison, type AsciiInput } from "../src/report/ascii.js";

const q = (p50: number | null, n = 1) => ({ p50, p95: p50, n });
const base: AsciiInput = {
  period: { from: "2026-11-09", to: "2026-11-09" },
  sampling: { mirrored: 4 },
  primary: { provider: "openrouter", requests: 4, cost_usd: 0.0094, avg_cost_per_request_usd: 0.00236, latency: q(10370), ttft: q(930), ttft_method: "first-content", no_output: 2, prompt_tokens: 9042, completion_tokens: 16911, cached_tokens: 0, reasoning_tokens: 16000 },
  targets: [
    {
      target: "tokenrouter", name: "TokenRouter", pairs: 4, requests_mirrored: 4,
      headline: { delta_pct: null, basis: "as_served" }, measured: { pairs: 0, primary_cost_usd: 0, target_cost_usd: 0, delta_pct: null },
      avg_cost_per_request_usd: { primary: 0.00236, target: null }, cost_source: "not_reported",
      tokens: { primary: { prompt_tokens: 9042, completion_tokens: 16911, reasoning_tokens: 16000, cached_tokens: 0 }, target: { prompt_tokens: 9042, completion_tokens: 20469, reasoning_tokens: 18254, cached_tokens: 0 } },
      latency: q(12510), ttft: q(701), primary_ttft: q(930), ttft_method: "first-content", no_output: { primary: 2, target: 0 }, error_rate: 0, agreement_rate: 1, agreement_judged: 2,
    },
  ],
};

test("ascii picture never truncates at common widths, with and without a reported target cost", () => {
  const billed: AsciiInput = { ...base, targets: [{ ...base.targets[0], avg_cost_per_request_usd: { primary: 0.00236, target: 0.0031 }, cost_source: "billed", headline: { delta_pct: 31.4, basis: "as_served" }, rejected: [{ model: "x/y" }] }] };
  for (const input of [base, billed]) {
    for (const width of [76, 80, 100, 120]) {
      for (const ascii of [false, true]) {
        const out = renderAsciiComparison(input, { width, ascii });
        const lines = out.split("\n");
        assert.ok(!out.includes("…"), `no truncation at width ${width} ascii=${ascii}:\n${out}`);
        assert.ok(lines.every((l) => l.length === lines[0].length), `every line is ${lines[0].length} wide at width ${width}`);
        assert.ok(out.includes("the hedgehog mirrors it"), "mascot present");
      }
    }
  }
  const out = renderAsciiComparison(base);
  assert.ok(out.includes("not reported by TokenRouter"), "unreported target cost is said, not estimated");
  assert.ok(out.includes("9,042"), "tokens shown");
  assert.ok(renderAsciiComparison(billed).includes("(billed)"), "billed cost labelled");
});
