// Runs bench-cases.json (25 safe and 25 risky commands) through the rules and then through
// the real model server, and reports what would run without a prompt, plus model latency and
// server memory. Every command is sent to the model, including the ones a rule settles, so the
// model's own separation is visible. Nothing is executed.
// Re-run after changing the question, the model, `askAbove` or the server's thread count.
// Needs a Node that runs TypeScript directly (22.18 or newer) and the model server running.
// With `classifier.provider` set (or a provider/model argument) the questions go through Pi's
// model registry with Pi's credentials, so `pi` must be installed; the 50 commands are then
// sent to that provider.
// Usage: node bench.mjs [askAbove] [endpoint | provider/model]
//   node bench.mjs 0.2 http://127.0.0.1:11439
//   node bench.mjs 0.2 openrouter/typesafe/jev-1.13
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const here = import.meta.dirname;
const { classify, loadConfig, DEFAULTS } = await import("./index.ts");
const { bashVerdict, makeScope } = await import("./rules.ts");

// The bench measures a server that is already running, with your `classifier` section and
// `askAbove`. Your own rules and extra questions are left out so runs stay comparable.
const mine = loadConfig().config;
const target = process.argv[3] ?? "";
const config = { ...DEFAULTS, endpoint: mine.endpoint, classifier: { ...mine.classifier, extraQuestions: {} } };
if (/^https?:/.test(target)) config.endpoint = target;
else if (target) Object.assign(config.classifier, { provider: target.slice(0, target.indexOf("/")), model: target.slice(target.indexOf("/") + 1) });
const askAbove = Number(process.argv[2] ?? mine.askAbove);

// Pi's own model registry, for provider mode. Pi is a peer dependency, so when it is not
// installed next to this package it is loaded from the `pi` on PATH.
async function piRegistry() {
  const pi = await import("@earendil-works/pi-coding-agent").catch(() => {
    const cli = fs.realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
    return import(path.join(cli.slice(0, cli.indexOf("/dist/")), "dist/index.js"));
  });
  return new pi.ModelRegistry(await pi.ModelRuntime.create());
}
const registry = config.classifier.provider ? await piRegistry() : undefined;
// Does not need to exist; the rules only need a project root that is not $HOME.
const cwd = path.join(os.homedir(), "project");
const cases = JSON.parse(fs.readFileSync(path.join(here, "bench-cases.json"), "utf8"));

const rows = [];
for (const [label, commands] of Object.entries(cases)) {
  for (const command of commands) {
    const rule = bashVerdict(command, makeScope(cwd, [here])).action;
    const model = await classify(config, { tool: "bash", cwd, command }, undefined, registry);
    if ("error" in model) {
      console.error(`model error: ${model.error}`);
      process.exit(1);
    }
    const risk = model.answers.risky;
    const runs = rule === "allow" || (rule === "classify" && risk < askAbove);
    rows.push({ label, command, rule, risk, ms: model.ms, tokens: model.tokens ?? 0, runs });
    console.log(`${label.padEnd(5)} rule=${rule.padEnd(8)} risk=${risk.toFixed(2)} ${runs ? "runs  " : "prompt"} ${command.slice(0, 80)}`);
  }
}

const of = (label) => rows.filter((r) => r.label === label);
const pct = (n, d) => `${n}/${d}`;
console.log(`\naskAbove = ${askAbove}, model "${config.classifier.provider ? `${config.classifier.provider}/` : ""}${config.classifier.model}", ${config.classifier.levels.length ? `${config.classifier.levels.length}-level score` : "yes/no"} question`);
for (const label of ["safe", "risky"]) {
  const all = of(label);
  const byRule = (a) => all.filter((r) => r.rule === a).length;
  console.log(`${label}: rules allow ${byRule("allow")}, ask ${byRule("ask")}, deny ${byRule("deny")}, model decides ${byRule("classify")}`);
}
const classified = (label) => of(label).filter((r) => r.rule === "classify");
console.log(`safe commands that run without a prompt:  ${pct(of("safe").filter((r) => r.runs).length, of("safe").length)}`);
console.log(`risky commands that run without a prompt: ${pct(of("risky").filter((r) => r.runs).length, of("risky").length)}  <- misses`);
console.log(`model alone, on the commands the rules left to it: safe passed ${pct(classified("safe").filter((r) => r.runs).length, classified("safe").length)}, risky passed ${pct(classified("risky").filter((r) => r.runs).length, classified("risky").length)}`);

// Threshold-free view of the model over all 50 commands: how often a risky command scores
// above a safe one (1.0 = always, 0.5 = chance), and the gap a threshold has to sit in.
const scores = (label) => of(label).map((r) => r.risk).sort((a, b) => a - b);
const [safe, risky] = [scores("safe"), scores("risky")];
const auc = risky.reduce((n, r) => n + safe.filter((s) => r > s).length + safe.filter((s) => r === s).length / 2, 0) / (safe.length * risky.length);
console.log(`model alone, all 50: AUC ${auc.toFixed(3)}, lowest risky ${risky[0].toFixed(2)}, highest safe ${safe.at(-1).toFixed(2)}, safe median ${safe[safe.length >> 1].toFixed(2)}, risky median ${risky[risky.length >> 1].toFixed(2)}`);
const lowestRisky = Math.min(...classified("risky").map((r) => r.risk));
const highestSafe = Math.max(...classified("safe").map((r) => r.risk));
console.log(`on the commands the rules left to it: highest safe ${highestSafe.toFixed(2)}, lowest risky ${lowestRisky.toFixed(2)}; safe commands below that: ${pct(classified("safe").filter((r) => r.risk < lowestRisky).length, classified("safe").length)}`);

const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log(`model latency over ${ms.length} calls: p50 ${ms[ms.length >> 1]} ms, p95 ${ms[Math.floor(ms.length * 0.95)]} ms, max ${ms.at(-1)} ms`);
console.log(`input tokens over ${rows.length} calls: ${rows.reduce((n, r) => n + r.tokens, 0)}`);
if (config.classifier.provider) {
  console.log(`model: ${config.classifier.provider}/${config.classifier.model} through Pi's registry`);
} else {
  try {
    const pid = execFileSync("ss", ["-ltnpH"], { encoding: "utf8" }).split("\n").find((l) => l.includes(`:${new URL(config.endpoint).port} `))?.match(/pid=(\d+)/)?.[1];
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const mb = (key) => Math.round(Number(status.match(new RegExp(`${key}:\\s+(\\d+)`))[1]) / 1024);
    console.log(`server memory: ${mb("VmRSS")} MB (${mb("RssAnon")} MB private, ${mb("RssFile")} MB model file mapped)`);
  } catch {
    console.log("server memory: could not read (server not owned by this user?)");
  }
}
