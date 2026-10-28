// Runs the command suites in bench/suites through the plugin the way Pi calls it: the extension's
// own tool_call handler, the real model registry, and a session transcript holding the row's user
// message. A confirm prompt is recorded and answered "Block". Nothing under test is executed.
//
// The rules, the classifier and the chat model come from bench/config.json (same shape as the
// plugin's config.json), or the plugin's defaults when it is missing. --stages picks the deciders
// after the rules:
//   classifier  the config's classifier stages (npm run bench)
//   llm         the chat model only (npm run bench:llm)
//   flow        the classifier stages, then the chat model (npm run bench:flow)
//   rules       no deciders: what the rules leave open asks you
//
// Rows: {id, command | path, label (1 = risky), tool?, cwd?, user?, prior?: [{tool, input}]}. In
// command, path and cwd, {home} is $HOME, {project} a scratch git repository under ~/.cache, and
// {guard} this checkout. Results go to bench/results/<stages>-<askAbove>-<allowBelow>/<suite>.jsonl,
// one line per row, and a rerun skips the rows already there.
// Needs a Node that runs TypeScript directly (22.18 or newer) and `pi` installed.
// Usage: node bench/run.mjs [--stages flow] [--suites a,b] [--ask-above 0.5] [--allow-below 0.2] [--limit n]
//   npm run bench:flow -- --suites user-requests --ask-above 0.8
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const here = import.meta.dirname;
const guard = path.dirname(here);
const { values: args } = parseArgs({
  options: { stages: { type: "string", default: "flow" }, suites: { type: "string" }, "ask-above": { type: "string" }, "allow-below": { type: "string" }, limit: { type: "string" } },
});
if (!["classifier", "llm", "flow", "rules"].includes(args.stages)) throw new Error(`--stages must be classifier, llm, flow or rules, not ${args.stages}`);

// LOG_FILE is read when index.ts loads, so the bench's log folder is set first. One per process,
// so parallel runs do not read each other's decisions.
process.env.XDG_STATE_HOME = path.join(here, "results", ".state", String(process.pid));
const { default: extension, loadConfig, LOG_FILE } = await import(path.join(guard, "index.ts"));
const configFile = path.join(here, "config.json");
const loaded = loadConfig(configFile);
if (loaded.error) console.error(loaded.error);
const base = loaded.config;
const scorers = base.decider.filter((d) => d !== "llm");
if (!scorers.length) scorers.push("classifier");
const decider = { classifier: scorers, llm: ["llm"], flow: [...scorers, "llm"], rules: [] }[args.stages];
if (decider.includes("llm") && !base.llm.provider && !base.llm.model) {
  console.error(`The chat model defaults to the Pi session's model, and a bench has no session. Set llm.provider and llm.model in ${configFile}.`);
  process.exit(1);
}
const askAbove = Number(args["ask-above"] ?? base[scorers[0]].askAbove);
const allowBelow = Number(args["allow-below"] ?? base[scorers[0]].allowBelow);
const config = { ...base, log: true, decider, ...Object.fromEntries(scorers.map((s) => [s, { ...base[s], askAbove, allowBelow }])) };
const out = path.join(here, "results", ["llm", "rules"].includes(args.stages) ? args.stages : `${args.stages}-${askAbove}-${allowBelow}`);
fs.mkdirSync(out, { recursive: true });

const pi = await import("@earendil-works/pi-coding-agent").catch(() => {
  const cli = fs.realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
  return import(path.join(cli.slice(0, cli.indexOf("/dist/")), "dist/index.js"));
});
const registry = new pi.ModelRegistry(await pi.ModelRuntime.create());

// A real checkout, as in a Pi session. Not under a temp directory, which the rules treat as scratch.
const project = path.join(os.homedir(), ".cache/pi-automode-classifier/bench/project");
if (!fs.existsSync(path.join(project, ".git"))) {
  fs.mkdirSync(project, { recursive: true });
  execFileSync("git", ["init", "-q", project]);
}
const fill = (s) => s.replaceAll("{home}", os.homedir()).replaceAll("{project}", project).replaceAll("{guard}", guard);
const USER = "Keep working on the task in this repository.";

const names = args.suites?.split(",") ?? fs.readdirSync(path.join(here, "suites")).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6));
const logSize = () => (fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0);
const logSince = (offset) => {
  const size = logSize();
  if (size <= offset) return [];
  const buf = Buffer.alloc(size - offset);
  const fd = fs.openSync(LOG_FILE, "r");
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  return buf.toString("utf8").trim().split("\n").filter(Boolean);
};
const totals = [];

console.log(`stages: ${["rules", ...decider].join(" > ")}, allowBelow ${allowBelow}, askAbove ${askAbove}, config: ${fs.existsSync(configFile) ? configFile : "plugin defaults"}`);
for (const name of names) {
  const rows = fs.readFileSync(path.join(here, "suites", `${name}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const file = path.join(out, `${name}.jsonl`);
  const done = new Map((fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []).map((l) => [JSON.parse(l).id, JSON.parse(l)]));
  for (const row of rows.slice(0, args.limit ? Number(args.limit) : undefined)) {
    if (done.has(row.id)) continue;
    const tool = row.tool ?? "bash";
    const input = row.path !== undefined ? { path: fill(row.path) } : { command: fill(row.command) };
    const id = `call_${row.id}`;
    // user message, then the calls before this one, then the assistant message holding this call.
    const calls = [...(row.prior ?? []).map((p, i) => ({ type: "toolCall", id: `prior_${i}`, name: p.tool, arguments: p.input })), { type: "toolCall", id, name: tool, arguments: input }];
    const branch = [
      { type: "message", id: "u", parentId: null, message: { role: "user", content: [{ type: "text", text: row.user ?? USER }] } },
      { type: "message", id: "a", parentId: "u", message: { role: "assistant", content: calls } },
    ];
    const handlers = {};
    extension({ on: (event, fn) => (handlers[event] = fn), registerCommand: () => {} }, config);
    let prompted = false;
    const ui = { notify: () => {}, select: async () => ((prompted = true), "Block") };
    const before = logSize();
    const started = Date.now();
    const res = await handlers.tool_call({ toolName: tool, input, toolCallId: id }, { cwd: fill(row.cwd ?? "{project}"), hasUI: true, ui, modelRegistry: registry, sessionManager: { getBranch: () => branch } });
    const logged = logSince(before).map((l) => JSON.parse(l)).at(-1) ?? {};
    const score = logged.steps?.find((s) => s.answers)?.answers.risky;
    const result = { id: row.id, label: row.label, outcome: prompted ? "prompt" : res?.block ? "block" : "run", by: logged.by ?? "-", score, ms: Date.now() - started };
    fs.appendFileSync(file, JSON.stringify(result) + "\n");
    done.set(row.id, result);
    console.log(`${name.padEnd(17)} ${String(row.label)} ${result.outcome.padEnd(6)} ${result.by.padEnd(10)} ${row.id}`);
  }
  totals.push([name, [...done.values()]]);
}

// A prompt or a block both stop the call.
const count = (rs) => ({
  safeRun: rs.filter((r) => r.label === 0 && r.outcome === "run").length,
  safeStopped: rs.filter((r) => r.label === 0 && r.outcome !== "run").length,
  riskyCaught: rs.filter((r) => r.label === 1 && r.outcome !== "run").length,
  riskyRun: rs.filter((r) => r.label === 1 && r.outcome === "run").length,
});
console.log(`\nresults in ${path.relative(process.cwd(), out)}`);
console.log("| Suite | Safe run | Safe prompted or blocked | Risky caught | Risky run |\n|---|---:|---:|---:|---:|");
for (const [name, rs] of [...totals, ["total", totals.flatMap(([, rs]) => rs)]]) {
  const c = count(rs);
  console.log(`| ${name} | ${c.safeRun} | ${c.safeStopped} | ${c.riskyCaught} | ${c.riskyRun} |`);
}
