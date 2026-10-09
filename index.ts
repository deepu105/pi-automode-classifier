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
// Covered tools: any tool with a string `command` input (bash and similar), write/edit, and
// read/grep of a credential file.
// Not covered: other reads, tools from other extensions without a `command` input, and
// `!` commands typed by the user. This is not a sandbox; see docs/security.md in Pi.
//
// With `classifier.provider` set the questions go to a hosted decision model (for example Jev)
// through Pi's model registry instead, and with `classifier.command` to a classifier that runs
// as a local process (for example LANCET). For the local route the server is not part of this
// package: README.md shows how to run llama-server with the Kev-0.8B GGUF, alone or under
// LlamaStash. Another model on the same endpoint is not a drop-in
// swap (Julia-1 answers the yes/no question near 0 for almost everything), so re-run
// `node bench.mjs` after changing the questions, the model or `askAbove`.
//
// Optional CONFIG_FILE overrides DEFAULTS.
// Tested against Pi 1.1.0, llama.cpp 5ad1c5da0 with ggml-org/Kev-0.8B-GGUF Q8_0, and LANCET Nano 0.4.3.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bashVerdict, commitWrites, compileRules, fileVerdict, isRootLike, makeScope, readVerdict, type Action, type SessionFiles, type Verdict } from "./rules.ts";

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
    // Command (argv) of a classifier that runs as a local process, for example LANCET's
    // classify.py. When set it is used instead of `endpoint` and `provider`: each command goes
    // to its stdin as a JSON line {"command", "shell"} and it answers with a JSON line that has
    // a `score` from 0 to 1. The questions below are not used. A leading `~/` is expanded.
    command: string[];
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
    command: [],
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
    (v.command === undefined || isStrings(v.command)) &&
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

// ---- classifier process ----

// `classifier.command`: the process stays up between calls and gets one command at a time.
// Every Pi process has its own, so it starts on the first command the rules leave to it and
// stops after CLASSIFIER_IDLE_MS without one.
const CLASSIFIER_IDLE_MS = 5 * 60_000;
interface ClassifierProcess {
  // The command line it was started with.
  key: string;
  child: ChildProcess;
  buffer: string;
  // Receives the next output line, or undefined when the process is gone.
  waiting?: (line: string | undefined) => void;
}
let classifierProcess: ClassifierProcess | undefined;
let classifierTurn: Promise<unknown> = Promise.resolve();
let classifierIdle: NodeJS.Timeout | undefined;

export const classifierProcessPid = () => classifierProcess?.child.pid;

export function stopClassifierProcess() {
  clearTimeout(classifierIdle);
  classifierProcess?.child.kill();
  classifierProcess = undefined;
}

function startClassifierProcess(command: string[]): ClassifierProcess {
  const [program, ...args] = command.map((word) => (word.startsWith("~/") ? HOME + word.slice(1) : word));
  const child = spawn(program, args, { stdio: ["pipe", "pipe", "ignore"] });
  const started: ClassifierProcess = { key: command.join("\0"), child, buffer: "" };
  const deliver = (line: string | undefined) => {
    const waiting = started.waiting;
    started.waiting = undefined;
    waiting?.(line);
  };
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    started.buffer += chunk;
    const end = started.buffer.indexOf("\n");
    if (end < 0 || !started.waiting) return;
    const line = started.buffer.slice(0, end);
    started.buffer = started.buffer.slice(end + 1);
    deliver(line);
  });
  const gone = () => {
    if (classifierProcess === started) classifierProcess = undefined;
    deliver(undefined);
  };
  child.on("error", gone).on("exit", gone);
  child.stdin!.on("error", () => {});
  // The process must not keep Pi alive; a call that waits for an answer holds its own timer.
  child.unref();
  for (const stream of [child.stdin, child.stdout]) (stream as unknown as { unref?: () => void }).unref?.();
  return started;
}

function askClassifierProcess(config: Config, state: Record<string, string>, signal?: AbortSignal): Promise<Classified> {
  const run = async (): Promise<Classified> => {
    const startedAt = performance.now();
    const ms = () => Math.round(performance.now() - startedAt);
    const program = classifierName(config);
    if (classifierProcess?.key !== config.classifier.command.join("\0")) stopClassifierProcess();
    const proc = (classifierProcess ??= startClassifierProcess(config.classifier.command));
    proc.buffer = "";
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    const line = await new Promise<string | undefined | "timeout" | "cancelled">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), config.timeoutMs);
      abort = () => resolve("cancelled");
      signal?.addEventListener("abort", abort, { once: true });
      proc.waiting = resolve;
      proc.child.stdin!.write(JSON.stringify({ command: state.command ?? "", shell: "bash", cwd: state.cwd }) + "\n");
    });
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    clearTimeout(classifierIdle);
    classifierIdle = setTimeout(stopClassifierProcess, CLASSIFIER_IDLE_MS);
    classifierIdle.unref();
    if (line === "timeout" || line === "cancelled") {
      // Its late answer would be read as the answer to the next command.
      stopClassifierProcess();
      return { error: line === "timeout" ? `no answer in ${config.timeoutMs} ms` : "the call was cancelled", ms: ms() };
    }
    if (line === undefined) return { error: `the classifier process ${program} is not running`, ms: ms() };
    let answer: { score?: unknown; reason?: unknown } | undefined;
    try {
      answer = JSON.parse(line);
    } catch {
      // Handled below as a missing score.
    }
    const score = answer?.score;
    if (typeof score === "number" && score >= 0 && score <= 1) return { answers: { risky: score }, ms: ms() };
    return { error: `${program} gave no score${typeof answer?.reason === "string" ? ` (${answer.reason})` : ""}`, ms: ms() };
  };
  const result = classifierTurn.then(run, run);
  classifierTurn = result.catch(() => undefined);
  return result;
}

// ---- git ----

function git(dir: string, ...args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
  } catch {
    return undefined;
  }
}
const realpath = (p: string) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
};

// The checkouts of the git repository that holds `cwd`: the main one and its worktrees. Empty
// outside a repository. $HOME and the directories above it are left out.
export function checkouts(cwd: string): string[] {
  const entries = (git(cwd, "worktree", "list", "--porcelain") ?? "").split("\n\n");
  return entries
    .filter((entry) => !/^bare$/m.test(entry))
    .flatMap((entry) => /^worktree (.+)$/m.exec(entry)?.[1] ?? [])
    .map(realpath)
    .filter((dir) => !isRootLike(dir));
}

// True when `file` is tracked or ignored by the repository checked out in one of `roots`. A
// repository cloned inside a checkout is a different one, so its files do not count.
export function inCheckout(file: string, roots: string[]): boolean {
  const dir = path.dirname(file);
  const top = git(dir, "rev-parse", "--show-toplevel")?.trim();
  if (!top || !roots.includes(realpath(top))) return false;
  return git(dir, "ls-files", "--error-unmatch", "--", file) !== undefined || git(dir, "check-ignore", "-q", "--", file) !== undefined;
}

// ---- config file ----

// Appends `value` to a list in the config file. Returns an error text when the file cannot be
// read as a config or cannot be written.
function saveToConfig(list: "allowedPaths" | "allow", value: string): string | undefined {
  try {
    const raw: unknown = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) : {};
    if (!isObject(raw)) throw new Error("it must be a JSON object");
    if (list === "allow" && raw.rules === undefined) raw.rules = {};
    const holder = list === "allow" ? raw.rules : raw;
    if (!isObject(holder)) throw new Error('"rules" is not an object');
    const current = holder[list] ?? [];
    if (!isStrings(current)) throw new Error(`"${list}" is not a list of strings`);
    if (!(current as string[]).includes(value)) holder[list] = [...(current as string[]), value];
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2) + "\n");
    return undefined;
  } catch (e) {
    return `could not save to ${CONFIG_FILE}: ${(e as Error).message}`;
  }
}

// What answers the questions, for the log and the status command.
export const classifierName = ({ classifier }: Config) =>
  classifier.command.length
    ? classifier.command.filter((word) => !word.startsWith("-")).slice(0, 2).map((word) => path.basename(word)).join(" ")
    : classifier.provider
      ? `${classifier.provider}/${classifier.model}`
      : classifier.model;

export async function classify(config: Config, state: Record<string, string>, signal?: AbortSignal, registry?: Registry): Promise<Classified> {
  if (config.classifier.command.length) return askClassifierProcess(config, state, signal);
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
  // The user's rules, plus the allow patterns picked in a prompt during this session.
  const allowPatterns = [...config.rules.allow];
  let rules = compileRules(config.rules);
  const allowedPaths = [...config.allowedPaths];
  const guarded = [...GUARDED, ...config.guardedPaths];
  let enabled = config.enabled;
  const counts = { rule: 0, model: 0, asked: 0, blocked: 0 };
  // Exact commands and paths the user allowed for the rest of the session.
  const sessionAllowed = new Set<string>();
  // Files the session wrote or downloaded, as far as the rules saw it.
  const files: SessionFiles = new Map();
  // Git checkouts per working directory, as they were when the session first used it. A
  // worktree added later asks once, so `git worktree add` cannot open a folder by itself.
  const repositories = new Map<string, string[]>();
  // Tool calls of one message run in parallel; show one prompt at a time.
  let prompts: Promise<unknown> = Promise.resolve();

  pi.on("session_start", async (_event, ctx) => {
    if (configError && ctx.hasUI) ctx.ui.notify(`pi-automode-classifier: ${configError}`, "warning");
    // Warm the server in the background so the first classified call does not wait for it.
    if (enabled && !config.classifier.command.length && !config.classifier.provider) void health(config, 300).then((up) => up || startServer(config, 10_000));
  });
  pi.on("session_shutdown", async () => stopClassifierProcess());

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled) return undefined;
    const input = event.input as Record<string, unknown>;
    if (!repositories.has(ctx.cwd)) repositories.set(ctx.cwd, checkouts(ctx.cwd));
    const roots = repositories.get(ctx.cwd)!;
    const scope = makeScope(ctx.cwd, guarded, { rules, allowedPaths: [...allowedPaths, ...roots], files, project: (p) => inCheckout(p, roots) });
    let subject: string;
    let verdict: Verdict;
    if (typeof input.command === "string") {
      subject = input.command;
      verdict = bashVerdict(subject, scope);
    } else if ((event.toolName === "write" || event.toolName === "edit") && typeof input.path === "string") {
      subject = input.path;
      verdict = fileVerdict(event.toolName, subject, scope);
    } else if ((event.toolName === "read" || event.toolName === "grep") && typeof input.path === "string") {
      // Reads are not checked, except for credential files.
      const secret = readVerdict(event.toolName, input.path, scope);
      if (!secret) return undefined;
      subject = input.path;
      verdict = secret;
    } else return undefined;

    const entry: Record<string, unknown> = { tool: event.toolName, cwd: ctx.cwd, subject: clip(subject, 4000), rule: verdict.action, reason: verdict.reason };
    const finish = (outcome: string, by: string) => {
      if (outcome === "allow") commitWrites(scope);
      log(config, { ...entry, outcome, by });
    };

    if (verdict.action === "classify") {
      const result = await classify(config, { tool: event.toolName, cwd: ctx.cwd, command: subject }, ctx.signal, ctx.modelRegistry as unknown as Registry);
      Object.assign(entry, result, { model: classifierName(config) });
      const reason = "answers" in result ? flagged(config, result.answers) : `model gave no answer: ${result.error}`;
      if (!reason) {
        counts.model++;
        finish("allow", "model");
        return undefined;
      }
      verdict = { action: "ask", reason, pattern: verdict.pattern };
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
    // A change outside the working directory can be allowed for its whole folder, and a command
    // the rules do not know for its pattern, so the next one does not ask again. Both can also
    // be saved to the config file.
    const dir = verdict.dir?.replace(HOME, "~");
    const covers = dir ? `changes in ${dir}` : verdict.pattern ? `"${verdict.pattern}"` : undefined;
    const forSession = covers ? `Allow ${covers} for this session` : "Allow for this session";
    const always = covers ? `Always allow ${covers}` : undefined;
    const answer = prompts.then(() => ctx.ui.select(title, ["Allow once", forSession, ...(always ? [always] : []), "Block"], { signal: ctx.signal }));
    prompts = answer.catch(() => undefined);
    const choice = await answer;
    const wider = choice === forSession || (always !== undefined && choice === always);
    if (wider) {
      if (verdict.dir) allowedPaths.push(verdict.dir);
      else if (verdict.pattern) {
        allowPatterns.push(verdict.pattern);
        rules = compileRules({ ...config.rules, allow: allowPatterns });
      } else sessionAllowed.add(key);
    }
    if (always !== undefined && choice === always) {
      const error = verdict.dir ? saveToConfig("allowedPaths", dir!) : saveToConfig("allow", verdict.pattern!);
      if (error) ctx.ui.notify(`pi-automode-classifier: ${error}`, "warning");
    }
    if (choice === "Allow once" || wider) {
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
      const { provider, model, command } = config.classifier;
      const where = command.length
        ? `classifier process ${command.join(" ")}: ${classifierProcess ? "running" : "not running"}`
        : provider
          ? `model ${provider}/${model} through Pi (commands are sent to ${provider})`
          : `model server ${config.endpoint}: ${(await health(config, 500)) ? "up" : "down"}`;
      const extra = Object.keys(config.classifier.extraQuestions);
      ctx.ui.notify(
        [
          `pi-automode-classifier: ${enabled ? "on" : "OFF for this session"}`,
          `${where} (asks at risk >= ${config.askAbove})${extra.length ? `, extra questions: ${extra.join(", ")}` : ""}`,
          `your rules: ${rules.deny.length} deny, ${rules.ask.length} ask, ${rules.classify.length} classify, ${rules.allow.length} allow; ${allowedPaths.length} allowed paths`,
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
