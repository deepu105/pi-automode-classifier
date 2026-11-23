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
}

// A cron job runs later, on the scheduler's own, with no guard in front of it. So the file it names
// is judged now, by the rules for running a file: one this session wrote goes to the chat decider,
// one it downloaded asks, and a plain `prompt` job is left alone because the calls it makes are
// guarded when the job runs. Hermes takes `script` as a path inside `<home>/scripts/` only, so a
// relative one is read the same way here; `monitor` is a script path or a URL, and a URL runs nothing.
const text = (input: Record<string, unknown>, field: string) => (typeof input?.[field] === "string" ? (input[field] as string) : "");
const isUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
const scheduledFile = (input: Record<string, unknown>, paths: HostPaths) => {
  const named = text(input, "script") || (!isUrl(text(input, "monitor")) ? text(input, "monitor") : "");
  if (!named) return undefined;
  const dir = paths.scripts;
  return !dir || path.isAbsolute(named) ? named : path.join(dir, named);
};

export const TOOL_KIND: Record<string, ToolRule> = {
  // Shell commands, and the two tools that run code instead of a shell line.
  terminal: { kind: "bash", label: "terminal", field: "command" },
  process_manage: { kind: "bash", label: "process_manage", field: "command" },
  execute_code: { kind: "bash", label: "execute_code", field: "code" },
  // File changes.
  write_file: { kind: "write", label: "write", field: "path" },
  patch: { kind: "write", label: "edit", field: "path" },
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
  const value = rule.path ? rule.path(input ?? {}, paths) : rule.field ? (typeof input?.[rule.field] === "string" ? (input[rule.field] as string) : undefined) : undefined;
  if (!value || typeof value !== "string") return undefined;
  return { kind: rule.kind, label: rule.label, subject: value };
}
