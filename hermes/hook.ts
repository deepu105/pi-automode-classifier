// The Hermes guard, run by Hermes's own node: one JSON request on stdin (see HookRequest in
// host.ts), one JSON answer on stdout. hermes/plugin.py starts this for each tool call, and turns
// a missing, late or unreadable answer into an approval too: nothing here may let a call through by
// accident.

import { createHash } from "node:crypto";
import fs from "node:fs";
import { loadConfig } from "../core/config.ts";
import { createGuard, emptyState, type Decision } from "../core/guard.ts";
import { loadState, saveState, sessionFile } from "../core/session.ts";
import { appendLog, clip } from "../core/util.ts";
import { chatFor, providerRegistry, statusText, transcriptFor, warmCache, type HookAnswer, type HookRequest } from "./host.ts";
import { subject } from "./tools.ts";

const write = (answer: HookAnswer) => process.stdout.write(JSON.stringify(answer) + "\n");

// The approval gate remembers one answer per key, so keep it short and stable for one exact call.
const ruleKey = (d: Extract<Decision, { action: "ask" }>) => `automode:${d.tool}:${createHash("sha256").update(`${d.tool}\0${d.subject}`).digest("hex").slice(0, 12)}`;

function decisionAnswer(d: Decision): HookAnswer {
  if (d.action === "block") return { action: "block", message: d.reason };
  if (d.action === "ask") return { action: "approve", message: d.reason, rule_key: ruleKey(d) };
  // "none" is a tool no rule covers, which is what Pi does with one too: it runs.
  return { action: "allow" };
}

async function run(request: HookRequest): Promise<HookAnswer> {
  const { config, error } = loadConfig(request.config, request.example);
  const providers = request.providers ?? {};
  // The session's state from the calls before this one: what it wrote and downloaded, its counts,
  // its denials. Without a session id each call stands on its own, as it did before.
  const store = request.sessions && request.session ? sessionFile(request.sessions, request.session) : undefined;
  const base = store ? loadState(store) : emptyState();
  const guard = createGuard(
    config,
    {
      product: "Hermes",
      guarded: request.guarded ?? [],
      ownDirs: request.ownDirs ?? [],
      log: (entry) => appendLog(request.log, config.log, entry),
      subject,
    },
    base,
  );
  guard.notice = error;
  if (typeof request.enabled === "boolean") guard.setEnabled(request.enabled);
  if (request.mode === "status") return { action: "status", text: await statusText(config, guard, request) };
  // The warming call: one throwaway answer, so the first real decision finds a warm prefix cache.
  // Nothing is decided and nothing is saved, so it is not a decision at all.
  if (request.mode === "warm") {
    await warmCache(config, providers);
    return { action: "allow" };
  }
  const decision = await guard.evaluate({
    tool: request.tool ?? "",
    input: (request.input ?? {}) as Record<string, unknown>,
    cwd: request.cwd || process.cwd(),
    toolCallId: request.toolCallId,
    session: {
      hasUI: Boolean(request.hasUI),
      chat: chatFor(config, providers),
      registry: providerRegistry(providers),
      transcript: transcriptFor(request.history ?? [], config),
    },
  });
  if (store) saveState(store, base, guard.state());
  // A prompt is the host's job here, so this is as far as the decision is logged: what the person
  // answered is not something a pre_tool_call hook gets back.
  if (decision.action === "ask") {
    appendLog(request.log, config.log, { tool: decision.tool, cwd: request.cwd, subject: clip(decision.subject, 4000), rule: "ask", reason: decision.reason, outcome: "ask", by: "ask" });
  }
  return decisionAnswer(decision);
}

let request: HookRequest;
try {
  request = JSON.parse(fs.readFileSync(0, "utf8")) as HookRequest;
} catch (e) {
  write({ action: "approve", message: `the auto mode guard could not read its input (${(e as Error).message}); approve only if you know this call is safe` });
  process.exit(0);
}
try {
  write(await run(request));
} catch (e) {
  write({ action: "approve", message: `the auto mode guard failed (${(e as Error).message}); approve only if you know this call is safe` });
}
