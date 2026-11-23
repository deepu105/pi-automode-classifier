// The config: its shape, its defaults, its validation, and the merge over the defaults.
//
// Nothing in here knows which host loaded it. The host passes the file to read and the path to
// name in the error text.

import fs from "node:fs";
import { compileRules, type Action } from "../rules.ts";
import { DEFAULT_LLM, type LlmConfig } from "../automode.ts";

// An extra yes/no question for the model. `yes` and `no` describe the two answers.
export interface Question {
  question: string;
  yes?: string;
  no?: string;
  // Defaults to classifier.askAbove.
  askAbove?: number;
}

export type Decider = "llm" | "classifier" | "command";
export type Scorer = Exclude<Decider, "llm">;

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
  // How much of the session a classifier is told about, in characters: the last user message and
  // the calls before this one, as the chat decider sees them. 0: the command alone.
  contextChars: number;
  // Where that goes. "state" sends it beside the command as its own `context` key, which a
  // free-form server such as Jev reads. "command" folds it into the command text, which is the
  // only way a server that reads just the command, like llama.cpp's or LANCET's, can see it.
  contextIn: "state" | "command";
}

export interface Config {
  // Starting state of a session. `/automode-classifier on|off` changes it for that session.
  enabled: boolean;
  // Append every decision to the host's log file.
  log: boolean;
  // Patterns over one simple command; see compilePattern in rules.ts. They replace the built-in
  // verdict, except a built-in deny and the ask for the guard's own files.
  rules: Record<Action, string[]>;
  // Extra directories where file changes are allowed, like the project directory. `~` is expanded.
  allowedPaths: string[];
  // More files or directories that count as the guard's own (changes to them always ask),
  // for example the server's unit file. `~` is expanded.
  guardedPaths: string[];
  // A confirm prompt nobody answers counts as a Block after this long, so an unattended session
  // does not stop there forever. 0 waits forever.
  promptTimeoutMs: number;
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
  // Endpoints for a host with no model registry (Hermes), by the name `classifier.provider` or
  // `llm.provider` gives: its base URL and the name of the variable that holds its key. A host
  // that resolves its own models (Pi) leaves this empty.
  providers: Record<string, { baseUrl: string; apiKeyEnv: string }>;
}

export const DEFAULTS: Config = {
  enabled: true,
  log: true,
  rules: { deny: [], ask: [], classify: [], allow: [] },
  allowedPaths: [],
  guardedPaths: [],
  promptTimeoutMs: 60_000,
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
    contextChars: 0,
    contextIn: "state",
  },
  llm: DEFAULT_LLM,
  // Picked with LANCET Nano 0.4.3; the README has the numbers.
  command: { argv: [], timeoutMs: 5000, askAbove: 0.2, allowBelow: 0.1 },
  providers: {},
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const isStrings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
export const isBool = (v: unknown) => typeof v === "boolean";
const isString = (v: unknown) => typeof v === "string";
const isThreshold = (v: unknown) => typeof v === "number" && v >= 0 && v <= 1;
const atLeast = (min: number) => (v: unknown) => typeof v === "number" && v >= min;
const oneOf = (...values: string[]) => (v: unknown) => values.includes(v as string);
// AbortSignal.timeout throws above this.
const isTimeout = (v: unknown) => typeof v === "number" && v > 0 && v <= 2_147_483_647;
// A prompt timeout of 0 means no timeout.
const isTimeoutOrOff = (v: unknown) => v === 0 || isTimeout(v);
const isProviders = (v: unknown) =>
  isObject(v) && Object.entries(v).every(([, p]) => isObject(p) && Object.keys(p).every((k) => ["baseUrl", "apiKeyEnv"].includes(k)) && isString(p.baseUrl) && URL.canParse(p.baseUrl) && isString(p.apiKeyEnv));
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
  promptTimeoutMs: isTimeoutOrOff,
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
    contextChars: atLeast(0),
    contextIn: oneOf("state", "command"),
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
  providers: isProviders,
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

// A config with any error is ignored as a whole, so a typo cannot half-apply. `exampleFile` is
// named in the error text as the file that lists every key.
export function loadConfig(file: string, exampleFile = ""): { config: Config; error?: string } {
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
        `${llm ? "" : ", with no decider: what one would judge asks you"}. In 0.3 ${old.join("; ")}. Every key is in ${exampleFile || "the example config"}.`,
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
export const firstScorer = (config: Config): Scorer => (config.decider.find((d) => d !== "llm") as Scorer | undefined) ?? "classifier";

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
