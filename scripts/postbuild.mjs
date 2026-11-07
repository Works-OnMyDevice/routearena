// Make dist/cli.js executable and prepend a shebang if missing.
import { readFileSync, writeFileSync, chmodSync, cpSync } from "node:fs";
const p = new URL("../dist/cli.js", import.meta.url);
let src = readFileSync(p, "utf8");
if (!src.startsWith("#!")) src = "#!/usr/bin/env node\n" + src;
writeFileSync(p, src);
try { chmodSync(p, 0o755); } catch {}
// Ship the agent protocol next to dist so --help can print it from the installed package.
cpSync(new URL("../AGENTS.md", import.meta.url), new URL("../dist/AGENTS.md", import.meta.url));
