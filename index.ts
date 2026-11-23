// Auto mode for Pi: decides per tool call whether it runs, needs a confirm prompt, or is blocked.
//
// This file is the Pi wrapper: it reads Pi's config file, feeds Pi's events to the shared pipeline
// (core/guard.ts), shows Pi's confirm prompt, and answers /automode-classifier. Hermes has its own
// wrapper under hermes/. The pipeline is:
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TranscriptItem } from "./automode.ts";
import { isStrings, loadConfig as loadCoreConfig } from "./core/config.ts";
import { classifierProcessRunning, health, startServer, stopClassifierProcess } from "./core/classifier.ts";
import { decideWithLlm, llmName, transcriptItems, type ChatRegistry } from "./core/llm.ts";
import { appendLog } from "./core/util.ts";
import { noUiText, promptClause, scoreBands, someRules, statusRow } from "./core/status.ts";
import { createGuard, type GuardSubject, type GuardSession } from "./core/guard.ts";

// The pipeline moved to core/ so a second host can use it. These names still come from this file,
// where test.mjs, bench/run.mjs and any other caller already imports them.
export { DEFAULTS, buildQuestions, flagged, type ClassifierConfig, type Config, type Decider, type Question } from "./core/config.ts";
export { classify, classifierName, classifierProcessPid, classifierState, stopClassifierProcess, type Classified, type Registry } from "./core/classifier.ts";
export { decideWithLlm, llmName, systemPrompt, transcriptItems, type ChatRegistry, type LlmDecision } from "./core/llm.ts";
export { checkouts, inCheckout } from "./core/guard.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(HOME, ".pi/agent");
// User config lives outside the package so a package update does not overwrite it.
export const CONFIG_FILE = path.join(AGENT_DIR, "extensions/pi-automode-classifier/config.json");
const EXAMPLE_FILE = path.join(HERE, "config.example.jsonc");
export const LOG_FILE = path.join(process.env.XDG_STATE_HOME ?? path.join(HOME, ".local/state"), "pi-automode-classifier/decisions.jsonl");

// The guard's own files and Pi's settings: changes to them always ask.
const GUARDED = [HERE, path.dirname(CONFIG_FILE), path.join(AGENT_DIR, "settings.json")];

// A config with any error is ignored as a whole, so a typo cannot half-apply.
export function loadConfig(file = CONFIG_FILE) {
  return loadCoreConfig(file, EXAMPLE_FILE);
}

// Appends `value` to a list in the config file. Returns an error text when the file cannot be
// read as a config or cannot be written.
function saveToConfig(list: "allowedPaths" | "allow", value: string): string | undefined {
  try {
    const raw: unknown = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) : {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("it must be a JSON object");
    const holder: Record<string, unknown> = list === "allow" ? ((raw as Record<string, unknown>).rules ??= {}) : (raw as Record<string, unknown>);
    if (typeof holder !== "object" || holder === null) throw new Error('"rules" is not an object');
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

// What the tool call is about, for the rules: a command, a file it changes, or a file it reads.
const subject = (tool: string, input: Record<string, unknown>): GuardSubject | undefined => {
  if (typeof input.command === "string") return { kind: "bash", label: tool, subject: input.command };
  if ((tool === "write" || tool === "edit") && typeof input.path === "string") return { kind: "write", label: tool, subject: input.path };
  if ((tool === "read" || tool === "grep") && typeof input.path === "string") return { kind: "read", label: tool, subject: input.path };
  return undefined;
};

// `overrides` is for test.mjs and bench/run.mjs; Pi calls this with one argument.
export default function (pi: ExtensionAPI, overrides: Partial<ReturnType<typeof loadConfig>["config"]> = {}) {
  const loaded = loadConfig();
  const config = { ...loaded.config, ...overrides };
  const configError = loaded.error;
  // One guard for the process: what the rules remember (allowed paths, written files, counts)
  // is shared, as it was when this logic sat in one handler.
  const guard = createGuard(config, {
    product: "Pi",
    guarded: GUARDED,
    ownDirs: [AGENT_DIR],
    log: (entry) => appendLog(LOG_FILE, config.log, entry),
    subject,
  });
  guard.notice = configError;

  // Everything of a call the pipeline needs that comes from Pi: the prompt, the transcript, and
  // the two model transports. Pi runs the calls of one message in parallel, so this is built per
  // call and never kept on the guard.
  const session = (ctx: ExtensionContext): GuardSession => {
    const branch = (ctx.sessionManager?.getBranch?.() ?? []) as { message?: Record<string, unknown> }[];
    const registry = ctx.modelRegistry as unknown;
    return {
      hasUI: ctx.hasUI,
      chat: registry as ChatRegistry | undefined,
      registry: registry as GuardSession["registry"],
      sessionModel: ctx.model as unknown as Record<string, unknown> | undefined,
      transcript: (pending, decided) => transcriptItems(branch, config.llm, pending, decided),
      notify: (message, level) => ctx.ui.notify(message, level),
      persist: ({ dir, pattern }) => {
        const error = dir ? saveToConfig("allowedPaths", dir) : saveToConfig("allow", pattern!);
        return error && `pi-automode-classifier: ${error}`;
      },
      // An unattended session would sit here until someone answers, so a prompt nobody answers in
      // promptTimeoutMs counts as a Block. Pi's own `timeout` draws the countdown and dismisses the
      // dialog; this timer is what tells a timeout from a dismiss, since both leave no answer.
      ask: async ({ title, choices, timeoutMs, signal }) => {
        if (!timeoutMs) return { choice: await ctx.ui.select(title, choices, { signal }) };
        const controller = new AbortController();
        signal?.addEventListener("abort", () => controller.abort(), { once: true });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
        return ctx.ui
          .select(title, choices, { signal: controller.signal, timeout: timeoutMs })
          .then((choice) => ({ choice, timedOut }))
          .finally(() => clearTimeout(timer));
      },
    };
  };

  pi.on("session_start", async (_event, ctx) => {
    if (configError && ctx.hasUI) ctx.ui.notify(`pi-automode-classifier: ${configError}`, "warning");
    // Warm the server in the background so the first classified call does not wait for it. The
    // chat decider takes its place, so then it is not needed.
    if (guard.status().enabled && config.decider.includes("classifier") && !config.classifier.provider) void health(config, 300).then((up) => up || startServer(config, 10_000));
    // With the chat decider the fixed rule prompt is some 25k tokens, and a cold prefill costs
    // the first real call tens of seconds. One throwaway call fills the prefix cache instead.
    if (guard.status().enabled && config.decider.includes("llm") && config.llm.warmCache) {
      const warm: TranscriptItem[] = [{ kind: "user", text: "warming the rule prompt" }, { kind: "action", tool: "bash", input: { command: "true" } }];
      void decideWithLlm(config, warm, undefined, ctx.modelRegistry as unknown as ChatRegistry, ctx.model as unknown as Record<string, unknown>).catch(() => undefined);
    }
  });
  pi.on("session_shutdown", async () => stopClassifierProcess());

  pi.on("tool_call", async (event, ctx) => {
    const decision = await guard.evaluate({
      tool: event.toolName,
      input: event.input as Record<string, unknown>,
      cwd: ctx.cwd,
      toolCallId: event.toolCallId,
      signal: ctx.signal,
      session: session(ctx),
    });
    if (decision.action === "block") return { block: true, reason: decision.reason };
    return undefined;
  });

  const statusText = async (ctx: ExtensionContext) => {
    const { llm, classifier, command } = config;
    const status = guard.status();
    const home = (text: string) => text.replaceAll(HOME, "~");
    const describe = async (stage: string, i: number) => {
      const label = `${i + 2}. ${stage === "llm" ? "LLM" : stage === "command" ? "Command" : "Classifier"}:`;
      const last = i === config.decider.length - 1;
      if (stage === "llm") {
        const notes = [llm.twoStage ? "two-stage" : "one stage", `thinking:${llm.thinkingLevel}`];
        if (llm.onBlock === "ask") notes.push("asks instead of blocking");
        if (llm.onNoAnswer === "ask") notes.push("asks when it has no answer");
        return statusRow(label, `${llmName(llm, ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined)}, via Pi (${notes.join(", ")})`);
      }
      if (stage === "command") return statusRow(label, `${home(command.argv.join(" "))}, ${classifierProcessRunning() ? "running" : "not running"} (${scoreBands(config[stage], last)})`);
      const more = Object.keys(classifier.extraQuestions);
      const where = classifier.provider ? `${classifier.provider}/${classifier.model}, via Pi` : `${classifier.endpoint}, ${(await health(config, 500)) ? "up" : "down"}`;
      return statusRow(label, `${where} (${scoreBands(config[stage], last)}${more.length ? `, extra: ${more.join(", ")}` : ""})`);
    };
    const { deny, ask, classify: classified, allow } = status.rules;
    const yours = someRules([[deny, "deny"], [ask, "ask"], [classified, "classify"], [allow, "allow"], [status.allowedPaths.length, "allowed paths"]]) || "none";
    const counts = status.counts;
    return [
      `Auto mode: ${status.enabled ? "on" : "OFF for this session   (turn on: /automode-classifier on)"}`,
      ...(configError ? [`Config error: ${home(configError)}`] : []),
      statusRow("1. Rules:", `${yours} (no UI: ${noUiText(config)}, ${promptClause(config)})`),
      ...(config.decider.length ? await Promise.all(config.decider.map(describe)) : [statusRow("2. Decider:", "none, classify verdicts ask you")]),
      "",
      statusRow("Session:", `${counts.rule} allowed by rule, ${counts.model} by model, ${counts.asked} asked, ${counts.blocked} blocked${status.denials.total ? `, ${status.denials.total} LLM denials (${status.denials.consecutive} in a row)` : ""}`),
      statusRow("Config:", `${home(CONFIG_FILE)}${fs.existsSync(CONFIG_FILE) ? "" : " (not present, defaults in use)"}`),
      statusRow("Log:", config.log ? home(LOG_FILE) : "off"),
    ].join("\n");
  };

  pi.registerCommand("automode-classifier", {
    description: "Auto mode guard: status | on | off",
    getArgumentCompletions: (prefix) => ["status", "on", "off"].filter((a) => a.startsWith(prefix)).map((a) => ({ value: a, label: a })),
    handler: async (args, ctx: ExtensionContext) => {
      const arg = args.trim();
      if (arg === "on" || arg === "off") guard.setEnabled(arg === "on");
      else if (arg && arg !== "status") return ctx.ui.notify("Usage: /automode-classifier status | on | off", "warning");
      ctx.ui.notify(await statusText(ctx), guard.status().enabled && !configError ? "info" : "warning");
    },
  });
}
