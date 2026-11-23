// Small helpers shared by the core and the host wrappers. No host imports here.

import fs from "node:fs";
import path from "node:path";

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)} ... (${text.length} chars)` : text);

// The prompt timeout as text: "30 seconds", "1 minute", "2.5 minutes".
export const afterTimeout = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round((seconds / 60) * 10) / 10;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
};

// One decision per line, as JSON. The log is for tuning only: a write failure never changes a
// decision, and the file holds transcript text, so it stays mode 600.
export function appendLog(file: string, enabled: boolean, entry: Record<string, unknown>) {
  if (!enabled) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  } catch {
    // The log never decides.
  }
}
