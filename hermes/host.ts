// The Hermes host's pieces of the pipeline: the session messages, the endpoints, and the status
// text for the slash command. hermes/hook.ts puts these into core/guard.ts.

import fs from "node:fs";
import { health } from "../core/classifier.ts";
import type { Config } from "../core/config.ts";
import type { Guard } from "../core/guard.ts";
import { decideWithLlm, transcriptItems, warmTranscript, type ChatRegistry, type Registry } from "../core/llm.ts";
import { chatEndpoint, type ChatEndpoint } from "../core/openai.ts";
import { statusRows } from "../core/status.ts";

// What one call carries from Hermes to this file. hermes/plugin.py builds it.
export interface HookRequest {
  // "decide" (default) asks for one call; "status" asks for the status text; "warm" asks for one
  // throwaway chat call that fills the decider's prefix cache. It decides nothing.
  mode?: "decide" | "status" | "warm";
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
  // This session, and the folder its state file lives in (see core/session.ts). Leave them out and
  // every call starts with nothing: no file origins, no counts, no denial caps.
  session?: string;
  sessions?: string;
  // Folders of this profile the tools write in without naming them, by the name hermes/tools.ts
  // uses: "skills", "memories". A tool with no path to judge is left alone.
  paths?: Record<string, string>;
  // Endpoints by the name the config's providers give, with the key resolved from the profile.
  providers?: Record<string, ChatEndpoint>;
  // Set when this session chose `on` or `off` with the slash command: it beats the config's enabled.
  enabled?: boolean;
}

// The answer this file writes for Hermes: `approve` is the approval gate, `block` is a refusal.
export type HookAnswer = { action: "allow" } | { action: "approve"; message: string; rule_key?: string } | { action: "block"; message: string } | { action: "status"; text: string };

const HOME = process.env.HOME ?? "";
const home = (text: string) => text.replaceAll(HOME, "~");

// How a Hermes tool result ended. The message carries no error flag of its own: the tool's own
// dict says it, with `status: "error"` or an `error` key. Without this the decider would read every
// failed call, and every call a security hook stopped, as one that ran.
function toolFailed(body: unknown): boolean {
  let value = body;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.status === "error" || record.error !== undefined;
}

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
      const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      out.push({
        message: {
          role: "toolResult",
          toolCallId: m.tool_call_id,
          toolName: String(m.name ?? ""),
          isError: toolFailed(m.content),
          content: [{ type: "text", text: body }],
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

// The status rows, in the same shape as Pi's `/automode-classifier status`. One row Pi has is left
// out: the classifier process check (a Hermes endpoint is not a process this plugin starts).
export async function statusText(config: Config, guard: Guard, request: HookRequest): Promise<string> {
  // A name the config gives a provider: what it is called, and whether the host knows it.
  const named = (name: string, model: string) => `${name}/${model}${request.providers?.[name] ? ", via Hermes" : " (no provider of that name)"}`;
  const { classifier } = config;
  // The endpoint is only probed when a step runs on it, so a status that does not use the scorer
  // does not wait for one.
  const scorer = config.decider.includes("classifier")
    ? classifier.provider
      ? named(classifier.provider, classifier.model)
      : `${classifier.endpoint}, ${(await health(config, 500)) ? "up" : "down"}`
    : "";
  const name = config.llm.provider || config.llm.name;
  return statusRows(config, guard.status(), {
    notice: guard.notice ?? undefined,
    llm: name ? named(name, config.llm.model) : "(no model named)",
    command: config.command.argv.join(" "),
    classifier: scorer,
    config: `${home(request.config)}${fs.existsSync(request.config) ? "" : " (not present, defaults in use)"}`,
    log: config.log ? home(request.log) : "off",
  });
}

// One throwaway chat call, so the decider's fixed rule prompt sits in the endpoint's prefix cache
// before the first call that needs an answer. The answer is dropped; nothing here waits on it.
export async function warmCache(config: Config, providers: Record<string, ChatEndpoint>): Promise<void> {
  try {
    await decideWithLlm(config, warmTranscript("terminal"), undefined, chatFor(config, providers));
  } catch {
    // A warm call that fails costs nothing: the first real decision warms the cache itself.
  }
}
// The session text the deciders get: what Hermes passed, with the call under review last.
export function transcriptFor(history: unknown[], config: Config) {
  const entries = historyEntries(history);
  return (pending: Parameters<typeof transcriptItems>[2], decided: Parameters<typeof transcriptItems>[3]) => transcriptItems(entries, config.llm, pending, decided);
}
