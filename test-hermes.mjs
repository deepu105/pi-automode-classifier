// Checks the Hermes wrapper's own parts: which tool call means what, the session text, the
// endpoints a config names, and the JSON answers hermes/hook.ts writes. No real model is needed:
// one small server stands in for a chat endpoint and a scorer. The commands under test are only
// named, never run. Needs a Node that runs TypeScript directly (22.18 or newer).
// Usage: node test-hermes.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const repo = import.meta.dirname;
const hook = path.join(repo, "hermes", "hook.ts");
const { subject } = await import("./hermes/tools.ts");
const { chatEndpoint } = await import("./core/openai.ts");
const { chatFor, historyEntries, providerRegistry, statusText } = await import("./hermes/host.ts");
const { loadConfig } = await import("./core/config.ts");
const { createGuard } = await import("./core/guard.ts");

let failures = 0;
const check = (label, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (!same) failures++;
  console.log(`${same ? "PASS" : "FAIL"}: ${label}${same ? "" : ` -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const ok = (label, passed, detail = "") => {
  if (!passed) failures++;
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}${passed ? "" : ` -> ${detail}`}`);
};

// The tool map
check("terminal is judged as a command", subject("terminal", { command: "ls" }), { kind: "bash", label: "terminal", subject: "ls" });
check("process_manage is judged as a command", subject("process_manage", { command: "make" }), { kind: "bash", label: "process_manage", subject: "make" });
check("execute_code is judged as code it runs", subject("execute_code", { code: "print(1)" }), { kind: "bash", label: "execute_code", subject: "print(1)" });
check("write_file replaces a file", subject("write_file", { path: "/tmp/x" }), { kind: "write", label: "write", subject: "/tmp/x" });
check("patch edits a file", subject("patch", { path: "/tmp/x" }), { kind: "write", label: "edit", subject: "/tmp/x" });
check("read_file is a read", subject("read_file", { path: "/tmp/x" }), { kind: "read", label: "read", subject: "/tmp/x" });
check("search_files is a read", subject("search_files", { path: "/tmp" }), { kind: "read", label: "search", subject: "/tmp" });
check("a tool no rule covers is left alone", subject("browser", { url: "http://x" }), undefined);
check("a missing argument is left alone", subject("terminal", {}), undefined);
check("an argument that is not text is left alone", subject("terminal", { command: 5 }), undefined);
check("no arguments at all is left alone", subject("write_file", undefined), undefined);

// The session text Hermes passes
const history = [
  { role: "system", content: "you are a helper" },
  { role: "user", content: "clean the build" },
  { role: "assistant", content: "I will look first", tool_calls: [{ id: "c1", function: { name: "terminal", arguments: '{"command":"ls"}' } }] },
  { role: "tool", tool_call_id: "c1", name: "terminal", content: "build\nsrc" },
  { role: "assistant", content: "", tool_calls: [{ id: "c2", function: { name: "terminal", arguments: "not json" } }] },
  { role: "assistant", content: "" },
];
const entries = historyEntries(history).map((e) => e.message);
check("the user turn comes through", entries[0], { role: "user", content: "clean the build" });
check("an assistant text and its call come through", entries[1], {
  role: "assistant",
  content: [{ type: "text", text: "I will look first" }, { type: "toolCall", id: "c1", name: "terminal", arguments: { command: "ls" } }],
});
check("the result of a call comes through", entries[2], { role: "toolResult", toolCallId: "c1", toolName: "terminal", content: [{ type: "text", text: "build\nsrc" }] });
check("arguments that are not JSON stay text", entries[3].content[0].arguments, "not json");
check("an assistant message with nothing in it is dropped", entries.length, 4);

// The endpoints a config names
const providers = { pc: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" } };
const registry = providerRegistry(providers);
check("a named endpoint is found by name", registry.getProvider("pc"), { baseUrl: "http://127.0.0.1:9/v1" });
check("a name the host does not have is not found", registry.getProvider("other"), undefined);
check("its key comes with it", await registry.getApiKeyForProvider?.("pc"), "k");
const configWith = (llm) => ({ ...loadConfig(path.join(repo, "config.example.jsonc")).config, llm: { ...loadConfig(path.join(repo, "config.example.jsonc")).config.llm, ...llm } });
ok("the chat decider uses the endpoint the config names", Boolean(chatFor(configWith({ provider: "pc", model: "m" }), providers)));
check("no name means no chat decider", chatFor(configWith({ provider: "", model: "" }), providers), undefined);
check("a name the host does not have means no chat decider", chatFor(configWith({ provider: "other", model: "m" }), providers), undefined);

// The chat endpoint's request and answer
const seen = [];
const reply = { answers: { risky: { noul: 0.9 } } };
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ url: req.url, auth: req.headers.authorization, body: body && JSON.parse(body) });
    if (req.url.endsWith("/systemone")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: "lancet", answers: reply.answers, usage: { input_tokens: 5 } }));
      return;
    }
    if (req.url.includes("broken")) return void res.writeHead(500).end(JSON.stringify({ error: { message: "no slot" } }));
    const long = req.url.includes("long");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "safe" }, finish_reason: long ? "length" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  });
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}/v1`;
const chat = chatEndpoint({ baseUrl: base, apiKey: "secret" });
const call = async (reasoning, url = base) => {
  seen.length = 0;
  const out = await chatEndpoint({ baseUrl: url, apiKey: "secret" }).streamSimple({ id: "m" }, { systemPrompt: "rules", messages: [{ role: "user", content: "hi" }] }, { maxTokens: 64, reasoning }).result();
  return { sent: seen[0], out };
};
const plain = await call(undefined);
check("it posts to the OpenAI chat path", plain.sent.url, "/v1/chat/completions");
check("it sends the key as a bearer token", plain.sent.auth, "Bearer secret");
check("it sends the model, the system rules and the transcript", [plain.sent.body.model, plain.sent.body.messages[0], plain.sent.body.messages[1]], ["m", { role: "system", content: "rules" }, { role: "user", content: "hi" }]);
check("no thinking level asks the endpoint not to think", plain.sent.body.reasoning_effort, "none");
check("a thinking level is passed through as effort", (await call("high")).sent.body.reasoning_effort, "high");
check("the token budget is passed through", (await call(undefined)).sent.body.max_tokens, 64);
check("the answer text is read back", plain.out.content, [{ type: "text", text: "safe" }]);
check("a finished answer is reported as stop", plain.out.stopReason, "stop");
check("an answer cut off by its budget is reported as length", (await call(undefined, `${base}/long`)).out.stopReason, "length");
check("the token counts are read back", plain.out.usage, { input: 10, output: 2 });
check("a server error is an error, not an empty answer", (await call(undefined, `${base}/broken`)).out.errorMessage, "no slot");
check("an endpoint that is not there is an error", String((await call(undefined, "http://127.0.0.1:9/v1")).out.stopReason), "error");

// A scorer that names a provider: the same request core/classifier.ts makes to Pi's provider.
const { classify, classifierContext } = await import("./core/classifier.ts");
const scored = configWith({ provider: "", model: "" });
scored.classifier = { ...scored.classifier, provider: "pc", model: "lancet", question: "risky?", risky: "r", safe: "s", levels: [], extraQuestions: {}, contextChars: 0, contextIn: "state" };
const state = classifierContext(scored, { tool: "terminal", cwd: "/tmp", command: "ls" }, []);

const outcome = await classify(scored, state, undefined, providerRegistry({ pc: { baseUrl: base, apiKey: "secret" } }), "classifier");
const posted = seen.at(-1);
check("the scorer posts to the endpoint's systemone path", posted.url, "/v1/systemone");
check("the scorer sends the key too", posted.auth, "Bearer secret");
check("the scorer sends the command and the question", [posted.body.state.command, posted.body.questions.risky.instructions], ["ls", "risky?"]);
check("the scorer's answer comes back", outcome.answers, { risky: 0.9 });
await new Promise((done) => server.close(done));

// hermes/hook.ts: one JSON request in, one JSON answer out
const home = os.homedir();
// Not under a temp directory: the rules treat those as scratch space.
const fixture = path.join(home, "pi-automode-classifier-hermes-test");
const workspace = path.join(fixture, "workspace");
const automode = path.join(fixture, "automode-classifier");
fs.rmSync(fixture, { recursive: true, force: true });
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(automode, { recursive: true });
const configFile = path.join(automode, "config.json");
const logFile = path.join(fixture, "decisions.jsonl");
const writeConfig = (object) => fs.writeFileSync(configFile, JSON.stringify(object));
const ask = (request) => {
  const proc = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", hook], { input: JSON.stringify(request), encoding: "utf8" });
  const line = proc.stdout.trim().split("\n").at(-1);
  try {
    return JSON.parse(line);
  } catch {
    return { action: `unreadable: ${line} ${proc.stderr.slice(0, 120)}` };
  }
};
const decide = (tool, input, extra = {}) => ask({ mode: "decide", config: configFile, example: path.join(repo, "config.example.jsonc"), log: logFile, guarded: [automode], ownDirs: [path.join(fixture, "plugins")], hasUI: true, tool, input, cwd: workspace, history: [{ role: "user", content: "do it" }], ...extra });
const decisions = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// The config key the wrapper needs
const providersConfig = loadConfig(configFile);
ok("a missing config file is not an error", !providersConfig.error, providersConfig.error);
writeConfig({ providers: { pc: { baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: "TEST_KEY" } } });
check("providers are read", loadConfig(configFile).config.providers, { pc: { baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: "TEST_KEY" } });
for (const [label, bad] of [
  ["a provider without a key name", { pc: { baseUrl: "http://x/v1" } }],
  ["a base that is not a URL", { pc: { baseUrl: "not a url", apiKeyEnv: "K" } }],
  ["a key that is not text", { pc: { baseUrl: "http://x/v1", apiKeyEnv: 7 } }],
  ["an unknown field", { pc: { baseUrl: "http://x/v1", apiKeyEnv: "K", extra: 1 } }],
]) {
  writeConfig({ providers: bad });
  ok(`providers rejects ${label}`, Boolean(loadConfig(configFile).error), loadConfig(configFile).error);
}
fs.rmSync(configFile, { force: true });

// A config with no model: what the rules leave open asks.
writeConfig({ decider: [] });
check("a plain command runs", decide("terminal", { command: "ls" }), { action: "allow" });
check("a tool no rule covers runs", decide("web_search", { query: "x" }), { action: "allow" });
check("a denied command is blocked with a reason", decide("terminal", { command: "rm -rf /" }).action, "block");
const guardFile = path.join(automode, "config.json");
const locked = decide("write_file", { path: guardFile, content: "x" });
ok("a change to the guard's own config asks, and names what to approve", locked.action === "approve" && String(locked.rule_key).startsWith("automode:write_file:"), JSON.stringify(locked));
const outward = decide("terminal", { command: "git push origin main" });
ok("what the rules leave to a person asks", outward.action === "approve", JSON.stringify(outward));
ok("an ask is written to the decision log", decisions().some((e) => e.outcome === "ask" && e.by === "ask" && e.subject === "git push origin main"), JSON.stringify(decisions().at(-1)));
check("with no way to ask, an ask is a block", decide("terminal", { command: "git push origin main" }, { hasUI: false }).action, "block");
check("off for this session lets the call through", decide("terminal", { command: "git push origin main" }, { enabled: false }), { action: "allow" });
check("on for this session decides as usual", decide("terminal", { command: "git push origin main" }, { enabled: true }).action, "approve");
check("a read of a credential file asks", decide("read_file", { path: path.join(workspace, ".env") }).action, "approve");
check("a path the rules do not reach runs", decide("read_file", { path: path.join(workspace, "notes.md") }), { action: "allow" });

// A model that cannot answer fails closed: the call goes to the approval gate.
writeConfig({ decider: ["classifier", "llm"], classifier: { provider: "gone", model: "m" }, llm: { provider: "gone", model: "m", contextWindow: 131072 }, providers: {} });
const unreachable = decide("terminal", { command: "git push origin main" }, { providers: {} });
ok("a model that is not set up does not let the call through", unreachable.action === "approve" || unreachable.action === "block", JSON.stringify(unreachable));

// The status command
writeConfig({ decider: ["classifier", "llm"], classifier: { provider: "pc", model: "lancet" }, llm: { provider: "pc", model: "flash", contextWindow: 131072 }, providers: { pc: { baseUrl: "http://x/v1", apiKeyEnv: "K" } } });
const status = ask({ mode: "status", config: configFile, log: logFile, guarded: [automode], ownDirs: [], hasUI: true, providers: { pc: { baseUrl: "http://x/v1", apiKeyEnv: "K" } } });
const rows = String(status.text).split("\n");
ok("status is on", rows[0] === "Auto mode: on", rows[0]);
ok("status lists the scorer by endpoint and name", rows.some((r) => r.startsWith("2. Classifier:") && r.includes("pc/lancet, via Hermes") && r.includes("ask >=")), rows[1]);
ok("status lists the chat model by endpoint and name", rows.some((r) => r.startsWith("3. LLM:") && r.includes("pc/flash, via Hermes") && r.includes("two-stage")), rows[2]);
ok("status names the config and the log", rows.some((r) => r.includes("~/" + path.basename(fixture) + "/automode-classifier/config.json")) && rows.some((r) => r.includes("decisions.jsonl")), rows.join(" | "));
fs.rmSync(configFile, { force: true });
const missing = ask({ mode: "status", config: configFile, log: logFile, guarded: [], ownDirs: [], hasUI: true, providers: {} });
ok("status says when the config file is not there", String(missing.text).includes("not present, defaults in use"), missing.text);
fs.writeFileSync(configFile, "{ not json");
const broken = ask({ mode: "status", config: configFile, log: logFile, guarded: [], ownDirs: [], hasUI: true, providers: {} });
ok("status reports a config file it cannot read", String(broken.text).includes("Config error:"), broken.text);

// A guard that cannot answer is an approval, never a quiet allow.
const noise = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", hook], { input: "not json at all", encoding: "utf8" });
ok("unreadable input is an approval", JSON.parse(noise.stdout).action === "approve", noise.stdout);
const empty = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", hook], { input: "", encoding: "utf8" });
ok("no input at all is an approval", JSON.parse(empty.stdout).action === "approve", empty.stdout);

// The rows the wrapper prints come from the same config as Pi's.
const shared = loadConfig(path.join(repo, "config.example.jsonc")).config;
const guard = createGuard(shared, { product: "Hermes", guarded: [], ownDirs: [], log: () => {}, subject });
const text = await statusText(shared, guard, { config: "/nope/config.json", log: "/nope/log.jsonl" });
ok("the example config's own status prints without an error", !text.includes("Config error:") && text.includes("Auto mode: on"), text);

fs.rmSync(fixture, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
