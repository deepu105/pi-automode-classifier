// Auto mode for Pi: decides per tool call whether it runs, needs a confirm prompt, or is blocked.
//
// 1. Deterministic rules (rules.ts) settle most calls: allow, ask or deny. Your own rules from
//    the config replace the built-in verdict.
// 2. Shell commands the rules do not know go to a local decision model (Kev-0.8B) through a
//    llama-server `/v1/systemone` endpoint. A risk below `askAbove` runs without a prompt.
// 3. Everything else gets a confirm prompt: rule "ask" verdicts, a risk at or above
//    `askAbove`, input too long for the model, or a server that is down, slow or returns
//    something invalid. The model never blocks on its own. Without a UI (print mode,
//    subagents) these calls are blocked unless `withoutUi` is "allow".
//
// Covered tools: any tool with a string `command` input (bash and similar) and write/edit.
// Not covered: read-only tools, tools from other extensions without a `command` input, and
// `!` commands typed by the user. This is not a sandbox; see docs/security.md in Pi.
//
// With `classifier.provider` set the questions go to a hosted decision model (for example Jev)
// through Pi's model registry instead. For the local route the server is not part of this
// package: README.md shows how to run llama-server with the Kev-0.8B GGUF, alone or under
// LlamaStash. Another model on the same endpoint is not a drop-in
// swap (Julia-1 answers the yes/no question near 0 for almost everything), so re-run
// `node bench.mjs` after changing the questions, the model or `askAbove`.
//
// Optional CONFIG_FILE overrides DEFAULTS.
// Tested against Pi 1.0.4 and llama.cpp 5ad1c5da0 with ggml-org/Kev-0.8B-GGUF Q8_0.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bashVerdict, compileRules, fileVerdict, makeScope, type Action, type Verdict } from "./rules.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(HOME, ".pi/agent");
// User config lives outside the package so a package update does not overwrite it.
export const CONFIG_FILE = path.join(AGENT_DIR, "extensions/pi-automode-classifier/config.json");
export const LOG_FILE = path.join(process.env.XDG_STATE_HOME ?? path.join(HOME, ".local/state"), "pi-automode-classifier/decisions.jsonl");

// An extra yes/no question for the model. `yes` and `no` describe the two answers.
export interface Question {
  question: string;
  yes?: string;
  no?: string;
  // Defaults to the top-level askAbove.
  askAbove?: number;
}

export interface Config {
  // Starting state of a session. `/automode-classifier on|off` changes it for that session.
  enabled: boolean;
  endpoint: string;
  timeoutMs: number;
  // A model answer at or above this value gets a confirm prompt. 0 asks for every classified call.
  askAbove: number;
  // Command (argv) run when the endpoint refuses connections, for example
  // ["systemctl", "--user", "start", "pi-automode-classifier.service"]. Empty: start nothing.
  startCommand: string[];
  // What happens to a call that needs a prompt when there is no UI to show it.
  withoutUi: "block" | "allow";
  // Append every decision to LOG_FILE.
  log: boolean;
  // Patterns over one simple command; see compilePattern in rules.ts. They replace the built-in
  // verdict, except a built-in deny and the ask for the guard's own files.
  rules: Record<Action, string[]>;
  // Extra directories where file changes are allowed, like the project directory. `~` is expanded.
  allowedPaths: string[];
  // More files or directories that count as the guard's own (changes to them always ask),
  // for example the server's unit file. `~` is expanded.
  guardedPaths: string[];
  classifier: {
    // Pi provider id, for example "openrouter". When set, questions go through Pi's model
    // registry with Pi's credentials instead of `endpoint`, and every classified command and its
    // working directory are sent to that provider. Empty: the local server at `endpoint`.
    provider: string;
    // Local server: part of the model name the server must report, so a swapped model cannot
    // be trusted with questions and a threshold tuned for another one. Empty: any model.
    // With `provider`: the model id in Pi, for example "typesafe/jev-1.13".
    model: string;
    // The main question and the descriptions of its yes and no answers.
    question: string;
    risky: string;
    safe: string;
    // When set (2 to 10 entries, least risky first), the main question is asked as a score
    // over these levels instead of yes/no, and the risk is the expected level scaled to 0..1.
    levels: string[];
    // More questions, by id. A string is a bare question. Each one adds about one model call
    // of latency, and a yes at or above its threshold gets a prompt.
    extraQuestions: Record<string, string | Question>;
  };
}

export const DEFAULTS: Config = {
  enabled: true,
  endpoint: "http://127.0.0.1:11438",
  timeoutMs: 5000,
  askAbove: 0.2,
  startCommand: [],
  withoutUi: "block",
  log: true,
  rules: { deny: [], ask: [], classify: [], allow: [] },
  allowedPaths: [],
  guardedPaths: [],
  // Of the question designs compared on bench-cases.json, one yes/no question with both answers
  // described was the best or within 0.01 AUC of it on Kev-0.8B and Laya.
  classifier: {
    provider: "",
    model: "kev",
    question: "Is this command risky?",
    risky: "Deletes data, touches files outside the project, changes the system, uses credentials, or sends data to a remote server",
    safe: "Routine development work that only reads, builds, tests or edits files inside the project directory",
    levels: [],
    extraQuestions: {},
  },
};

// The guard's own files and Pi's settings: changes to them always ask.
const GUARDED = [HERE, path.dirname(CONFIG_FILE), path.join(AGENT_DIR, "settings.json")];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const isOptional = (v: unknown, type: string) => v === undefined || typeof v === type;
const isThreshold = (v: unknown) => typeof v === "number" && v >= 0 && v <= 1;
const isQuestion = (v: unknown) =>
  typeof v === "string" ||
  (isObject(v) &&
    Object.keys(v).every((k) => ["question", "yes", "no", "askAbove"].includes(k)) &&
    typeof v.question === "string" &&
    isOptional(v.yes, "string") &&
    typeof v.yes === typeof v.no &&
    (v.askAbove === undefined || isThreshold(v.askAbove)));

const CHECKS: Record<keyof Config, (v: unknown) => boolean> = {
  enabled: (v) => typeof v === "boolean",
  endpoint: (v) => typeof v === "string" && URL.canParse(v),
  timeoutMs: (v) => typeof v === "number" && v > 0,
  askAbove: isThreshold,
  startCommand: isStrings,
  withoutUi: (v) => v === "block" || v === "allow",
  log: (v) => typeof v === "boolean",
  rules: (v) => isObject(v) && Object.entries(v).every(([k, list]) => k in DEFAULTS.rules && isStrings(list)),
  allowedPaths: isStrings,
  guardedPaths: isStrings,
  classifier: (v) =>
    isObject(v) &&
    Object.keys(v).every((k) => k in DEFAULTS.classifier) &&
    isOptional(v.provider, "string") &&
    isOptional(v.model, "string") &&
    isOptional(v.question, "string") &&
    isOptional(v.risky, "string") &&
    isOptional(v.safe, "string") &&
    (v.levels === undefined || (isStrings(v.levels) && [0, 2, 3, 4, 5, 6, 7, 8, 9, 10].includes((v.levels as string[]).length))) &&
    (v.extraQuestions === undefined ||
      (isObject(v.extraQuestions) && Object.entries(v.extraQuestions).every(([id, q]) => id !== "risky" && isQuestion(q)))),
};

// A config with any error is ignored as a whole, so a typo cannot half-apply.
export function loadConfig(file = CONFIG_FILE): { config: Config; error?: string } {
  if (!fs.existsSync(file)) return { config: DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isObject(raw)) throw new Error("it must be a JSON object");
    for (const [key, value] of Object.entries(raw)) {
      if (!(key in CHECKS)) throw new Error(`unknown key "${key}"`);
      if (!CHECKS[key as keyof Config](value)) throw new Error(`invalid value for "${key}"`);
    }
    const config: Config = {
      ...DEFAULTS,
      ...raw,
      rules: { ...DEFAULTS.rules, ...(raw.rules as object) },
      classifier: { ...DEFAULTS.classifier, ...(raw.classifier as object) },
    };
    compileRules(config.rules);
    return { config };
  } catch (e) {
    return { config: DEFAULTS, error: `${file} ignored, using defaults: ${(e as Error).message}` };
  }
}

// Pi's registry calls a yes/no question "bool" and requires both answers to be described.
export function buildQuestions(config: Config) {
  const viaPi = Boolean(config.classifier.provider);
  const yesNo = (instructions: string, yes?: string, no?: string) =>
    viaPi
      ? { type: "bool", instructions, criteria: { true: yes ?? "Yes", false: no ?? "No" } }
      : { type: "noul", instructions, ...(yes !== undefined && no !== undefined ? { criteria: { true: yes, false: no } } : {}) };
  const { question, risky, safe, levels, extraQuestions } = config.classifier;
  const main = levels.length ? { type: "score", instructions: question, criteria: levels } : yesNo(question, risky, safe);
  const questions: Record<string, object> = { risky: main };
  for (const [id, q] of Object.entries(extraQuestions)) questions[id] = typeof q === "string" ? yesNo(q) : yesNo(q.question, q.yes, q.no);
  return questions;
}

// The first question answered at or above its threshold, the main question first.
export function flagged(config: Config, answers: Record<string, number>): string | undefined {
  if (answers.risky >= config.askAbove) return `model risk ${answers.risky.toFixed(2)} (asks at ${config.askAbove} and above)`;
  for (const [id, q] of Object.entries(config.classifier.extraQuestions)) {
    const threshold = (typeof q === "string" ? undefined : q.askAbove) ?? config.askAbove;
    if (answers[id] >= threshold) return `model says yes to "${id}": ${answers[id].toFixed(2)} (asks at ${threshold} and above)`;
  }
  return undefined;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)} ... (${text.length} chars)` : text);

export type Classified = { answers: Record<string, number>; ms: number; tokens?: number } | { error: string; ms: number };

// The part of Pi's model registry this uses: `ctx.modelRegistry` in a session, or one built
// from Pi's SDK in bench.mjs.
export interface Registry {
  findOfType(type: "classifier", provider: string, id: string): unknown;
  classify(
    model: unknown,
    context: { state: Record<string, unknown>; questions: Record<string, object> },
    options?: { signal?: AbortSignal },
  ): Promise<{ answers?: Record<string, unknown>; stopReason?: string; errorMessage?: string; usage?: { input?: number } }>;
}

// Risk per question id, each scaled to 0..1. Undefined when an answer is missing or malformed.
function readAnswers(config: Config, ids: string[], raw: Record<string, unknown> | undefined): Record<string, number> | undefined {
  const { levels } = config.classifier;
  const answers: Record<string, number> = {};
  for (const id of ids) {
    const answer = raw?.[id] as { noul?: number; probability?: number; score?: number } | undefined;
    const p = id === "risky" && levels.length ? (answer?.score as number) / (levels.length - 1) : (answer?.noul ?? answer?.probability);
    if (typeof p !== "number" || !(p >= 0 && p <= 1)) return undefined;
    answers[id] = p;
  }
  return answers;
}

async function health(config: Config, timeoutMs: number): Promise<boolean> {
  try {
    return (await fetch(`${config.endpoint}/health`, { signal: AbortSignal.timeout(timeoutMs) })).ok;
  } catch {
    return false;
  }
}

let lastStart = 0;
// Runs startCommand and waits until the endpoint answers. At most one attempt per 30 s.
async function startServer(config: Config, waitMs: number): Promise<boolean> {
  if (!config.startCommand.length || Date.now() - lastStart < 30_000) return false;
  lastStart = Date.now();
  spawn(config.startCommand[0], config.startCommand.slice(1), { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
  for (const deadline = Date.now() + waitMs; Date.now() < deadline; ) {
    if (await health(config, 300)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function classify(config: Config, state: Record<string, string>, signal?: AbortSignal, registry?: Registry): Promise<Classified> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const questions = buildQuestions(config);
  const ids = Object.keys(questions);
  const timedOut = { error: `no answer in ${config.timeoutMs} ms`, ms: 0 };
  const { provider, model: expected } = config.classifier;

  if (provider) {
    const model = registry?.findOfType("classifier", provider, expected);
    if (!registry || !model) return { error: `Pi has no classifier model ${provider}/${expected}`, ms: ms() };
    const timeout = AbortSignal.timeout(config.timeoutMs);
    // classify() never rejects; a failure comes back as a stop reason.
    const result = await registry.classify(model, { state, questions }, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (timeout.aborted) return { ...timedOut, ms: ms() };
    if (result.stopReason !== "stop") return { error: clip(result.errorMessage ?? `${provider}/${expected} gave no answer`, 200), ms: ms() };
    const answers = readAnswers(config, ids, result.answers);
    return answers ? { answers, ms: ms(), tokens: result.usage?.input } : { error: "invalid response from the model", ms: ms() };
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const timeout = AbortSignal.timeout(config.timeoutMs);
      const res = await fetch(`${config.endpoint}/v1/systemone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, questions }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const body = await res.json().catch(() => undefined);
      if (!res.ok) {
        const message = String(body?.error?.message ?? `HTTP ${res.status}`);
        return { error: /too large|exceeds the available context/.test(message) ? "command is too long for the model" : message, ms: ms() };
      }
      const served = String(body?.model ?? "");
      if (expected && !served.toLowerCase().includes(expected.toLowerCase())) {
        return { error: `the server runs ${path.basename(served) || "an unnamed model"}, the config expects "${expected}" (classifier.model)`, ms: ms() };
      }
      const answers = readAnswers(config, ids, body?.answers);
      return answers ? { answers, ms: ms(), tokens: body?.usage?.input_tokens } : { error: "invalid response from the model", ms: ms() };
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      if (err.name === "TimeoutError") return { ...timedOut, ms: ms() };
      if (attempt === 0 && err.cause?.code === "ECONNREFUSED" && (await startServer(config, config.timeoutMs))) continue;
      return { error: `server not reachable at ${config.endpoint}`, ms: ms() };
    }
  }
}

function log(config: Config, entry: Record<string, unknown>) {
  if (!config.log) return;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  } catch {
    // The log is for tuning only; a write failure must not change a decision.
  }
}

// `overrides` is for test.mjs and bench.mjs; Pi calls this with one argument.
export default function (pi: ExtensionAPI, overrides: Partial<Config> = {}) {
  const loaded = loadConfig();
  const config = { ...loaded.config, ...overrides };
  const configError = loaded.error;
  const scopeOptions = { allowedPaths: config.allowedPaths, rules: compileRules(config.rules) };
  const guarded = [...GUARDED, ...config.guardedPaths];
  let enabled = config.enabled;
  const counts = { rule: 0, model: 0, asked: 0, blocked: 0 };
  // Exact commands and paths the user allowed for the rest of the session.
  const sessionAllowed = new Set<string>();
  // Tool calls of one message run in parallel; show one prompt at a time.
  let prompts: Promise<unknown> = Promise.resolve();

  pi.on("session_start", async (_event, ctx) => {
    if (configError && ctx.hasUI) ctx.ui.notify(`pi-automode-classifier: ${configError}`, "warning");
    // Warm the server in the background so the first classified call does not wait for it.
    if (enabled && !config.classifier.provider) void health(config, 300).then((up) => up || startServer(config, 10_000));
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled) return undefined;
    const input = event.input as Record<string, unknown>;
    const scope = makeScope(ctx.cwd, guarded, scopeOptions);
    let subject: string;
    let verdict: Verdict;
    if (typeof input.command === "string") {
      subject = input.command;
      verdict = bashVerdict(subject, scope);
    } else if ((event.toolName === "write" || event.toolName === "edit") && typeof input.path === "string") {
      subject = input.path;
      verdict = fileVerdict(event.toolName, subject, scope);
    } else return undefined;

    const entry: Record<string, unknown> = { tool: event.toolName, cwd: ctx.cwd, subject: clip(subject, 4000), rule: verdict.action, reason: verdict.reason };
    const finish = (outcome: string, by: string) => log(config, { ...entry, outcome, by });

    if (verdict.action === "classify") {
      const result = await classify(config, { tool: event.toolName, cwd: ctx.cwd, command: subject }, ctx.signal, ctx.modelRegistry as unknown as Registry);
      Object.assign(entry, result);
      const reason = "answers" in result ? flagged(config, result.answers) : `model gave no answer: ${result.error}`;
      if (!reason) {
        counts.model++;
        finish("allow", "model");
        return undefined;
      }
      verdict = { action: "ask", reason };
    }

    if (verdict.action === "allow") {
      counts.rule++;
      finish("allow", "rule");
      return undefined;
    }
    if (verdict.action === "deny") {
      counts.blocked++;
      finish("block", "rule");
      if (ctx.hasUI) ctx.ui.notify(`Blocked ${event.toolName}: ${verdict.reason}`, "warning");
      return { block: true, reason: `Blocked by pi-automode-classifier: ${verdict.reason}. Do not retry it or work around it. Tell the user it was blocked.` };
    }

    const key = `${event.toolName}\0${ctx.cwd}\0${subject}`;
    if (sessionAllowed.has(key)) {
      finish("allow", "session");
      return undefined;
    }
    if (!ctx.hasUI) {
      if (config.withoutUi === "allow") {
        finish("allow", "no-ui");
        return undefined;
      }
      counts.blocked++;
      finish("block", "no-ui");
      return { block: true, reason: `This needs the user's approval (${verdict.reason}) and there is no UI to ask. Do not work around it. Tell the user.` };
    }

    counts.asked++;
    const title = `Auto mode: allow ${event.toolName}?\n${verdict.reason}\n\n${clip(subject, 1200)}`;
    const answer = prompts.then(() => ctx.ui.select(title, ["Allow once", "Allow for this session", "Block"], { signal: ctx.signal }));
    prompts = answer.catch(() => undefined);
    const choice = await answer;
    if (choice === "Allow for this session") sessionAllowed.add(key);
    if (choice === "Allow once" || choice === "Allow for this session") {
      finish("allow", "user");
      return undefined;
    }
    counts.blocked++;
    finish("block", "user");
    return { block: true, reason: `The user blocked this (${verdict.reason}). Do not retry it or work around it. Ask the user how to proceed.` };
  });

  pi.registerCommand("automode-classifier", {
    description: "Auto mode guard: status | on | off",
    getArgumentCompletions: (prefix) => ["status", "on", "off"].filter((a) => a.startsWith(prefix)).map((a) => ({ value: a, label: a })),
    handler: async (args, ctx: ExtensionContext) => {
      const arg = args.trim();
      if (arg === "on" || arg === "off") enabled = arg === "on";
      else if (arg && arg !== "status") return ctx.ui.notify("Usage: /automode-classifier status | on | off", "warning");
      const { provider, model } = config.classifier;
      const where = provider ? `model ${provider}/${model} through Pi (commands are sent to ${provider})` : `model server ${config.endpoint}: ${(await health(config, 500)) ? "up" : "down"}`;
      const rules = config.rules;
      const extra = Object.keys(config.classifier.extraQuestions);
      ctx.ui.notify(
        [
          `pi-automode-classifier: ${enabled ? "on" : "OFF for this session"}`,
          `${where} (asks at risk >= ${config.askAbove})${extra.length ? `, extra questions: ${extra.join(", ")}` : ""}`,
          `your rules: ${rules.deny.length} deny, ${rules.ask.length} ask, ${rules.classify.length} classify, ${rules.allow.length} allow; ${config.allowedPaths.length} allowed paths`,
          `this session: ${counts.rule} allowed by rule, ${counts.model} by model, ${counts.asked} asked, ${counts.blocked} blocked`,
          `config: ${CONFIG_FILE}${fs.existsSync(CONFIG_FILE) ? "" : " (not present, defaults in use)"}`,
          config.log ? `log: ${LOG_FILE}` : "log: off",
          ...(configError ? [configError] : []),
        ].join("\n"),
        enabled && !configError ? "info" : "warning",
      );
    },
  });
}
