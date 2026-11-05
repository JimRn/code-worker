#!/usr/bin/env node
// code-worker CLI: headless one-shot + --repl. Application launch goes through a profile,
// mirroring `dsh --profile <name>` (no package bin bypass).
import { readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bootProfile } from "./profile.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env loader (no deps). Does not override existing env.
if (existsSync(join(root, ".env"))) {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const task = args.filter((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--profile" && args[args.indexOf(a) - 1] !== "--workspace" && args[args.indexOf(a) - 1] !== "--session").join(" ");

const { ctx, store, dispose } = await bootProfile(join(root, "profiles", "personal.json"), {
  workspace: val("--workspace") ?? process.env.CW_WORKSPACE,
  autoApprove: has("--yes") || process.env.CW_AUTO_APPROVE === "true",
  mock: has("--mock"),
});
const loop = ctx.require("agentLoop");
const session = val("--session") ? store.open(val("--session")) : store.create();
console.error(`[code-worker] session=${session.id} home=${session.dir}`);

async function runOnce(text) {
  await loop.runTurn(session, text, { onText: (t) => process.stdout.write(t + "\n") });
}

try {
  if (has("--repl")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "cw> " });
    rl.prompt();
    for await (const line of rl) {
      const t = line.trim();
      if (!t) { rl.prompt(); continue; }
      if (t === "/exit" || t === "/quit") break;
      if (t.startsWith("/")) { console.log("commands: /exit"); rl.prompt(); continue; }
      await runOnce(t);
      rl.prompt();
    }
    rl.close();
  } else if (task) {
    await runOnce(task);
  } else {
    console.log("Usage:\n  node src/cli.js --mock --yes \"list files in workspace\"\n  node src/cli.js --yes \"task...\"\n  node src/cli.js --repl [--mock] [--yes]\n  node src/cli.js --session <id> \"continue...\"");
  }
} finally {
  await dispose();
}
