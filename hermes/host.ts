// The Hermes host's pieces of the pipeline: the session messages, the endpoints, and the status
// text for the slash command. hermes/hook.ts puts these into core/guard.ts.

import fs from "node:fs";
import { health } from "../core/classifier.ts";
import type { Config } from "../core/config.ts";
import type { Guard } from "../core/guard.ts";
import { transcriptItems, type ChatRegistry, type Registry } from "../core/llm.ts";
import { chatEndpoint, type ChatEndpoint } from "../core/openai.ts";
import { noUiText, promptClause, scoreBands, someRules, statusRow } from "../core/status.ts";

// What one call carries from Hermes to this file. hermes/plugin.py builds it.
export interface HookRequest {
  // "decide" (default) asks for one call; "status" asks for the status text.
  mode?: "decide" | "status";
  // The config file to read, and the file to name in a config error.
  config: string;
  example?: string;
  // Where to append the decisions, and the host's own files (see core/guard.ts).
  log: string;
  guarded: string[];
  ownDirs: string[];
  // True when a person could answer an approval for this session.
  hasUI: boolean;
  tool?: string;
  input?: Record<string, unknown>;
  cwd?: string;
  toolCallId?: string;
  // The session so far, in the OpenAI message form Hermes gives its hooks.
  history?: unknown[];
  // Endpoints by the name the config's providers give, with the key resolved from the profile.
  providers?: Record<string, ChatEndpoint>;
  // Set when this session chose `on` or `off` with the slash command: it beats the config's enabled.
  enabled?: boolean;
}

// The answer this file writes for Hermes: `approve` is the approval gate, `block` is a refusal.
export type HookAnswer = { action: "allow" } | { action: "approve"; message: string; rule_key?: string } | { action: "block"; message: string } | { action: "status"; text: string };

const HOME = process.env.HOME ?? "";
const home = (text: string) => text.replaceAll(HOME, "~");

// Hermes gives its hooks the messages in OpenAI form: an assistant message carries its tool calls,
// and each result comes back as its own `tool` message. transcriptItems reads Pi's shape, so turn
// the two into each other here and share the one transcript builder.
export function historyEntries(history: unknown[]): { message: Record<string, unknown> }[] {
  const out: { message: Record<string, unknown> }[] = [];
  for (const item of history ?? []) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, any>;
    if (m.role === "assistant") {
      const content: Record<string, unknown>[] = [];
      if (typeof m.content === "string" && m.content) content.push({ type: "text", text: m.content });
      for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const raw = call?.function?.arguments;
        let args: unknown = raw;
        if (typeof raw === "string") {
          try {
            args = JSON.parse(raw);
          } catch {
            // An argument string that is not JSON: keep it as the text of the call.
          }
        }
        content.push({ type: "toolCall", id: call?.id, name: String(call?.function?.name ?? ""), arguments: args });
      }
      if (content.length) out.push({ message: { role: "assistant", content } });
    } else if (m.role === "tool") {
      out.push({
        message: {
          role: "toolResult",
          toolCallId: m.tool_call_id,
          toolName: String(m.name ?? ""),
          content: [{ type: "text", text: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") }],
        },
      });
    } else if (m.role === "user") {
      out.push({ message: { role: "user", content: typeof m.content === "string" ? m.content : "" } });
    }
  }
  return out;
}

// The registry shape core/classifier.ts asks a host for, over the endpoints of the request. A
// provider name is looked up here instead of in a model registry.
export function providerRegistry(providers: Record<string, ChatEndpoint>): Registry {
  return {
    // A named endpoint is the classifier: there is no separate classifier model to look up.
    findOfType: () => undefined,
    getProvider: (name) => (providers[name] ? { baseUrl: providers[name].baseUrl } : undefined),
    getApiKeyForProvider: async (name) => providers[name]?.apiKey,
  };
}

// The chat decider's transport: the endpoint `llm.provider` names. Undefined when the config names
// none, which leaves the chat decider with no answer (and the call goes to the approval gate).
export function chatFor(config: Config, providers: Record<string, ChatEndpoint>): ChatRegistry | undefined {
  const named = config.llm.provider || config.llm.name;
  const endpoint = named ? providers[named] : undefined;
  return endpoint ? chatEndpoint(endpoint) : undefined;
}

// The status rows, in the same shape as Pi's `/automode-classifier status`. Two rows Pi has are
// left out: the session counts (a fresh process knows nothing about the session) and the classifier
// process check (a Hermes endpoint is not a process this plugin starts).
export async function statusText(config: Config, guard: Guard, request: HookRequest): Promise<string> {
  const status = guard.status();
  const { deny, ask, classify, allow } = status.rules;
  const yours = someRules([[deny, "deny"], [ask, "ask"], [classify, "classify"], [allow, "allow"], [status.allowedPaths.length, "allowed paths"]]) || "none";
  // A name the config gives a provider: what it is called, and whether the host knows it.
  const named = (name: string, model: string) => `${name}/${model}${request.providers?.[name] ? ", via Hermes" : " (no provider of that name)"}`;
  const describe = async (stage: string, i: number) => {
    const label = `${i + 2}. ${stage === "llm" ? "LLM" : stage === "command" ? "Command" : "Classifier"}:`;
    const last = i === config.decider.length - 1;
    if (stage === "llm") {
      const notes = [config.llm.twoStage ? "two-stage" : "one stage", `thinking:${config.llm.thinkingLevel}`];
      if (config.llm.onBlock === "ask") notes.push("asks instead of blocking");
      if (config.llm.onNoAnswer === "ask") notes.push("asks when it has no answer");
      const name = config.llm.provider || config.llm.name;
      return statusRow(label, `${name ? named(name, config.llm.model) : "(no model named)"} (${notes.join(", ")})`);
    }
    if (stage === "command") return statusRow(label, `${config.command.argv.join(" ")} (${scoreBands(config.command, last)})`);
    const more = Object.keys(config.classifier.extraQuestions);
    const where = config.classifier.provider ? named(config.classifier.provider, config.classifier.model) : `${config.classifier.endpoint}, ${(await health(config, 500)) ? "up" : "down"}`;
    return statusRow(label, `${where} (${scoreBands(config.classifier, last)}${more.length ? `, extra: ${more.join(", ")}` : ""})`);
  };
  return [
    `Auto mode: ${status.enabled ? "on" : "OFF for this session   (turn on: /automode-classifier on)"}`,
    ...(guard.notice ? [`Config error: ${guard.notice}`] : []),
    statusRow("1. Rules:", `${yours} (no UI: ${noUiText(config)}, ${promptClause(config)})`),
    ...(config.decider.length ? await Promise.all(config.decider.map(describe)) : [statusRow("2. Decider:", "none, classify verdicts ask you")]),
    "",
    statusRow("Config:", `${home(request.config)}${fs.existsSync(request.config) ? "" : " (not present, defaults in use)"}`),
    statusRow("Log:", config.log ? home(request.log) : "off"),
  ].join("\n");
}

// The session text the deciders get: what Hermes passed, with the call under review last.
export function transcriptFor(history: unknown[], config: Config) {
  const entries = historyEntries(history);
  return (pending: Parameters<typeof transcriptItems>[2], decided: Parameters<typeof transcriptItems>[3]) => transcriptItems(entries, config.llm, pending, decided);
}
