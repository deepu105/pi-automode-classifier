// Runs bench-llm-cases.json through the chat decider ("decider": "llm") and compares the verdicts
// with what each case says it should be. Every case goes to the model, including the ones a rule
// would settle, so the model's own judgment is visible; the rule verdict is printed next to it.
// Nothing under test is executed.
//
// The cases carry the user message that should decide them: like Claude Code, the decider judges
// an action against what the user asked for, so a case without a user message means nothing.
//
// Needs a model Pi can reach: `pi` installed and the model in its catalog. The decider is
// configured in ~/.pi/agent/extensions/pi-automode-classifier/config.json under `llm`,
// or on the command line.
//
// Usage: node bench-llm.mjs [provider/model] [thinkingLevel|off] [single]
//   node bench-llm.mjs llamastash-z13/flash-next-256k low
//   node bench-llm.mjs openrouter/typesafe/jev-1.13 off single
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const here = import.meta.dirname;
const { DEFAULTS, decideWithLlm, llmName, systemPrompt, loadConfig } = await import("./index.ts");

const { bashVerdict, makeScope } = await import("./rules.ts");

const mine = loadConfig().config;
const llm = { ...mine.llm };
const target = process.argv[2] ?? "";
if (target) {
  const at = target.indexOf("/");
  llm.provider = at < 0 ? "" : target.slice(0, at);
  llm.model = at < 0 ? target : target.slice(at + 1);
}
if (process.argv[3]) llm.thinkingLevel = process.argv[3];
if (process.argv[4] === "single") llm.twoStage = false;

const config = { ...DEFAULTS, decider: "llm", llm };
if (!llm.provider && !llm.model) {
  console.error("no decider model: set llm.provider and llm.model in the config or pass provider/model");
  process.exit(1);
}

const pi = await import("@earendil-works/pi-coding-agent").catch(() => {
  const cli = fs.realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
  return import(path.join(cli.slice(0, cli.indexOf("/dist/")), "dist/index.js"));
});
const registry = new pi.ModelRegistry(await pi.ModelRuntime.create());

// Does not need to exist; the rules only need a project root that is not $HOME.
const cwd = path.join(os.homedir(), "project");
const cases = JSON.parse(fs.readFileSync(path.join(here, "bench-llm-cases.json"), "utf8")).cases;
const guard = here;

console.log(`decider ${llmName(llm)}, ${llm.twoStage ? "two-stage" : "one stage"}, thinking ${llm.thinkingLevel}, prompt ${systemPrompt(config).length} chars`);
const rows = [];
for (const c of cases) {
  const prior = (c.prior ?? []).map((p) => ({ kind: "tool", tool: p.tool, input: p.input }));
  const items = [{ kind: "user", text: c.user }, ...prior, { kind: "action", tool: c.tool, input: c.input }];
  const rule = c.tool === "bash" ? bashVerdict(String(c.input.command ?? ""), makeScope(cwd, [guard])).action : "-";
  const d = await decideWithLlm(config, items, undefined, registry);
  const got = "error" in d ? `error: ${d.error}` : d.block ? `block (${d.category ?? "?"})` : "allow";
  const ok = "error" in d ? false : d.block === (c.want === "block");
  rows.push({ ...c, got, ok, ms: d.ms, tokens: d.tokens ?? 0, stage: d.stage });
  console.log(`${ok ? "ok   " : "WRONG"} want=${c.want.padEnd(5)} got=${got.padEnd(34)} rule=${String(rule).padEnd(8)} ${String(d.stage ?? "-").padEnd(9)} ${String(d.ms).padStart(6)}ms ${String(d.tokens ?? 0).padStart(6)}tok  ${c.name}`);
  if ("reason" in d && d.reason) console.log(`        ${d.reason.slice(0, 200)}`);
}

const want = (w) => rows.filter((r) => r.want === w);
const missed = want("block").filter((r) => r.ok === false && !r.got.startsWith("error"));
const falseBlocked = want("allow").filter((r) => r.ok === false && !r.got.startsWith("error"));
const errored = rows.filter((r) => r.got.startsWith("error"));
console.log(`\n${rows.length} cases: ${rows.filter((r) => r.ok).length} right, ${missed.length} dangerous let through, ${falseBlocked.length} routine blocked, ${errored.length} errors`);
console.log(`of the ${want("block").length} that should be blocked: ${want("block").length - missed.length} caught${missed.length ? `; missed: ${missed.map((r) => r.name).join(", ")}` : ""}`);
console.log(`of the ${want("allow").length} that should run: ${want("allow").length - falseBlocked.length} passed${falseBlocked.length ? `; blocked: ${falseBlocked.map((r) => r.name).join(", ")}` : ""}`);
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
const oneStage = rows.filter((r) => r.stage === "fast");
console.log(`latency: p50 ${ms[ms.length >> 1]} ms, p95 ${ms[Math.floor(ms.length * 0.95)]} ms, max ${ms.at(-1)} ms`);
console.log(`stage 1 cleared ${oneStage.length} of ${rows.length} without a second call, at p50 ${oneStage.map((r) => r.ms).sort((a, b) => a - b)[oneStage.length >> 1] ?? "-"} ms`);
console.log(`tokens: ${rows.reduce((n, r) => n + r.tokens, 0)} total, ${Math.round(rows.reduce((n, r) => n + r.tokens, 0) / rows.length)} per call on average`);
if (errored.length) console.log(`\nfirst error: ${errored[0].got}`);
process.exit(errored.length ? 2 : 0);
