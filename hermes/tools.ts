// Hermes tool calls, as the rules see them. One table: what each covered tool names its command or
// its path, and which rule judges it. A tool that is not here is not covered: like an unknown tool
// in Pi, it runs without a decision. The README's Hermes section lists every tool Hermes 0.23.3
// has and says why the ones left out need no decision; test-hermes.mjs checks the two agree.
//
// `label` is what the file rules call the tool: "write" replaces the whole file with the agent's
// text, "edit" keeps the file's origin. `field` is the argument that holds what is judged, and
// `path` works it out from the arguments and the folders the host names (see HookRequest.paths).

import path from "node:path";
import type { GuardSubject } from "../core/guard.ts";

type HostPaths = Record<string, string | undefined>;

interface ToolRule {
  kind: "bash" | "write" | "read";
  label: string;
  field?: string;
  path?: (input: Record<string, unknown>, paths: HostPaths) => string | undefined;
  // The whole subject, for a call one argument does not describe: a V4A patch names every file it
  // writes in its own text, a terminal command runs in a directory of its own.
  subject?: (input: Record<string, unknown>, paths: HostPaths) => GuardSubject | undefined;
}

// A cron job runs later, on the scheduler's own, with no guard in front of it. So the file it names
// is judged now, by the rules for running a file: one this session wrote goes to the chat decider,
// one it downloaded asks, and a plain `prompt` job is left alone because the calls it makes are
// guarded when the job runs. Hermes takes `script` as a path inside `<home>/scripts/` only, so a
// relative one is read the same way here; `monitor` is a script path or a URL, and a URL runs nothing.
const text = (input: Record<string, unknown>, field: string) => (typeof input?.[field] === "string" ? (input[field] as string) : "");
const isUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
// A word the shell reads as one: single quotes, with any quote in it closed around.
const shq = (word: string) => `'${word.split("'").join(`'\\''`)}'`;
const scheduledFile = (input: Record<string, unknown>, paths: HostPaths) => {
  const named = text(input, "script") || (!isUrl(text(input, "monitor")) ? text(input, "monitor") : "");
  if (!named) return undefined;
  const dir = paths.scripts;
  return !dir || path.isAbsolute(named) ? named : path.join(dir, named);
};

// `terminal` has a `workdir` the model sets for one command only (terminal_tool.py). It is judged
// as the `cd` it is, so the rules follow it like any other cd: a workdir outside the project does
// not make that folder the project, where every write in it would look local.
const terminalSubject = (input: Record<string, unknown>): GuardSubject | undefined => {
  const command = text(input, "command");
  if (!command) return undefined;
  const dir = text(input, "workdir");
  return { kind: "bash", label: "terminal", subject: dir ? `cd ${shq(dir)} && ${command}` : command };
};

// The V4A headers Hermes reads for `mode: "patch"` (tools/patch_parser.py): Update, Add and Delete
// name one file, Move names the file and where it goes. One patch names every file it writes in
// this text, and `path` is ignored, so every one of them is judged.
const V4A_FILE = /^\s*\*\*\*\s*(?:Update|Add|Delete)\s+File:\s*(.+)$/;
const V4A_MOVE = /^\s*\*\*\*\s*Move\s+File:\s*(.+?)\s*->\s*(.+)$/;

const patchSubject = (input: Record<string, unknown>): GuardSubject | undefined => {
  if (text(input, "mode") !== "patch") {
    const file = text(input, "path");
    return file ? { kind: "write", label: "edit", subject: file } : undefined;
  }
  const found: string[] = [];
  for (const line of text(input, "patch").split("\n")) {
    const one = V4A_FILE.exec(line)?.[1]?.trim();
    if (one) found.push(one);
    else {
      const move = V4A_MOVE.exec(line);
      if (move) found.push(move[1].trim(), move[2].trim());
    }
  }
  const paths = [...new Set(found)];
  // A patch with no header the guard can read could name anything, so it is not judged: it asks.
  if (!paths.length) return { kind: "unknown", label: "patch", subject: 'mode "patch" with a patch text that names no file' };
  return { kind: "write", label: "edit", subject: paths.join(" "), paths };
};

// `process_manage` drives a background process Hermes already started. Its own schema
// (process_registry.py) names an action, a session and `data`, and no command: `write` and `submit`
// put `data` on the stdin of that process, which is often a shell or a REPL, so that text runs and
// is judged as a command. An action this map does not name is not judged: the guard cannot tell
// what it does.
const PROCESS_READS = new Set(["list", "poll", "log", "wait", "kill", "close", "handoff"]);

const processSubject = (input: Record<string, unknown>): GuardSubject | undefined => {
  const action = text(input, "action");
  if (action === "write" || action === "submit") {
    const data = text(input, "data");
    return data ? { kind: "bash", label: "process_manage", subject: data } : undefined;
  }
  if (PROCESS_READS.has(action)) return undefined;
  return { kind: "unknown", label: "process_manage", subject: `the process_manage action "${action}" is not one the guard knows` };
};

export const TOOL_KIND: Record<string, ToolRule> = {
  // Shell commands, and the two tools that run code instead of a shell line.
  terminal: { kind: "bash", label: "terminal", field: "command", subject: terminalSubject },
  process_manage: { kind: "bash", label: "process_manage", subject: processSubject },
  execute_code: { kind: "bash", label: "execute_code", field: "code" },
  // File changes.
  write_file: { kind: "write", label: "write", field: "path" },
  patch: { kind: "write", label: "edit", subject: patchSubject },
  // Reads: only a credential file asks.
  read_file: { kind: "read", label: "read", field: "path" },
  search_files: { kind: "read", label: "search", field: "path" },
  // Tools that write or run something outside the file arguments it is given.
  cronjob_manage: { kind: "bash", label: "cronjob_manage", path: scheduledFile },
  // Skills and memories are instructions the next session reads, so they are judged as the files
  // they are: changes in those folders, wherever Hermes keeps them under the profile home.
  skill_manage: { kind: "write", label: "write", path: (_input, paths) => paths.skills },
  memory: { kind: "write", label: "write", path: (_input, paths) => paths.memories },
};

export function subject(tool: string, input: Record<string, unknown>, paths: HostPaths = {}): GuardSubject | undefined {
  const rule = TOOL_KIND[tool];
  if (!rule) return undefined;
  if (rule.subject) return rule.subject(input ?? {}, paths);
  const value = rule.path ? rule.path(input ?? {}, paths) : rule.field ? text(input ?? {}, rule.field) : undefined;
  if (!value) return undefined;
  return { kind: rule.kind, label: rule.label, subject: value };
}
