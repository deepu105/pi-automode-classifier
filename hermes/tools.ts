// Hermes tool calls, as the rules see them. One table: what each covered tool names its command or
// its path, and which rule judges it. A tool that is not here is not covered: like an unknown tool
// in Pi, it runs without a decision.
//
// `label` is what the file rules call the tool: "write" replaces the whole file with the agent's
// text, "edit" keeps the file's origin. `field` is the argument that holds what is judged.

import type { GuardSubject } from "../core/guard.ts";

export const TOOL_KIND: Record<string, { kind: "bash" | "write" | "read"; label: string; field: string }> = {
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
};

export function subject(tool: string, input: Record<string, unknown>): GuardSubject | undefined {
  const mapped = TOOL_KIND[tool];
  if (!mapped) return undefined;
  const value = input?.[mapped.field];
  if (typeof value !== "string") return undefined;
  return { kind: mapped.kind, label: mapped.label, subject: value };
}
