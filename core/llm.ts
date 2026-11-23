// Stage 3: the chat decider. Claude Code's pipeline: the transcript plus the action go in one
// user message, stage 1 filters, stage 2 reasons about what stage 1 flagged.
//
// The host passes the model transport as a ChatRegistry: Pi hands over its model registry, Hermes
// an OpenAI-compatible endpoint (see core/openai.ts). Nothing here imports a host.

import { buildSystemPrompt, buildTranscript, parseVerdict, STAGE1_INSTRUCTION, stage2Instruction, DEFAULT_RULES, mergeRules, type LlmConfig, type Outcome, type TranscriptItem } from "../automode.ts";
import type { Config } from "./config.ts";

// The part of a host's model registry the chat decider uses: `ctx.modelRegistry` in a Pi session,
// or one built from Pi's SDK in a bench script.
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
  // provider the session is using. A configured model the host does not have is an error rather
  // than a quiet switch to the session model, which may be a hosted one.
  const base = !llm.provider && !llm.model ? sessionModel : registry.find(llm.provider || String(sessionModel?.provider ?? ""), llm.model);
  if (!base) {
    const wanted = llm.provider ? `${llm.provider}/${llm.model}` : llm.model || "the session model";
    return { model: {}, llm, error: `no chat model ${wanted} is set up` };
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
  // The simple chat API has no stop sequences, so a stage can run out of budget before the model
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
