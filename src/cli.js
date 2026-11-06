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
const VALUE_FLAGS = ["--profile", "--workspace", "--session", "--base-url", "--model", "--api-key", "--port", "--host", "--token"];
const task = args.filter((a) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[args.indexOf(a) - 1])).join(" ");

// Web mode shares a mutable approval ref with the approval guard (approve toggle).
const approval = { current: has("--yes") || process.env.CW_AUTO_APPROVE === "true" };
const { ctx, store, dispose } = await bootProfile(join(root, "profiles", "personal.json"), {
  workspace: val("--workspace") ?? process.env.CW_WORKSPACE,
  autoApprove: approval,
  mock: has("--mock"),
  baseUrl: val("--base-url"),
  model: val("--model"),
  apiKey: val("--api-key"),
});

if (has("--web")) {
  const { startWebServer, lanAddresses } = await import("./web/server.js");
  const port = Number(val("--port") ?? 3000);
  const host = val("--host") ?? "0.0.0.0"; // all interfaces => LAN reachable
  const token = val("--token") ?? process.env.CW_TOKEN;
  const server = await startWebServer({ ctx, store, approval, token }, { port, host });
  const bound = server.address().port;
  console.error(`[code-worker] web (model=${process.env.OPENAI_MODEL ?? process.env.DEEPSEEK_MODEL ?? "default"}${token ? ", token auth ON" : ", no token (LAN trusted only)"}):`);
  if (!token && host !== "127.0.0.1" && host !== "localhost") console.error("[code-worker] WARN: no token on a non-localhost bind — anyone on the LAN can use this (file/command access). Set --token.");
  for (const addr of ["localhost", ...lanAddresses()]) console.error(`  http://${addr}:${bound}${token ? "/?token=<token>" : ""}`); // never print the secret
  await new Promise(() => {}); // serve until killed
}
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
      if (t === "/compact") {
        const text = await ctx.require("compaction").compact(session).catch((e) => { console.log(`compact failed: ${e.message}`); return null; });
        console.log(text ? `compacted: ${text.slice(0, 120)}…` : "nothing to compact");
        rl.prompt(); continue;
      }
      if (t.startsWith("/")) { console.log("commands: /exit /compact"); rl.prompt(); continue; }
      await runOnce(t);
      rl.prompt();
    }
    rl.close();
  } else if (task) {
    await runOnce(task);
  } else {
    console.log("Usage:\n  node src/cli.js --mock --yes \"list files in workspace\"\n  node src/cli.js --yes \"task...\"   # OpenAI-compatible endpoint via OPENAI_* env/.env\n  node src/cli.js --yes --base-url https://api.deepseek.com --model deepseek-chat \"task...\"\n  node src/cli.js --repl [--mock] [--yes]\n  node src/cli.js --session <id> \"continue...\"");
  }
} finally {
  await dispose();
}
