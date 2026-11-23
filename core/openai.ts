// A chat endpoint that speaks the OpenAI `/chat/completions` shape, as the chat decider's
// transport. Pi has a model registry; a host without one (Hermes) passes this instead.
// llama.cpp and proxies in front of it serve this shape.

import type { ChatRegistry } from "./llm.ts";

export interface ChatEndpoint {
  // The OpenAI-compatible base, including its version path, for example
  // http://10.0.0.1:11435/v1.
  baseUrl: string;
  apiKey?: string;
}

// The effort names the endpoint takes. A level past "high" is "high" there.
const EFFORT: Record<string, string> = { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };

// A ChatRegistry over `endpoint`. Every model it finds can think, so `llm.thinkingLevel` decides:
// "off" asks for no thinking, which these endpoints read as an empty reasoning block.
export function chatEndpoint(endpoint: ChatEndpoint): ChatRegistry {
  const url = `${endpoint.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}) };
  return {
    find: (_provider, modelId) => ({ id: modelId, reasoning: true }),
    streamSimple(model, context, options = {}) {
      const thinking = options.reasoning ? (EFFORT[String(options.reasoning)] ?? "medium") : "none";
      const body = {
        model: String((model as { id?: string } | undefined)?.id ?? ""),
        messages: [...(context.systemPrompt ? [{ role: "system", content: context.systemPrompt }] : []), ...context.messages],
        temperature: options.temperature ?? 0,
        max_tokens: options.maxTokens,
        reasoning_effort: thinking,
      };
      return { result: () => post(url, headers, body, options.signal as AbortSignal | undefined) };
    },
  };
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    const data = (await res.json().catch(() => undefined)) as { choices?: { message?: { content?: unknown }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } } | undefined;
    if (!res.ok) return { stopReason: "error", errorMessage: String((data as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`) };
    const choice = data?.choices?.[0];
    if (!choice) return { stopReason: "error", errorMessage: "the chat endpoint gave no choice" };
    const text = typeof choice.message?.content === "string" ? choice.message.content : "";
    return {
      content: [{ type: "text", text }],
      // "length" means the answer ran past its token budget: the caller decides what it is worth.
      stopReason: choice.finish_reason === "length" ? "length" : "stop",
      usage: { input: data?.usage?.prompt_tokens, output: data?.usage?.completion_tokens },
    };
  } catch (e) {
    const err = e as Error;
    const stopped = err.name === "TimeoutError" || err.name === "AbortError";
    return { stopReason: "error", errorMessage: stopped ? "no answer before the timeout" : err.message };
  }
}
