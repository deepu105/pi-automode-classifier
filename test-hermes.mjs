// Checks the Hermes wrapper's own parts: which tool call means what, the session text, the
// endpoints a config names, and the JSON answers hermes/hook.ts writes. No real model is needed:
// one small server stands in for a chat endpoint and a scorer. The commands under test are only
// named, never run. Needs a Node that runs TypeScript directly (22.18 or newer).
// Usage: node test-hermes.mjs
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const repo = import.meta.dirname;
const hook = path.join(repo, "hermes", "hook.ts");
const { subject, TOOL_KIND } = await import("./hermes/tools.ts");
const { chatEndpoint } = await import("./core/openai.ts");
const { chatFor, historyEntries, providerRegistry, statusText } = await import("./hermes/host.ts");
const { transcriptItems } = await import("./core/llm.ts");
const { loadConfig } = await import("./core/config.ts");
const { createGuard } = await import("./core/guard.ts");
const { mergeState } = await import("./core/session.ts");
const { takeStartTurn } = await import("./core/classifier.ts");

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
check("process_manage sends its text to a running shell", subject("process_manage", { action: "submit", session_id: "proc_1", data: "make" }), { kind: "bash", label: "process_manage", subject: "make" });
check("polling a process is left alone", subject("process_manage", { action: "poll", session_id: "proc_1" }), undefined);
check("execute_code is judged as code it runs", subject("execute_code", { code: "print(1)" }), { kind: "bash", label: "execute_code", subject: "print(1)" });
check("write_file replaces a file", subject("write_file", { path: "/tmp/x" }), { kind: "write", label: "write", subject: "/tmp/x" });
check("patch edits a file", subject("patch", { path: "/tmp/x" }), { kind: "write", label: "edit", subject: "/tmp/x" });
check("a patch that edits in place keeps its own path", subject("patch", { mode: "replace", path: "/tmp/x", old_string: "a", new_string: "b" }), { kind: "write", label: "edit", subject: "/tmp/x" });
// A V4A patch names every file it writes in its own text, the same headers Hermes reads
// (tools/patch_parser.py): Update / Add / Delete File, and Move File: a -> b.
const update = (p) => `*** Update File: ${p}\n@@ hint @@\n-old\n+new`;
const add = (p) => `*** Add File: ${p}\n+one line\n+another`;
const del = (p) => `*** Delete File: ${p}`;
const move = (from, to) => `*** Move File: ${from} -> ${to}`;
const v4a = (...ops) => ["*** Begin Patch", ...ops, "*** End Patch"].join("\n");
check("a V4A patch is judged by every file it names", subject("patch", { mode: "patch", patch: v4a(update("/tmp/a"), add("/tmp/b")) }), { kind: "write", label: "edit", subject: "/tmp/a /tmp/b", paths: ["/tmp/a", "/tmp/b"] });
check("a V4A move is judged at both ends", subject("patch", { mode: "patch", patch: v4a(move("/tmp/a", "~/.config/autostart/x.desktop")) }), { kind: "write", label: "edit", subject: "/tmp/a ~/.config/autostart/x.desktop", paths: ["/tmp/a", "~/.config/autostart/x.desktop"] });
check("a delete is judged too", subject("patch", { mode: "patch", patch: v4a(del("/tmp/a")) }), { kind: "write", label: "edit", subject: "/tmp/a", paths: ["/tmp/a"] });
check("a patch text with no file header the guard can read is not judged", subject("patch", { mode: "patch", patch: v4a("@@ hint @@", "-a", "+b") }), { kind: "unknown", label: "patch", subject: 'mode "patch" with a patch text that names no file' });
check("read_file is a read", subject("read_file", { path: "/tmp/x" }), { kind: "read", label: "read", subject: "/tmp/x" });
check("search_files is a read", subject("search_files", { path: "/tmp" }), { kind: "read", label: "search", subject: "/tmp" });
check("a tool no rule covers is left alone", subject("browser", { url: "http://x" }), undefined);
check("a missing argument is left alone", subject("terminal", {}), undefined);
check("an argument that is not text is left alone", subject("terminal", { command: 5 }), undefined);
check("a terminal workdir is judged as the cd it is", subject("terminal", { command: "ls", workdir: "/tmp/here" }), { kind: "bash", label: "terminal", subject: "cd '/tmp/here' && ls" });
check("no arguments at all is left alone", subject("write_file", undefined), undefined);

// The tools that reach a file or a command without naming it in one argument.
const hostPaths = { skills: "/p/skills", memories: "/p/memories", scripts: "/p/scripts" };
check("a scheduled script is judged as the file the scheduler will run", subject("cronjob_manage", { action: "create", script: "backup.sh" }, hostPaths), { kind: "bash", label: "cronjob_manage", subject: "/p/scripts/backup.sh" });
check("an absolute script is judged as it stands", subject("cronjob_manage", { action: "update", script: "/srv/nightly.sh" }, hostPaths), { kind: "bash", label: "cronjob_manage", subject: "/srv/nightly.sh" });
check("a monitor that names a script counts as one", subject("cronjob_manage", { action: "create", monitor: "check.sh" }, hostPaths), { kind: "bash", label: "cronjob_manage", subject: "/p/scripts/check.sh" });
check("a monitor that is a URL runs nothing", subject("cronjob_manage", { action: "create", monitor: "https://example.com/feed" }, hostPaths), undefined);
check("a job with only a prompt is left to its own guarded run", subject("cronjob_manage", { action: "create", prompt: "summarise the day" }, hostPaths), undefined);
check("listing the jobs changes nothing", subject("cronjob_manage", { action: "list" }, hostPaths), undefined);
check("a skill write is a change in the skills folder", subject("skill_manage", { operations: [{ action: "create", name: "notes" }] }, hostPaths), { kind: "write", label: "write", subject: "/p/skills" });
check("a memory note is a change in the memories folder", subject("memory", { target: "memory", operations: [] }, hostPaths), { kind: "write", label: "write", subject: "/p/memories" });
check("without the folders from the host those tools are left alone", subject("skill_manage", { operations: [] }), undefined);

// Every tool Hermes 0.23.3 can give an agent, from toolsets.py's BUILTIN_TOOL_NAMES. Each one is
// either in the map or named in the README's Hermes table with why it needs no decision.
const HERMES_TOOLS = "annotate_preview browser_cdp browser_dialog browser_exec browser_vault clarify close_terminal computer_use cronjob_manage delegate_task desktop_preview desktop_project discord discord_admin drive_preview execute_code feishu_doc_read feishu_drive_add_comment feishu_drive_list_comment_replies feishu_drive_list_comments feishu_drive_reply_comment focus_pane gui_tour image_generate kanban_attach kanban_attach_url kanban_attachments kanban_block kanban_comment kanban_complete kanban_create kanban_heartbeat kanban_link kanban_list kanban_request_changes kanban_request_review kanban_show kanban_unblock manage_catalog manage_connections memory patch process_manage react_to_message read_file read_terminal read_window_below search_files session_search set_theme setup_beat show_tip skill_manage skill_view skills_list terminal text_to_speech todo_list video_analyze video_generate vision_analyze web_extract web_search write_file x_search xai_video_edit xai_video_extend".split(" ");
const hermesDoc = fs.readFileSync(path.join(repo, "README.md"), "utf8").split("## Hermes agents")[1]?.split("## How well does it do?")[0] ?? "";
check("every Hermes tool is mapped or explained in the README", HERMES_TOOLS.filter((name) => !(name in TOOL_KIND) && !hermesDoc.includes(`\`${name}\``)), []);
check("the map names only tools Hermes really has", Object.keys(TOOL_KIND).filter((name) => !HERMES_TOOLS.includes(name)), []);

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
check("the result of a call comes through", entries[2], { role: "toolResult", toolCallId: "c1", toolName: "terminal", isError: false, content: [{ type: "text", text: "build\nsrc" }] });
check("arguments that are not JSON stay text", entries[3].content[0].arguments, "not json");
check("an assistant message with nothing in it is dropped", entries.length, 4);

// How a call ended, read out of the Hermes message form. Hermes has no error flag on a tool message:
// the tool's own dict says it. Without this the decider would read a failed call as one that ran.
const endings = historyEntries([
  { role: "user", content: "do it" },
  { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "terminal", arguments: '{"command":"rm -rf /tmp/x"}' } }] },
  { role: "tool", tool_call_id: "c1", name: "terminal", content: '{"status":"error","error":"no such file"}' },
  { role: "assistant", content: "", tool_calls: [{ id: "c2", function: { name: "terminal", arguments: '{"command":"ls"}' } }] },
  { role: "tool", tool_call_id: "c2", name: "terminal", content: '{"output":"build\nsrc"}' },
]).map((e) => e.message);
check("a result that says error is an error", endings[2].isError, true);
check("a result without it is not", endings[4].isError, false);

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
const automode = path.join(fixture, "automode-classifier");
// A project folder outside the home: the whole home is what a session may not change on its own.
const workspace = path.join(home, "pi-automode-classifier-hermes-work");
const outside = path.join(home, "pi-automode-classifier-hermes-outside");
fs.rmSync(fixture, { recursive: true, force: true });
fs.rmSync(workspace, { recursive: true, force: true });
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
const askAsync = (request) =>
  new Promise((resolve) => {
    // Not spawnSync: a test that serves a fake endpoint from this process has to keep its own event
    // loop free, or the guard it spawns cannot reach that endpoint.
    const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", hook], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (chunk) => (out += chunk));
    proc.on("close", () => {
      const line = out.trim().split("\n").at(-1);
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ action: `unreadable: ${line}` });
      }
    });
    proc.stdin.end(JSON.stringify(request));
  });
const request = (tool, input, extra = {}) => ({ mode: "decide", config: configFile, example: path.join(repo, "config.example.jsonc"), log: logFile, guarded: [automode], ownDirs: [fixture], hasUI: true, tool, input, cwd: workspace, history: [{ role: "user", content: "do it" }], ...extra });
const decide = (tool, input, extra = {}) => ask(request(tool, input, extra));
const decideAsync = async (tool, input, extra = {}) => askAsync(request(tool, input, extra));
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
// One V4A patch can name the guard's own config, and the `path` argument is not what it writes.
const patchGuard = decide("patch", { mode: "patch", path: path.join(workspace, "notes.md"), patch: v4a(update(guardFile), add(path.join(workspace, "new.sh"))) });
ok("a V4A patch that names the guard's own config asks", patchGuard.action === "approve", JSON.stringify(patchGuard));
check("a V4A patch inside the working folder runs", decide("patch", { mode: "patch", patch: v4a(add(path.join(workspace, "new.sh"))) }), { action: "allow" });
check("a patch text the guard cannot read asks", decide("patch", { mode: "patch", patch: "some edits, no headers" }).action, "approve");
const outward = decide("terminal", { command: "git push origin main" });
ok("what the rules leave to a person asks", outward.action === "approve", JSON.stringify(outward));
ok("an ask is written to the decision log", decisions().some((e) => e.outcome === "ask" && e.by === "ask" && e.subject === "git push origin main"), JSON.stringify(decisions().at(-1)));
check("with no way to ask, an ask is a block", decide("terminal", { command: "git push origin main" }, { hasUI: false }).action, "block");
const blocked = decide("terminal", { command: "rm -rf /" }, { hasUI: false });
ok("a blocked call says who blocked it", String(blocked.message).startsWith("Blocked by the auto mode guard:"), JSON.stringify(blocked));
check("off for this session lets the call through", decide("terminal", { command: "git push origin main" }, { enabled: false }), { action: "allow" });
check("on for this session decides as usual", decide("terminal", { command: "git push origin main" }, { enabled: true }).action, "approve");
check("a read of a credential file asks", decide("read_file", { path: path.join(workspace, ".env") }).action, "approve");
// `workdir` is the model's own: it must not turn that folder into the project, where every write
// in it would run by rule.
fs.mkdirSync(outside, { recursive: true });
check("a workdir outside the session does not make its writes local", decide("terminal", { command: "echo hi > evil.txt", workdir: outside }).action, "approve");
check("a workdir that is the session folder runs", decide("terminal", { command: "echo hi > ok.txt", workdir: workspace }), { action: "allow" });
// What process_manage sends runs in the process, so the guard has to see it.
check("text sent to a running process is judged", decide("process_manage", { action: "submit", session_id: "proc_1", data: "import os; os.system('rm -rf ~/Documents')" }).action, "approve");
check("reading a process log runs", decide("process_manage", { action: "log", session_id: "proc_1" }), { action: "allow" });
check("a process_manage action the guard does not know asks", decide("process_manage", { action: "frobnicate", session_id: "proc_1" }).action, "approve");
check("a path the rules do not reach runs", decide("read_file", { path: path.join(workspace, "notes.md") }), { action: "allow" });
// The whole Hermes home is the product's own files: `memory`, `skill_manage` and a cron script
// reach a file without naming the folder, and a change there sets what every later session does.
for (const name of ["memories/MEMORY.md", "skills/notes/SKILL.md", "scripts/nightly.sh"]) {
  ok(`a write to this home's ${name} is held as the product's own file`, String(decide("write_file", { path: path.join(fixture, name), content: "x" }).message).includes("own files"), name);
}

// A model that cannot answer fails closed: the call goes to the approval gate.
writeConfig({ decider: ["classifier", "llm"], classifier: { provider: "gone", model: "m" }, llm: { provider: "gone", model: "m", contextWindow: 131072 }, providers: {} });
const unreachable = decide("terminal", { command: "git push origin main" }, { providers: {} });
ok("a model that is not set up does not let the call through", unreachable.action === "approve" || unreachable.action === "block", JSON.stringify(unreachable));

// ---- What one call leaves for the next one ----
// Each decision is its own process, so the session's state comes back from a file. The commands
// below are only named, never run.
const sessions = path.join(fixture, "automode-classifier", "sessions");
const same = { session: "one-session", sessions };
const stateOf = (id) => JSON.parse(fs.readFileSync(path.join(sessions, `${id}.json`), "utf8"));

// A chat endpoint the guard can reach, so the chat decider really answers.
let chatAnswer = "<block>no</block>";
const chatRequests = [];
const chatServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    chatRequests.push({ url: req.url, body });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: chatAnswer }, finish_reason: "stop" }] }));
  });
});
await new Promise((done) => chatServer.listen(0, "127.0.0.1", done));
const chatProvider = { pc: { baseUrl: `http://127.0.0.1:${chatServer.address().port}/v1`, apiKey: "k" } };
const llmConfig = (llm = {}) => ({ decider: ["llm"], llm: { provider: "pc", model: "m", twoStage: false, contextWindow: 131072, ...llm } });

const downloaded = path.join(workspace, "downloaded.sh");
fs.writeFileSync(downloaded, "#!/bin/sh\necho downloaded\n");
writeConfig({ decider: [], rules: { allow: ["curl *"] } });
check("a download your own rule allows runs", decide("terminal", { command: `curl -o ${downloaded} http://example.com/x.sh` }, same), { action: "allow" });
const { config: endingConfig } = loadConfig(configFile);
const said = transcriptItems(endings.map((message) => ({ message })), endingConfig.llm, undefined, new Map([["c1", "blocked-by-permissions"]]));
check("what the guard recorded about a call beats what its result says", said.filter((i) => i.kind === "tool")[0].outcome, "blocked-by-permissions");
check("a call that failed reads as a failure", transcriptItems(endings.map((message) => ({ message })), endingConfig.llm).filter((i) => i.kind === "tool")[0].outcome, "error");
check("a call that ran cleanly reads as it ran", transcriptItems(endings.map((message) => ({ message })), endingConfig.llm).filter((i) => i.kind === "tool")[1].outcome, "ok");
check("the state file records the download", stateOf("one-session").files[downloaded], "fetched");
writeConfig({ decider: [] });
// An ask goes to Hermes' own approval gate: the person may allow it, so what the call would write
// has to be kept. Otherwise a script this session wrote reads to a later call like any other file.
const madeFile = path.join(outside, "made.sh");
const heldWrite = decide("write_file", { path: madeFile, content: "#!/bin/sh\necho hi\n" }, { session: "approved-ask", sessions });
check("the write goes to the approval gate", heldWrite.action, "approve");
check("and the file it would write is kept as this session's", stateOf("approved-ask").files[madeFile], "authored");

check("and counts the call it decided", stateOf("one-session").counts.rule, 1);
// The clock that keeps a slow local classifier server from starting once per call. Every Hermes
// call is its own process, so the clock is a file, not a variable.
const startMark = path.join(automode, "server-start");
check("the first call may start the classifier server", takeStartTurn(startMark), true);
check("one half a minute later may not", takeStartTurn(startMark), false);
fs.utimesSync(startMark, new Date(0), new Date(0));
check("and after half a minute it may again", takeStartTurn(startMark), true);
check("without a file the clock is this process only", takeStartTurn(""), true);
check("and it holds the next call back", takeStartTurn(""), false);
const runsDownload = decide("terminal", { command: "./downloaded.sh" }, same);
ok("a later call that runs it asks, and says where it came from", runsDownload.action === "approve" && String(runsDownload.message).includes("downloaded in this session"), JSON.stringify(runsDownload));
check("... and it is blocked where nobody can answer", decide("terminal", { command: "./downloaded.sh" }, { ...same, hasUI: false }).action, "block");
const stranger = decide("terminal", { command: "./downloaded.sh" }, { ...same, session: "other-session" });
ok("a session that did not download it sees only an unknown command", String(stranger.message).includes("unknown command"), JSON.stringify(stranger));
// The approval gate keeps one answer per rule_key, so a call that turned dangerous must not share
// the key it had while it was harmless: an approval given before would approve it again, and with
// Hermes' [a]lways choice, in every later session.
ok("the same call in the same session always asks under one key", decide("terminal", { command: "./downloaded.sh" }, same).rule_key === runsDownload.rule_key, `${runsDownload.rule_key}`);
ok("a call that became critical asks under a different key", runsDownload.rule_key !== stranger.rule_key, `${runsDownload.rule_key} == ${stranger.rule_key}`);

const authored = path.join(workspace, "authored.sh");
writeConfig(llmConfig());
check("writing a script in an allowed folder runs", decide("write_file", { path: authored, content: "#!/bin/sh\necho a\n" }, { ...same, providers: chatProvider }), { action: "allow" });
check("the state file records it as the session's own", stateOf("one-session").files[authored], "authored");
const runsAuthored = await decideAsync("terminal", { command: "./authored.sh" }, { ...same, providers: chatProvider });
const authoredLog = decisions().at(-1);
ok("running what this session wrote goes to the chat decider", runsAuthored.action === "allow" && authoredLog.by === "llm" && String(authoredLog.reason).includes("which this session wrote"), `${JSON.stringify(runsAuthored)} ${JSON.stringify(authoredLog)}`);

// The denial caps: after a run of them a person is asked instead of the agent being denied for ever.
writeConfig(llmConfig({ maxTotalDenials: 2, maxConsecutiveDenials: 99 }));
chatAnswer = "<block>yes</block><category>Test case</category><reason>named in the test</reason>";
const capped = { session: "capped", sessions, providers: chatProvider };
check("the first denial blocks", (await decideAsync("terminal", { command: "git push origin one" }, capped)).action, "block");
check("the second reaches the cap, so a person is asked", (await decideAsync("terminal", { command: "git push origin two" }, capped)).action, "approve");
check("the state file holds the denials", stateOf("capped").denials, { consecutive: 2, total: 2 });
check("another session starts the count again", (await decideAsync("terminal", { command: "git push origin two" }, { ...capped, session: "uncapped" })).action, "block");

// A call the guard held back must not read to the next call as a call that ran: each call is a new
// process, and the only thing that carries over is the session state.
writeConfig(llmConfig({ maxTotalDenials: 100, maxConsecutiveDenials: 100 }));
const heldCall = await decideAsync("terminal", { command: "rm -rf /" }, { session: "held-back", sessions, toolCallId: "tc-1" });
check("the held-back call is blocked", heldCall.action, "block");
check("and its outcome is kept for the next call", stateOf("held-back").outcomes?.["tc-1"], "blocked-by-permissions");
const heldHistory = [
  { role: "user", content: "do it" },
  { role: "assistant", content: "", tool_calls: [{ id: "tc-1", type: "function", function: { name: "terminal", arguments: JSON.stringify({ command: "rm -rf /" }) } }] },
  { role: "tool", tool_call_id: "tc-1", name: "terminal", content: '{"error":"no"}' },
];
await decideAsync("terminal", { command: "git push origin main" }, { session: "held-back", sessions, providers: chatProvider, history: heldHistory });
ok("the next call's decider is told it was held back, not that it ran", String(chatRequests.at(-1)?.body).includes("Outcome: blocked-by-permissions"), String(chatRequests.at(-1)?.body).slice(0, 400));
writeConfig(llmConfig({ maxConsecutiveDenials: 1 }));
check("a run of one denial is enough when that is the cap", (await decideAsync("terminal", { command: "git push origin three" }, { ...capped, session: "once" })).action, "approve");
chatAnswer = "<block>no</block>";

// A session nobody used for a week is gone.
const stale = path.join(sessions, "stale-session.json");
const orphan = `${stale}.999.deadbeef.tmp`; // a save whose process died before the rename
fs.writeFileSync(stale, "{}");
fs.writeFileSync(orphan, "{}");
const week = 8 * 24 * 60 * 60 * 1000;
const longAgo = new Date(Date.now() - week);
fs.utimesSync(stale, longAgo, longAgo);
fs.utimesSync(orphan, longAgo, longAgo);
decide("terminal", { command: "ls" }, same);
ok("a session idle for over a week is deleted", !fs.existsSync(stale));
ok("and so is a save left half-written", !fs.existsSync(orphan));
const stateWith = (over = {}) => ({ files: {}, roots: {}, outcomes: {}, counts: { rule: 0, model: 0, asked: 0, blocked: 0 }, denials: { consecutive: 0, total: 0 }, ...over });
check("two parallel calls of one session add up instead of overwriting", mergeState(stateWith({ files: { b: "fetched" }, roots: { "/x": ["/x"] }, counts: { rule: 1, model: 1, asked: 0, blocked: 0 }, denials: { consecutive: 1, total: 1 } }), stateWith({ counts: { rule: 1, model: 0, asked: 0, blocked: 0 }, denials: { consecutive: 0, total: 0 } }), stateWith({ files: { a: "authored" }, roots: { "/y": ["/y"] }, counts: { rule: 2, model: 0, asked: 0, blocked: 0 }, denials: { consecutive: 1, total: 1 } })), stateWith({ files: { b: "fetched", a: "authored" }, roots: { "/x": ["/x"], "/y": ["/y"] }, counts: { rule: 2, model: 1, asked: 0, blocked: 0 }, denials: { consecutive: 2, total: 2 } }));
check(
  "a parallel save does not write an older file origin back",
  mergeState(stateWith({ files: { "run.sh": "fetched" } }), stateWith({ files: { "run.sh": "authored" } }), stateWith({ files: { "run.sh": "authored" } })),
  stateWith({ files: { "run.sh": "fetched" } }),
);
// Worktrees added after the session's first call: the snapshot of the checkouts has to come back
// with the session state, because every Hermes call is a new process. Without it every worktree
// that exists now looks trusted, and `git worktree add <anywhere>` opens that folder.
{
  const box = fs.mkdtempSync(path.join(home, "pi-automode-classifier-late-"));
  const repo = path.join(box, "main");
  fs.mkdirSync(repo);
  const git = (...args) => {
    const ran = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    if (ran.status !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const there = { session: "worktrees", sessions, cwd: repo };
  check("a first call in a fresh checkout runs", decide("terminal", { command: "ls" }, there), { action: "allow" });
  const near = path.join(box, ".worktrees", "near");
  const far = path.join(box + "-far");
  git("worktree", "add", "-q", "-b", "near", near);
  git("worktree", "add", "-q", "-b", "far", far);
  check("a worktree added later next to the checkout counts", decide("terminal", { command: `echo hi > ${path.join(near, "n.txt")}` }, there), { action: "allow" });
  ok("a worktree added later elsewhere does not run", decide("terminal", { command: `echo hi > ${path.join(far, "n.txt")}` }, there).action !== "allow", "it ran");
  fs.rmSync(box, { recursive: true, force: true });
  fs.rmSync(far, { recursive: true, force: true });
}
// The warming call: one throwaway chat request, and an answer that decides nothing.
writeConfig(llmConfig());
const chatBefore = chatRequests.length;
const warm = await askAsync({ ...request("terminal", { command: "ls" }, { session: "warmer", sessions, providers: chatProvider }), mode: "warm" });
check("the warming call answers, and its answer decides nothing", warm.action, "allow");
check("it sends exactly one chat request", chatRequests.length - chatBefore, 1);
check("and it leaves no state behind", fs.existsSync(path.join(sessions, "warmer.json")), false);
await new Promise((done) => chatServer.close(done));

// The status command
writeConfig({ decider: ["classifier", "llm"], classifier: { provider: "pc", model: "lancet" }, llm: { provider: "pc", model: "flash", contextWindow: 131072 }, providers: { pc: { baseUrl: "http://x/v1", apiKeyEnv: "K" } } });
const status = ask({ mode: "status", config: configFile, log: logFile, guarded: [automode], ownDirs: [], hasUI: true, providers: { pc: { baseUrl: "http://x/v1", apiKeyEnv: "K" } }, session: "capped", sessions });
const rows = String(status.text).split("\n");
ok("status is on", rows[0] === "Auto mode: on", rows[0]);
ok("status lists the scorer by endpoint and name", rows.some((r) => r.startsWith("2. Classifier:") && r.includes("pc/lancet, via Hermes") && r.includes("ask >=")), rows[1]);
ok("status lists the chat model by endpoint and name", rows.some((r) => r.startsWith("3. LLM:") && r.includes("pc/flash, via Hermes") && r.includes("two-stage")), rows[2]);
ok("status names the config and the log", rows.some((r) => r.includes("~/" + path.basename(fixture) + "/automode-classifier/config.json")) && rows.some((r) => r.includes("decisions.jsonl")), rows.join(" | "));
ok("status shows the counts of this session", rows.some((r) => r.startsWith("Session:") && r.includes("allowed by rule") && r.includes("2 LLM denials (2 in a row)")), rows.join(" | "));
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
const guard = createGuard(shared, { product: "Hermes", blockedBy: "the auto mode guard", guarded: [], ownDirs: [], log: () => {}, subject });
const text = await statusText(shared, guard, { config: "/nope/config.json", log: "/nope/log.jsonl" });
ok("the example config's own status prints without an error", !text.includes("Config error:") && text.includes("Auto mode: on"), text);

fs.rmSync(fixture, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
