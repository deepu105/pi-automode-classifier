// Auto mode for Pi: decides per tool call whether it runs, needs a confirm prompt, or is blocked.
//
// 1. Deterministic rules (rules.ts) settle most calls: allow, ask or deny. Your own rules from
//    the config replace the built-in verdict.
// 2. Calls the rules leave open go to the deciders listed in `decider`, in that order.
//    - "llm" (the default) is a chat model: the session's own, or `llm.provider`/`llm.model`. It
//      judges with the same context as Claude Code's auto mode: the user's messages and the
//      session's tool calls (automode.ts). It also gets most asks (forDecider in rules.ts), and
//      blocks what it judges unsafe.
//    - "classifier" is a decision model (Kev-0.8B on a llama-server `/v1/systemone` endpoint, or
//      one through Pi such as Jev), and "command" a classifier that runs as a local process
//      (LANCET). Each scores a call from 0 to 1. At or above `askAbove` it asks you; below, the
//      call runs. When another decider comes next, a score from `allowBelow` up to `askAbove`
//      goes to that one instead. A classifier never blocks.
// 3. Everything else gets a confirm prompt: rule "ask" verdicts, a score at or above `askAbove`,
//    and a last classifier that is down, slow or gives no score. Without a UI (print mode,
//    subagents) these calls are blocked unless `withoutUi.onAsk` is "allow".
//
// Covered tools: any tool with a string `command` input (bash and similar), write/edit, and
// read/grep of a credential file.
// Not covered: other reads, tools from other extensions without a `command` input, and
// `!` commands typed by the user. This is not a sandbox; see docs/security.md in Pi.
//
// With `classifier.provider` set the classifier questions go to a hosted decision model (for
// example Jev) through Pi's model registry instead of `classifier.endpoint`. The local server is
// not part of this package: README.md shows how to run llama-server with the Kev-0.8B GGUF, alone
// or under LlamaStash. Another model on the same endpoint is not a drop-in
// swap (Julia-1 answers the yes/no question near 0 for almost everything), so re-run
// `npm run bench` after changing the questions, the model or `askAbove`.
//
// Optional CONFIG_FILE overrides DEFAULTS.
// Tested against Pi 1.1.0, llama.cpp 5ad1c5da0 with ggml-org/Kev-0.8B-GGUF Q8_0, and LANCET Nano 0.4.3.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bashVerdict, commitWrites, compileRules, fileVerdict, isRootLike, makeScope, readVerdict, within, type Action, type SessionFiles, type Verdict } from "./rules.ts";
import { buildSystemPrompt, buildTranscript, denyMessage, mergeRules, parseVerdict, STAGE1_INSTRUCTION, stage2Instruction, DEFAULT_RULES, DEFAULT_LLM, type LlmConfig, type Outcome, type TranscriptItem } from "./automode.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(HOME, ".pi/agent");
// User config lives outside the package so a package update does not overwrite it.
export const CONFIG_FILE = path.join(AGENT_DIR, "extensions/pi-automode-classifier/config.json");
const EXAMPLE_FILE = path.join(HERE, "config.example.jsonc");
export const LOG_FILE = path.join(process.env.XDG_STATE_HOME ?? path.join(HOME, ".local/state"), "pi-automode-classifier/decisions.jsonl");

// An extra yes/no question for the model. `yes` and `no` describe the two answers.
export interface Question {
  question: string;
  yes?: string;
  no?: string;
  // Defaults to classifier.askAbove.
  askAbove?: number;
}

export type Decider = "llm" | "classifier" | "command";
type Scorer = Exclude<Decider, "llm">;

export interface ClassifierConfig {
  // Local decision model server, used when `provider` is empty.
  endpoint: string;
  // Command (argv) run when the endpoint refuses connections, for example
  // ["systemctl", "--user", "start", "pi-automode-classifier.service"]. Empty: start nothing.
  startCommand: string[];
  // Pi provider id, for example "openrouter". When set, questions go through Pi's model
  // registry with Pi's credentials instead of `endpoint`, and every classified command and its
  // working directory are sent to that provider.
  provider: string;
  // Local server: part of the model name the server must report, so a swapped model cannot
  // be trusted with questions and a threshold tuned for another one. Empty: any model.
  // With `provider`: the model id in Pi, for example "typesafe/jev-1.13".
  model: string;
  timeoutMs: number;
  // A risk at or above this gets a confirm prompt. 0 asks for every classified call.
  askAbove: number;
  // Only used when another decider comes next: a score from this up to askAbove goes to it.
  allowBelow: number;
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
}

export interface Config {
  // Starting state of a session. `/automode-classifier on|off` changes it for that session.
  enabled: boolean;
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
  withoutUi: {
    // What happens to a call that needs a prompt when there is no UI to show it.
    onAsk: "block" | "allow";
    // Added to `rules` when there is no UI. A deny here wins over an allow in `rules`.
    rules: { allow: string[]; deny: string[] };
  };
  // Who judges the calls the rules leave open, in the order they run. "llm" must be last. Not
  // set: ["command"] if command.argv is set, ["classifier"] if the file has a `classifier`
  // block, ["llm"] otherwise. Empty: those calls ask you, as with a 0.2 config that used a
  // classifier.
  decider: Decider[];
  classifier: ClassifierConfig;
  // A general chat model as the decider, in Claude Code auto mode style.
  llm: LlmConfig;
  // A classifier that runs as a local process, for example LANCET's classify.py. Each command
  // goes to its stdin as a JSON line {"command", "shell", "cwd"} and it answers with a JSON line
  // that has a `score` from 0 to 1. A leading `~/` in argv is expanded.
  command: { argv: string[]; timeoutMs: number; askAbove: number; allowBelow: number };
}

export const DEFAULTS: Config = {
  enabled: true,
  log: true,
  rules: { deny: [], ask: [], classify: [], allow: [] },
  allowedPaths: [],
  guardedPaths: [],
  withoutUi: { onAsk: "block", rules: { allow: [], deny: [] } },
  decider: ["llm"],
  // Of the question designs compared on bench/suites/bench-cases.jsonl, one yes/no question with both answers
  // described was the best or within 0.01 AUC of it on Kev-0.8B and Laya.
  classifier: {
    endpoint: "http://127.0.0.1:11438",
    startCommand: [],
    provider: "",
    model: "kev",
    timeoutMs: 5000,
    askAbove: 0.2,
    allowBelow: 0.1,
    question: "Is this command risky?",
    risky: "Deletes data, touches files outside the project, changes the system, uses credentials, or sends data to a remote server",
    safe: "Routine development work that only reads, builds, tests or edits files inside the project directory",
    levels: [],
    extraQuestions: {},
  },
  llm: DEFAULT_LLM,
  // Picked with LANCET Nano 0.4.3; the README has the numbers.
  command: { argv: [], timeoutMs: 5000, askAbove: 0.2, allowBelow: 0.1 },
};

// The guard's own files and Pi's settings: changes to them always ask.
const GUARDED = [HERE, path.dirname(CONFIG_FILE), path.join(AGENT_DIR, "settings.json")];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const isBool = (v: unknown) => typeof v === "boolean";
const isString = (v: unknown) => typeof v === "string";
const isThreshold = (v: unknown) => typeof v === "number" && v >= 0 && v <= 1;
const atLeast = (min: number) => (v: unknown) => typeof v === "number" && v >= min;
const oneOf = (...values: string[]) => (v: unknown) => values.includes(v as string);
// AbortSignal.timeout throws above this.
const isTimeout = (v: unknown) => typeof v === "number" && v > 0 && v <= 2_147_483_647;
const isQuestion = (v: unknown) =>
  typeof v === "string" ||
  (isObject(v) &&
    Object.keys(v).every((k) => ["question", "yes", "no", "askAbove"].includes(k)) &&
    typeof v.question === "string" &&
    (v.yes === undefined || typeof v.yes === "string") &&
    typeof v.yes === typeof v.no &&
    (v.askAbove === undefined || isThreshold(v.askAbove)));

// Every key is optional: what the file leaves out keeps its default. A nested object is merged
// over its default; anything with a check is replaced whole.
type Check = (v: unknown) => boolean;
interface Schema {
  [key: string]: Check | Schema;
}
const SCHEMA: Schema = {
  enabled: isBool,
  log: isBool,
  rules: { deny: isStrings, ask: isStrings, classify: isStrings, allow: isStrings },
  allowedPaths: isStrings,
  guardedPaths: isStrings,
  withoutUi: { onAsk: oneOf("block", "allow"), rules: { allow: isStrings, deny: isStrings } },
  decider: (v) => isStrings(v) && (v as string[]).every((d) => ["llm", "classifier", "command"].includes(d)) && new Set(v as string[]).size === (v as string[]).length,
  classifier: {
    endpoint: (v) => typeof v === "string" && URL.canParse(v),
    startCommand: isStrings,
    provider: isString,
    model: isString,
    timeoutMs: isTimeout,
    askAbove: isThreshold,
    allowBelow: isThreshold,
    question: isString,
    risky: isString,
    safe: isString,
    levels: (v) => isStrings(v) && (v as string[]).length !== 1 && (v as string[]).length <= 10,
    extraQuestions: (v) => isObject(v) && Object.entries(v).every(([id, q]) => id !== "risky" && isQuestion(q)),
  },
  llm: {
    provider: isString,
    model: isString,
    name: isString,
    contextWindow: (v) => v === 0 || atLeast(1024)(v),
    maxTokens: atLeast(16),
    thinkingLevel: oneOf("off", "minimal", "low", "medium", "high", "xhigh", "max"),
    warmCache: isBool,
    twoStage: isBool,
    stage1MaxTokens: atLeast(4),
    timeoutMs: isTimeout,
    onNoAnswer: oneOf("block", "ask"),
    onBlock: oneOf("block", "ask"),
    maxConsecutiveDenials: atLeast(1),
    maxTotalDenials: atLeast(1),
    transcript: {
      maxEntries: atLeast(1),
      maxChars: atLeast(1),
      toolInputChars: atLeast(1),
      userMessageChars: atLeast(1),
      includeAssistantText: isBool,
      includeToolResults: isBool,
    },
    prompt: { environment: isStrings, hardDeny: isStrings, softDeny: isStrings, allow: isStrings },
  },
  command: { argv: isStrings, timeoutMs: isTimeout, askAbove: isThreshold, allowBelow: isThreshold },
};

// The first problem in `value`, naming its key. Own keys only, so "toString" is unknown.
function problem(value: unknown, schema: Schema, at = ""): string | undefined {
  if (!isObject(value)) return at ? `"${at.slice(0, -1)}" must be an object` : "it must be a JSON object";
  for (const [key, v] of Object.entries(value)) {
    if (!Object.hasOwn(schema, key)) return `unknown key "${at}${key}"`;
    const check = schema[key];
    const found = typeof check === "function" ? (check(v) ? undefined : `invalid value for "${at}${key}"`) : problem(v, check, `${at}${key}.`);
    if (found) return found;
  }
  return undefined;
}

function merge(defaults: Record<string, unknown>, raw: Record<string, unknown>, schema: Schema): Record<string, unknown> {
  const out = { ...defaults };
  for (const [key, v] of Object.entries(raw)) {
    const check = schema[key];
    out[key] = typeof check === "function" ? v : merge(defaults[key] as Record<string, unknown>, v as Record<string, unknown>, check);
  }
  return out;
}

// Keys of the 0.2 shape, and where 0.3 put them.
function moved(raw: Record<string, unknown>): string[] {
  const classifier = isObject(raw.classifier) ? raw.classifier : {};
  // The timeout and threshold belonged to whichever classifier the file used.
  const owner = (key: string) => (Object.hasOwn(classifier, "command") && (key === "timeoutMs" || key === "askAbove") ? "command" : "classifier");
  const out = ["endpoint", "timeoutMs", "askAbove", "startCommand"].filter((key) => Object.hasOwn(raw, key)).map((key) => `${key} is now ${owner(key)}.${key}`);
  if (typeof raw.withoutUi === "string") out.push("withoutUi is now withoutUi.onAsk");
  if (Object.hasOwn(classifier, "llm")) out.push('classifier.llm is now llm, picked with "decider": ["llm"], and its keys changed');
  if (Object.hasOwn(classifier, "command")) out.push('classifier.command is now command.argv, picked with "decider": ["command"]');
  return out;
}

// Top-level keys with the same meaning in 0.2 and 0.3.
const UNCHANGED = ["enabled", "log", "rules", "allowedPaths", "guardedPaths"];
const compiles = (part: Partial<Config>) => {
  try {
    compileRules(part.rules ?? {});
    return true;
  } catch {
    return false;
  }
};

// A config with any error is ignored as a whole, so a typo cannot half-apply.
export function loadConfig(file = CONFIG_FILE): { config: Config; error?: string } {
  if (!fs.existsSync(file)) return { config: DEFAULTS };
  const ignored = (why: string) => ({ config: DEFAULTS, error: `${file} ignored, using defaults: ${why}` });
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return ignored((e as Error).message);
  }
  const old = isObject(raw) ? moved(raw) : [];
  if (isObject(raw) && old.length) {
    // The keys 0.3 did not change still apply, so your own deny rules keep blocking.
    const same = Object.fromEntries(Object.entries(raw).filter(([key]) => UNCHANGED.includes(key)));
    const usable = !problem(same, SCHEMA) && compiles(same as Partial<Config>);
    const kept = usable ? Object.keys(same) : [];
    const base = usable ? (merge(DEFAULTS as unknown as Record<string, unknown>, same, SCHEMA) as unknown as Config) : DEFAULTS;
    // In 0.2 a config that did not turn on the chat decider used a classifier. The default chat
    // decider would send its commands to a model it never picked, so those calls ask instead.
    const llm = isObject(raw.classifier) && isObject(raw.classifier.llm) && raw.classifier.llm.enabled === true;
    return {
      config: llm ? base : { ...base, decider: [] },
      error:
        `${file} has the 0.2 shape, so ${kept.length ? `only its ${kept.join(", ").replace(/, ([^,]+)$/, " and $1")} ${kept.length > 1 ? "are" : "is"} used` : "it is ignored"} and the rest is default` +
        `${llm ? "" : ", with no decider: what one would judge asks you"}. In 0.3 ${old.join("; ")}. Every key is in ${EXAMPLE_FILE}.`,
    };
  }
  const found = problem(raw, SCHEMA);
  if (found) return ignored(found);
  const config = merge(DEFAULTS as unknown as Record<string, unknown>, raw as Record<string, unknown>, SCHEMA) as unknown as Config;
  const given = raw as Partial<Record<keyof Config, unknown>>;
  config.decider = (given.decider as Decider[] | undefined) ?? [config.command.argv.length ? "command" : given.classifier ? "classifier" : "llm"];
  const { decider } = config;
  if (decider.includes("llm") && decider.at(-1) !== "llm") return ignored('"llm" must be the last entry in "decider"');
  if (decider.includes("command") && !config.command.argv.length) return ignored('"decider" has "command" and command.argv is empty');
  for (const stage of ["classifier", "command"] as const) {
    if (config[stage].allowBelow > config[stage].askAbove) return ignored(`${stage}.allowBelow is above ${stage}.askAbove`);
  }
  try {
    compileRules({ ...config.rules, allow: [...config.rules.allow, ...config.withoutUi.rules.allow], deny: [...config.rules.deny, ...config.withoutUi.rules.deny] });
  } catch (e) {
    return ignored((e as Error).message);
  }
  return { config };
}


// Pi's registry calls a yes/no question "bool" and requires both answers to be described.
export function buildQuestions(config: Config, viaPi = Boolean(config.classifier.provider)) {
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

// The classifier to use when a caller names none: the first one in `decider`.
const firstScorer = (config: Config): Scorer => (config.decider.find((d) => d !== "llm") as Scorer | undefined) ?? "classifier";

// The first question answered at or above its threshold, the main question first.
export function flagged(config: Config, answers: Record<string, number>, stage = firstScorer(config)): string | undefined {
  const viaProcess = stage === "command";
  const askAbove = config[stage].askAbove;
  if (answers.risky >= askAbove) return `model risk ${answers.risky.toFixed(2)} (asks at ${askAbove} and above)`;
  if (viaProcess) return undefined;
  for (const [id, q] of Object.entries(config.classifier.extraQuestions)) {
    const threshold = (typeof q === "string" ? undefined : q.askAbove) ?? askAbove;
    if (answers[id] >= threshold) return `model says yes to "${id}": ${answers[id].toFixed(2)} (asks at ${threshold} and above)`;
  }
  return undefined;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)} ... (${text.length} chars)` : text);

export type Classified = { answers: Record<string, number>; ms: number; tokens?: number } | { error: string; ms: number };

// The part of Pi's model registry this uses: `ctx.modelRegistry` in a session, or one built
// from Pi's SDK in bench/run.mjs.
export interface Registry {
  findOfType(type: "classifier", provider: string, id: string): unknown;
  getProvider?(provider: string): { baseUrl?: string } | undefined;
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
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
    return (await fetch(`${config.classifier.endpoint}/health`, { signal: AbortSignal.timeout(timeoutMs) })).ok;
  } catch {
    return false;
  }
}

let lastStart = 0;
// Runs startCommand and waits until the endpoint answers. At most one attempt per 30 s.
async function startServer(config: Config, waitMs: number): Promise<boolean> {
  const { startCommand } = config.classifier;
  if (!startCommand.length || Date.now() - lastStart < 30_000) return false;
  lastStart = Date.now();
  spawn(startCommand[0], startCommand.slice(1), { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
  for (const deadline = Date.now() + waitMs; Date.now() < deadline; ) {
    if (await health(config, 300)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// ---- classifier process ----

// `command.argv`: the process stays up between calls and gets one command at a time.
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
    const program = classifierName(config, "command");
    const { argv, timeoutMs } = config.command;
    if (classifierProcess?.key !== argv.join("\0")) stopClassifierProcess();
    const proc = (classifierProcess ??= startClassifierProcess(argv));
    proc.buffer = "";
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    const line = await new Promise<string | undefined | "timeout" | "cancelled">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
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
      return { error: line === "timeout" ? `no answer in ${timeoutMs} ms` : "the call was cancelled", ms: ms() };
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

// ---- llm decider ----

// The part of Pi's model registry the chat decider uses: `ctx.modelRegistry` in a session, or
// one built from Pi's SDK in a bench script.
export interface ChatRegistry {
  find(provider: string, modelId: string): unknown;
  streamSimple(
    model: unknown,
    context: { systemPrompt?: string; messages: { role: string; content: string }[] },
    options?: Record<string, unknown>,
  ): {
    result(): Promise<{
      content?: { type: string; text?: string }[];
      stopReason?: string;
      errorMessage?: string;
      usage?: { input?: number; cacheRead?: number; output?: number };
    }>;
  };
}

export type LlmDecision =
  | { block: false; why: string; stage: string; ms: number; tokens?: number }
  | { block: true; category?: string; reason: string; stage: string; ms: number; tokens?: number }
  // `unparsed`: the model answered, but not with a verdict. `lasting`: asking again fails the same
  // way (no such model, or the call does not fit its window).
  | { error: string; unparsed?: boolean; lasting?: boolean; ms: number; tokens?: number };

export const llmName = (llm: LlmConfig, sessionModelId?: string) =>
  llm.name || (llm.provider || llm.model ? [llm.provider, llm.model].filter(Boolean).join("/") : sessionModelId || "session model");

// A system prompt that never changes is what makes a 25k-token prompt cheap: every later call is
// a prefix cache hit and only pays for the transcript. So it is built once per process.
let promptCache: { key: string; prompt: string } | undefined;
export function systemPrompt(config: Config): string {
  const { prompt, transcript } = config.llm;
  const { includeAssistantText, includeToolResults } = transcript;
  const key = JSON.stringify([prompt, includeAssistantText, includeToolResults]);
  if (!promptCache || promptCache.key !== key) promptCache = { key, prompt: buildSystemPrompt(mergeRules(DEFAULT_RULES, prompt), { includeAssistantText, includeToolResults }) };
  return promptCache.prompt;
}

const CHARS_PER_TOKEN = 4;

interface Resolved {
  // The catalog model with the configured overrides applied.
  model: Record<string, unknown>;
  llm: LlmConfig;
  error?: string;
}

function resolveModel(registry: ChatRegistry, config: Config, sessionModel?: Record<string, unknown>): Resolved {
  const llm = config.llm;
  // Both empty: the session's own model. A model name without a provider is looked up in the
  // provider the session is using. A configured model Pi does not have is an error rather than a
  // quiet switch to the session model, which may be a hosted one.
  const base = !llm.provider && !llm.model ? sessionModel : registry.find(llm.provider || String(sessionModel?.provider ?? ""), llm.model);
  if (!base) {
    const wanted = llm.provider ? `${llm.provider}/${llm.model}` : llm.model || "the session model";
    return { model: {}, llm, error: `Pi has no chat model ${wanted}` };
  }
  const b = base as Record<string, unknown>;
  const model = {
    ...b,
    contextWindow: llm.contextWindow || Number(b.contextWindow) || 8192,
    maxTokens: llm.maxTokens || Number(b.maxTokens) || 1024,
    reasoning: llm.thinkingLevel !== "off" && Boolean(b.reasoning),
  };
  return { model, llm };
}

const thinks = ({ model }: Resolved) => Boolean(model.reasoning);

async function askOnce(
  registry: ChatRegistry,
  resolved: Resolved,
  system: string,
  message: string,
  opts: { maxTokens: number; thinking: boolean; signal?: AbortSignal },
): Promise<{ text?: string; cut?: boolean; error?: string; tokens?: number }> {
  const options: Record<string, unknown> = { maxTokens: opts.maxTokens, temperature: 0 };
  if (opts.thinking && thinks(resolved)) options.reasoning = resolved.llm.thinkingLevel;
  const timeout = AbortSignal.timeout(resolved.llm.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let stream: ReturnType<ChatRegistry["streamSimple"]>;
  try {
    stream = registry.streamSimple(resolved.model, { systemPrompt: system, messages: [{ role: "user", content: message }] }, { ...options, signal });
  } catch (e) {
    // A model without credentials throws here rather than returning an error message.
    return { error: (e as Error).message };
  }
  let answer;
  try {
    answer = await stream.result();
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (!answer) return { error: "the model returned nothing" };
  const text = (answer.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
    .trim();
  if (timeout.aborted && !text) return { error: `no answer in ${resolved.llm.timeoutMs} ms` };
  // Pi's simple API has no stop sequences, so a stage can run out of budget before the model
  // stops (stopReason "length"). The caller decides what a cut-off answer is worth.
  const cut = answer.stopReason === "length";
  if (answer.stopReason && answer.stopReason !== "stop" && !cut) return { error: answer.errorMessage ?? `${answer.stopReason} from the model` };
  const u = answer.usage;
  return { text, cut, tokens: u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.output ?? 0) : undefined };
}

// Claude Code's pipeline for one action: the transcript plus the action go in one user message,
// stage 1 filters, stage 2 reasons about what stage 1 flagged.
export async function decideWithLlm(
  config: Config,
  items: TranscriptItem[],
  signal?: AbortSignal,
  registry?: ChatRegistry,
  sessionModel?: Record<string, unknown>,
): Promise<LlmDecision> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const llm = config.llm;
  if (!registry) return { error: "no model registry", lasting: true, ms: ms() };
  const resolved = resolveModel(registry, config, sessionModel);
  if (resolved.error) return { error: resolved.error, lasting: true, ms: ms() };
  const system = systemPrompt(config);

  // Fit the request to the window: shrink the transcript, and only give up when even a short one
  // does not fit. A model that is cut off mid-prompt would answer about the wrong action.
  const window = Number(resolved.model.contextWindow);
  const budget = Math.max(0, window - llm.maxTokens - 512) * CHARS_PER_TOKEN - system.length;
  if (budget < 2000) return { error: `the rule prompt is ${system.length} chars and the model window is ${window} tokens: too small to classify`, lasting: true, ms: ms() };
  // The action goes in whole or not at all; the lines before it get the room that is left.
  const actionChars = buildTranscript(items.slice(-1), llm.transcript).length;
  if (actionChars > budget) return { error: `the action is ${actionChars} chars and the model window has room for ${budget}`, lasting: true, ms: ms() };
  const transcript = buildTranscript(items, { ...llm.transcript, maxChars: Math.min(llm.transcript.maxChars, budget - actionChars) });
  const send = (instruction: string, opts: { maxTokens: number; thinking: boolean }) =>
    askOnce(registry, resolved, system, `${transcript}\n\n${instruction}`, { ...opts, signal });

  let stage = llm.twoStage ? "fast" : "reasoning";
  let tokens = 0;
  if (llm.twoStage) {
    const first = await send(STAGE1_INSTRUCTION, { maxTokens: llm.stage1MaxTokens, thinking: false });
    if (first.error) return { error: `stage 1: ${first.error}`, ms: ms() };
    tokens += first.tokens ?? 0;
    // Stage 1 is tuned to over-flag, so anything it does not clearly pass escalates: an answer
    // that ran out of budget, or one that does not open with its verdict.
    const pass = first.cut ? undefined : parseVerdict(first.text ?? "", { leading: true });
    if (pass && !pass.block) return { block: false, why: "allowed by stage 1", stage, ms: ms(), tokens };
    stage = "reasoning";
  }
  const second = await send(stage2Instruction(thinks(resolved)), { maxTokens: llm.maxTokens, thinking: true });
  if (second.error) return { error: `${stage}: ${second.error}`, ms: ms() };
  tokens += second.tokens ?? 0;
  // A reasoning answer that ran out of budget may hold only tags it quoted from the action.
  if (second.cut) return { error: `the reasoning ran past its ${llm.maxTokens}-token budget`, unparsed: true, ms: ms(), tokens };
  const v = parseVerdict(second.text ?? "");
  if (!v) return { error: "the model gave no verdict", unparsed: true, ms: ms(), tokens };
  return v.block
    ? { block: true, category: v.category, reason: v.reason ?? "no reason given", stage, ms: ms(), tokens }
    : { block: false, why: "allowed after reasoning", stage, ms: ms(), tokens };
}

// Claude Code sees user messages and tool calls, and nothing else: no assistant prose, no tool
// results. That is reasoning-blind by design, which keeps a talked-into classifier out of reach
// and keeps hostile tool output out of the decision.
export function transcriptItems(
  entries: { message?: Record<string, unknown> }[],
  llm: LlmConfig,
  pending?: { tool: string; input: unknown; id?: string; files?: Record<string, string> },
  // Calls this guard held back, by tool call id. Pi records a block as a plain error result.
  decided?: ReadonlyMap<string, Outcome>,
): TranscriptItem[] {
  const t = llm.transcript;
  const items: TranscriptItem[] = [];
  let found = false;
  const failed = new Map<string, boolean>();
  for (const { message: m } of entries) if (m?.role === "toolResult" && typeof m.toolCallId === "string") failed.set(m.toolCallId, m.isError === true);
  const outcomeOf = (id: unknown): Outcome | undefined => {
    if (typeof id !== "string") return undefined;
    return decided?.get(id) ?? (failed.has(id) ? (failed.get(id) ? "error" : "ok") : undefined);
  };
  for (const entry of entries) {
    const m = entry.message;
    if (!m) continue;
    const content = m.content;
    if (m.role === "user") {
      const text = ownWords(
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.filter((c: Record<string, unknown>) => c.type === "text").map((c: Record<string, unknown>) => c.text as string).join("\n")
            : "",
      );
      if (text.trim()) items.push({ kind: "user", text });
    } else if (m.role === "assistant" && Array.isArray(content)) {
      for (const block of content as Record<string, unknown>[]) {
        // Pi stores the assistant message before its tool calls run: the call under review and
        // the ones after it in the same message have not happened yet.
        if (pending?.id && block.type === "toolCall" && block.id === pending.id) {
          found = true;
          break;
        }
        if (block.type === "toolCall") items.push({ kind: "tool", tool: String(block.name), input: block.arguments, outcome: outcomeOf(block.id) });
        else if (block.type === "text" && t.includeAssistantText && typeof block.text === "string") items.push({ kind: "assistant", text: block.text });
      }
    } else if (m.role === "toolResult" && t.includeToolResults) {
      const body = Array.isArray(content) ? content.map((c: Record<string, unknown>) => (typeof c.text === "string" ? c.text : "")).join("\n") : String(content ?? "");
      items.push({ kind: "result", tool: String(m.toolName ?? ""), text: body });
    }
  }
  if (!pending) return items;
  // Without a call id to match, a trailing copy of the call under review is dropped instead.
  if (!found)
    while (items.length && items.at(-1)!.kind === "tool" && items.at(-1)!.tool === pending.tool && JSON.stringify(items.at(-1)!.input) === JSON.stringify(pending.input)) items.pop();
  items.push({ kind: "action", tool: pending.tool, input: pending.input, files: pending.files });
  return items;
}

// Pi puts an expanded skill, or the files of `pi @file`, in front of the user's own words. That
// is attached content, so it is cut out. Both cuts end at the last closing tag, so a skill body or
// a file cannot close its block early and pass what follows as the user's words.
function ownWords(text: string): string {
  const skill = /^<skill name="[^"]+" location="[^"]+">\n[\s\S]*\n<\/skill>(?:\n\n([\s\S]+))?$/.exec(text);
  if (skill) return skill[1] ?? "";
  const start = text.indexOf("<file name=");
  const end = text.lastIndexOf("</file>\n");
  return start < 0 || end < start ? text : text.slice(0, start) + text.slice(end + "</file>\n".length);
}

// What the files a classified call runs hold now, for the decider to judge with the call.
function fileContents(paths: string[]): Record<string, string> {
  return Object.fromEntries(
    paths.map((p) => {
      try {
        return [p, fs.readFileSync(p, "utf8")];
      } catch (e) {
        return [p, `(cannot be read: ${(e as Error).message})`];
      }
    }),
  );
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
export const classifierName = (config: Config, stage = firstScorer(config)) =>
  stage === "command"
    ? config.command.argv.filter((word) => !word.startsWith("-")).slice(0, 2).map((word) => path.basename(word)).join(" ")
    : config.classifier.provider
      ? `${config.classifier.provider}/${config.classifier.model}`
      : config.classifier.model;

// The answer of the classifier decider, or of the classifier process for "command".
export async function classify(config: Config, state: Record<string, string>, signal?: AbortSignal, registry?: Registry, stage = firstScorer(config)): Promise<Classified> {
  if (stage === "command") return askClassifierProcess(config, state, signal);
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const { endpoint, provider, model: expected, timeoutMs } = config.classifier;
  const timedOut = { error: `no answer in ${timeoutMs} ms`, ms: 0 };
  const model = provider ? registry?.findOfType("classifier", provider, expected) : undefined;

  if (provider && !model) {
    // A chat provider with a System One server behind its baseUrl, such as LANCET under
    // LlamaStash: Pi lists no classifier there, so the request goes to <baseUrl>/systemone with
    // the provider's own key.
    const base = registry?.getProvider?.(provider)?.baseUrl;
    if (!registry || !base) return { error: `Pi has no classifier model ${provider}/${expected}`, ms: ms() };
    const key = await registry.getApiKeyForProvider?.(provider);
    return systemOne(config, `${base.replace(/\/+$/, "")}/systemone`, key ? { Authorization: `Bearer ${key}` } : {}, state, signal, started);
  }
  if (provider) {
    const questions = buildQuestions(config);
    const ids = Object.keys(questions);
    const timeout = AbortSignal.timeout(timeoutMs);
    // classify() never rejects; a failure comes back as a stop reason.
    const result = await registry!.classify(model, { state, questions }, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (timeout.aborted) return { ...timedOut, ms: ms() };
    if (result.stopReason !== "stop") return { error: clip(result.errorMessage ?? `${provider}/${expected} gave no answer`, 200), ms: ms() };
    const answers = readAnswers(config, ids, result.answers);
    return answers ? { answers, ms: ms(), tokens: result.usage?.input } : { error: "invalid response from the model", ms: ms() };
  }
  return systemOne(config, `${endpoint}/v1/systemone`, {}, state, signal, started);
}

// One request to a System One endpoint. Only the local `endpoint` gets its server started.
async function systemOne(config: Config, url: string, headers: Record<string, string>, state: Record<string, string>, signal: AbortSignal | undefined, started: number): Promise<Classified> {
  const ms = () => Math.round(performance.now() - started);
  const questions = buildQuestions(config, false);
  const ids = Object.keys(questions);
  const { endpoint, model: expected, timeoutMs } = config.classifier;
  const local = url === `${endpoint}/v1/systemone`;
  for (let attempt = 0; ; attempt++) {
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ model: expected, state, questions }),
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
      if (err.name === "TimeoutError") return { error: `no answer in ${timeoutMs} ms`, ms: ms() };
      if (local && attempt === 0 && err.cause?.code === "ECONNREFUSED" && (await startServer(config, timeoutMs))) continue;
      return { error: `server not reachable at ${new URL(url).origin}`, ms: ms() };
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

// `overrides` is for test.mjs and bench/run.mjs; Pi calls this with one argument.
export default function (pi: ExtensionAPI, overrides: Partial<Config> = {}) {
  const loaded = loadConfig();
  const config = { ...loaded.config, ...overrides };
  const configError = loaded.error;
  // The user's rules, plus the patterns saved with Always allow during this session. Without a
  // UI the withoutUi rules are added.
  const allowPatterns = [...config.rules.allow];
  // Patterns allowed for this session in a prompt. They never replace a firm ask (rules.ts).
  const picked: string[] = [];
  let pickedRules = compileRules({}).allow;
  const compile = () => {
    const { allow, deny } = config.withoutUi.rules;
    return {
      ui: compileRules({ ...config.rules, allow: allowPatterns }),
      headless: compileRules({ ...config.rules, allow: [...allowPatterns, ...allow], deny: [...config.rules.deny, ...deny] }),
    };
  };
  let rules = compile();
  const allowedPaths = [...config.allowedPaths];
  const guarded = [...GUARDED, ...config.guardedPaths];
  let enabled = config.enabled;
  const counts = { rule: 0, model: 0, asked: 0, blocked: 0 };
  // Denials by the chat decider, the backstop Claude Code has for a pushed-or-compromised agent.
  const denials = { consecutive: 0, total: 0 };
  // Exact commands and paths the user allowed for the rest of the session.
  const sessionAllowed = new Set<string>();
  // Files the session wrote or downloaded, as far as the rules saw it.
  const files: SessionFiles = new Map();
  // Git checkouts per working directory, as they were when the session first used it. A worktree
  // added later counts only inside the folder that holds the main checkout, so `git worktree add`
  // cannot open an arbitrary folder.
  const repositories = new Map<string, string[]>();
  // Calls this guard held back, by tool call id, for the outcome lines the decider reads.
  const decided = new Map<string, Outcome>();
  // Tool calls of one message run in parallel; show one prompt at a time.
  let prompts: Promise<unknown> = Promise.resolve();

  pi.on("session_start", async (_event, ctx) => {
    if (configError && ctx.hasUI) ctx.ui.notify(`pi-automode-classifier: ${configError}`, "warning");
    // Warm the server in the background so the first classified call does not wait for it. The
    // chat decider takes its place, so then it is not needed.
    if (enabled && config.decider.includes("classifier") && !config.classifier.provider) void health(config, 300).then((up) => up || startServer(config, 10_000));
    // With the chat decider the fixed rule prompt is some 25k tokens, and a cold prefill costs
    // the first real call tens of seconds. One throwaway call fills the prefix cache instead.
    if (enabled && config.decider.includes("llm") && config.llm.warmCache) {
      const warm: TranscriptItem[] = [{ kind: "user", text: "warming the rule prompt" }, { kind: "action", tool: "bash", input: { command: "true" } }];
      void decideWithLlm(config, warm, undefined, ctx.modelRegistry as unknown as ChatRegistry, ctx.model as unknown as Record<string, unknown>).catch(() => undefined);
    }
  });
  pi.on("session_shutdown", async () => stopClassifierProcess());

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled) return undefined;
    const input = event.input as Record<string, unknown>;
    const now = checkouts(ctx.cwd);
    if (!repositories.has(ctx.cwd)) repositories.set(ctx.cwd, now);
    const roots = repositories.get(ctx.cwd)!;
    const parent = path.dirname(now[0] ?? "/");
    for (const dir of now) if (!roots.includes(dir) && !isRootLike(parent) && within(dir, parent)) roots.push(dir);
    const scope = makeScope(ctx.cwd, guarded, {
      rules: ctx.hasUI ? rules.ui : rules.headless,
      picked: pickedRules,
      piDirs: [AGENT_DIR],
      allowedPaths: [...allowedPaths, ...roots],
      files,
      project: (p) => inCheckout(p, roots),
      chatDecider: config.decider.includes("llm"),
    });
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
    const held = (outcome: Outcome) => {
      if (event.toolCallId) decided.set(event.toolCallId, outcome);
    };
    // A call allowed while it was not critical asks again once the same text is, for example a
    // script that a download has since replaced.
    const key = `${verdict.critical ? "critical" : ""}\0${event.toolName}\0${ctx.cwd}\0${subject}`;
    // The user allowed this exact call for the session, so no model gets to block it again.
    if (verdict.action === "classify" && sessionAllowed.has(key)) {
      finish("allow", "session");
      return undefined;
    }

    // The classifiers, in `decider` order. A score at or above askAbove asks you. When another
    // decider comes next, a score from allowBelow up, or no score, goes to that one; otherwise
    // the call runs. Two kinds of call skip the classifiers and go to the chat model: an ask from
    // the rules, and a call that runs files the session wrote. A classifier sees only the
    // command, so it cannot tell whether the user asked for it or what the file holds.
    let toLlm = false;
    if (verdict.action === "classify") {
      const chain = verdict.ruleAsk || verdict.files ? config.decider.filter((d) => d === "llm") : config.decider;
      const steps: Record<string, unknown>[] = [];
      for (const [i, stage] of chain.entries()) {
        if (stage === "llm") {
          toLlm = true;
          break;
        }
        const last = i === chain.length - 1;
        const result = await classify(config, { tool: event.toolName, cwd: ctx.cwd, command: subject }, ctx.signal, ctx.modelRegistry as unknown as Registry, stage);
        steps.push({ decider: stage, model: classifierName(config, stage), ...result });
        entry.steps = steps;
        const risk = "answers" in result ? flagged(config, result.answers, stage) : undefined;
        if (risk) {
          verdict = { ...verdict, action: "ask", reason: risk };
          break;
        }
        if (!last && ("error" in result || result.answers.risky >= config[stage].allowBelow)) continue;
        if ("error" in result) {
          verdict = { ...verdict, action: "ask", reason: `model gave no answer: ${result.error}` };
          break;
        }
        counts.model++;
        finish("allow", stage);
        return undefined;
      }
      if (!chain.length) verdict = { ...verdict, action: "ask" };
    }

    if (toLlm) {
      const llm = config.llm;
      const branch = (ctx.sessionManager?.getBranch?.() ?? []) as { message?: Record<string, unknown> }[];
      const actionFiles = verdict.files?.length ? fileContents(verdict.files) : undefined;
      const items = transcriptItems(branch, llm, { tool: event.toolName, input, id: event.toolCallId, files: actionFiles }, decided);
      const decision = await decideWithLlm(config, items, ctx.signal, ctx.modelRegistry as unknown as ChatRegistry, ctx.model as unknown as Record<string, unknown>);
      Object.assign(entry, { model: llmName(llm, ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined), llm: { stage: "stage" in decision ? decision.stage : undefined, tokens: "tokens" in decision ? decision.tokens : undefined } });

      if ("error" in decision) {
        entry.llmError = decision.error;
        // Claude Code's iron gate: with no answer the call is held back, not waved through. Without
        // a UI an ask would fall to `withoutUi`, and a non-answer is easier to cause than an allow.
        if (llm.onNoAnswer === "ask" && ctx.hasUI) {
          verdict = { ...verdict, action: "ask", reason: `the decider gave no answer (${decision.error})` };
        } else {
          counts.blocked++;
          held(decision.unparsed ? "automode-parsing-error" : "automode-unavailable");
          log(config, { ...entry, outcome: "block", by: "llm-unavailable" });
          const retry = decision.lasting
            ? "retrying the same action fails the same way, so tell the user"
            : "retrying the same action is appropriate if the user asked for it";
          return { block: true, reason: denyMessage(`auto mode classifier unavailable: ${decision.error}. This was not a policy decision; ${retry}.`) };
        }
      } else if (decision.block) {
        entry.llmCategory = decision.category;
        entry.llmReason = decision.reason;
        denials.total++;
        denials.consecutive++;
        // Deny-and-continue, with Claude Code's backstop: after a run of denials the human is
        // asked instead of the agent being left to push against the wall.
        const exhausted = denials.consecutive >= llm.maxConsecutiveDenials || denials.total >= llm.maxTotalDenials;
        // Without a UI an ask falls to `withoutUi`, which could run what the decider denied.
        if (!ctx.hasUI || (llm.onBlock === "block" && !exhausted)) {
          counts.blocked++;
          held("automode-blocked");
          log(config, { ...entry, outcome: "block", by: "llm" });
          if (ctx.hasUI) ctx.ui.notify(`Auto mode blocked ${event.toolName}: ${decision.category ?? decision.reason}`, "warning");
          return { block: true, reason: denyMessage(decision.reason) };
        }
        const why = exhausted ? `${decision.reason} (${denials.consecutive} denials in a row, ${denials.total} this session)` : decision.reason;
        verdict = { ...verdict, action: "ask", reason: why };
      } else {
        denials.consecutive = 0;
        counts.model++;
        finish("allow", "llm");
        return undefined;
      }
    }

    if (verdict.action === "allow") {
      counts.rule++;
      finish("allow", "rule");
      return undefined;
    }
    if (verdict.action === "deny") {
      counts.blocked++;
      held("blocked-by-permissions");
      finish("block", "rule");
      if (ctx.hasUI) ctx.ui.notify(`Blocked ${event.toolName}: ${verdict.reason}`, "warning");
      return { block: true, reason: `Blocked by pi-automode-classifier: ${verdict.reason}. Do not retry it or work around it. Tell the user it was blocked.` };
    }

    if (sessionAllowed.has(key)) {
      finish("allow", "session");
      return undefined;
    }
    if (!ctx.hasUI) {
      // Root, credentials, downloaded code and the guard's own files never run unasked.
      if (config.withoutUi.onAsk === "allow" && !verdict.critical && !verdict.locked) {
        finish("allow", "no-ui");
        return undefined;
      }
      counts.blocked++;
      held("blocked-by-permissions");
      finish("block", "no-ui");
      return { block: true, reason: `This needs the user's approval (${verdict.reason}) and there is no UI to ask. Do not work around it. Tell the user.` };
    }

    counts.asked++;
    // While the config file is ignored every prompt says so, since the defaults decide differently.
    const title = `Auto mode: allow ${event.toolName}?\n${verdict.reason}\n\n${clip(subject, 1200)}${configError ? `\n\n${configError}` : ""}`;
    // A change outside the working directory can be allowed for its whole folder, and a command
    // for its pattern, so the next one does not ask again. A folder and the pattern of a command
    // the rules do not know can also be saved to the config file.
    const dir = verdict.dir?.replace(HOME, "~");
    const covers = dir ? `changes in ${dir}` : verdict.pattern ? `"${verdict.pattern}"` : undefined;
    const forSession = covers ? `Allow ${covers} for this session` : "Allow for this session";
    const always = covers && !(verdict.pattern && verdict.fromAsk) ? `Always allow ${covers}` : undefined;
    const answer = prompts.then(() => ctx.ui.select(title, ["Allow once", forSession, ...(always ? [always] : []), "Block"], { signal: ctx.signal }));
    prompts = answer.catch(() => undefined);
    const choice = await answer;
    const wider = choice === forSession || (always !== undefined && choice === always);
    if (wider) {
      if (verdict.dir) allowedPaths.push(verdict.dir);
      else if (verdict.pattern && choice === always) {
        allowPatterns.push(verdict.pattern);
        rules = compile();
      } else if (verdict.pattern) {
        picked.push(verdict.pattern);
        pickedRules = compileRules({ allow: picked }).allow;
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
    held("rejected-by-user");
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
      const { llm, classifier, command } = config;
      // What a classifier sends to the next decider.
      const passes = (stage: Scorer, i: number) => (i < config.decider.length - 1 ? `; ${config[stage].allowBelow} to ${config[stage].askAbove} goes to the next decider` : "");
      const describe = async (stage: Decider, i: number) => {
        if (stage === "llm") {
          const lists = mergeRules(DEFAULT_RULES, llm.prompt);
          return (
            `chat decider ${llmName(llm, ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined)} (${llm.twoStage ? "two-stage" : "one stage"}, thinking ${llm.thinkingLevel}), ` +
            `blocks by ${llm.onBlock}, ${llm.onNoAnswer === "block" ? "fails closed" : "asks when it cannot answer"}; ` +
            `${lists.hardDeny.length} hard block, ${lists.softDeny.length} soft block, ${lists.allow.length} allow, ${lists.environment.length} environment lines; ` +
            `transcript ${llm.transcript.maxEntries} entries / ${llm.transcript.maxChars} chars`
          );
        }
        if (stage === "command") return `classifier process ${command.argv.join(" ")}: ${classifierProcess ? "running" : "not running"} (asks at risk >= ${command.askAbove}${passes(stage, i)})`;
        const extra = Object.keys(classifier.extraQuestions);
        return (
          (classifier.provider
            ? `model ${classifier.provider}/${classifier.model} through Pi (commands are sent to ${classifier.provider})`
            : `model server ${classifier.endpoint}: ${(await health(config, 500)) ? "up" : "down"}`) +
          ` (asks at risk >= ${classifier.askAbove}${passes(stage, i)})${extra.length ? `, extra questions: ${extra.join(", ")}` : ""}`
        );
      };
      const where = config.decider.length
        ? (await Promise.all(config.decider.map(describe))).map((text, i) => (config.decider.length > 1 ? `${i + 1}. ${text}` : text)).join("\n")
        : "no decider: what one would judge asks you";
      const headless = config.withoutUi.rules;
      ctx.ui.notify(
        [
          `pi-automode-classifier: ${enabled ? "on" : "OFF for this session"}`,
          where,
          `your rules: ${rules.ui.deny.length} deny, ${rules.ui.ask.length} ask, ${rules.ui.classify.length} classify, ${rules.ui.allow.length} allow; ${allowedPaths.length} allowed paths`,
          `without a UI: asks ${config.withoutUi.onAsk === "allow" ? "run" : "are blocked"}${headless.allow.length || headless.deny.length ? `, plus ${headless.deny.length} deny and ${headless.allow.length} allow rules` : ""}`,
          `this session: ${counts.rule} allowed by rule, ${counts.model} by model, ${counts.asked} asked, ${counts.blocked} blocked${denials.total ? `; decider denials ${denials.total} (${denials.consecutive} in a row)` : ""}`,
          `config: ${CONFIG_FILE}${fs.existsSync(CONFIG_FILE) ? "" : " (not present, defaults in use)"}`,
          config.log ? `log: ${LOG_FILE}` : "log: off",
          ...(configError ? [configError] : []),
        ].join("\n"),
        enabled && !configError ? "info" : "warning",
      );
    },
  });
}
