// Stage 2: the scorers. A local `/v1/systemone` server, a classifier through the host's model
// registry, or a classifier that runs as a local process (LANCET). Each scores a call from 0 to 1.
// Nothing here imports a host: the registry a provider needs is passed in.

import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { buildTranscript, type Outcome, type TranscriptItem } from "../automode.ts";
import { buildQuestions, firstScorer, type Config, type Scorer } from "./config.ts";
import { transcriptItems } from "./llm.ts";
import { clip } from "./util.ts";

export type Classified = { answers: Record<string, number>; ms: number; tokens?: number } | { error: string; ms: number };

// The part of a host's model registry this uses: `ctx.modelRegistry` in a Pi session, or one built
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

export async function health(config: Config, timeoutMs: number): Promise<boolean> {
  try {
    return (await fetch(`${config.classifier.endpoint}/health`, { signal: AbortSignal.timeout(timeoutMs) })).ok;
  } catch {
    return false;
  }
}

let lastStart = 0;
// Runs startCommand and waits until the endpoint answers. At most one attempt per 30 s.
export async function startServer(config: Config, waitMs: number): Promise<boolean> {
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
// Every host process has its own, so it starts on the first command the rules leave to it and
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
export const classifierProcessRunning = () => Boolean(classifierProcess);

export function stopClassifierProcess() {
  clearTimeout(classifierIdle);
  classifierProcess?.child.kill();
  classifierProcess = undefined;
}

function startClassifierProcess(command: string[]): ClassifierProcess {
  const home = os.homedir();
  const [program, ...args] = command.map((word) => (word.startsWith("~/") ? home + word.slice(1) : word));
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
  // The process must not keep the host alive; a call that waits for an answer holds its own timer.
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

// What answers the questions, for the log and the status command.
export const classifierName = (config: Config, stage = firstScorer(config)) =>
  stage === "command"
    ? config.command.argv.filter((word) => !word.startsWith("-")).slice(0, 2).map((word) => path.basename(word)).join(" ")
    : config.classifier.provider
      ? `${config.classifier.provider}/${config.classifier.model}`
      : config.classifier.model;

// What a classifier is told about a call: the command, and with classifier.contextChars set also
// what the chat decider gets, shrunk to fit: the user's own message and the calls before this one.
// `contextIn` "command" folds that text into the command, which is the only way a server that
// reads just the command can see it; "state" sends it as its own key for a free-form server.
export function classifierContext(config: Config, base: { tool: string; cwd: string; command: string }, items: TranscriptItem[]): Record<string, string> {
  const state: Record<string, string> = { tool: base.tool, cwd: base.cwd, command: base.command };
  const chars = config.classifier.contextChars;
  if (!chars) return state;
  // buildTranscript wraps the session and ends with the pending call, which the classifier
  // already has as its command.
  const block = buildTranscript(items, { ...config.llm.transcript, maxEntries: 12, maxChars: chars });
  const context = block.split("\n").slice(1, -2).join("\n");
  if (!context) return state;
  if (config.classifier.contextIn === "command") state.command = `Session so far:\n${context}\n\nCommand to judge: ${base.command}`;
  else state.context = context;
  return state;
}

// The part of a host that gives this file a session: its working directory and its messages.
export interface SessionContext {
  cwd: string;
  sessionManager?: { getBranch?: () => { message?: Record<string, unknown> }[] };
}

// classifierContext for a session that reads its messages through a session manager (Pi).
export function classifierState(
  config: Config,
  ctx: SessionContext,
  tool: string,
  input: unknown,
  command: string,
  decided: ReadonlyMap<string, Outcome>,
): Record<string, string> {
  const branch = (ctx.sessionManager?.getBranch?.() ?? []) as { message?: Record<string, unknown> }[];
  const items = config.classifier.contextChars ? transcriptItems(branch, config.llm, { tool, input }, decided) : [];
  return classifierContext(config, { tool, cwd: ctx.cwd, command }, items);
}

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
    // LlamaStash: the host lists no classifier there, so the request goes to <baseUrl>/systemone
    // with the provider's own key.
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
