// One session's state in a file, for a host that decides every call in a fresh process. What is
// stored is exactly what core/guard.ts keeps between calls (GuardState); nothing is decided here.
//
// Two calls of one session can run at the same time (a host may run the tool calls of one message in
// parallel), so one read-modify-write runs under a lock file and the counters merge as the change
// each call made since it read the file.

import fs from "node:fs";
import path from "node:path";
import { emptyState, type GuardState } from "./guard.ts";

// A session nobody has used for this long is deleted; its next call starts fresh.
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILES = 400; // entries kept in the file-origin map; the oldest go first
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 30_000; // a lock older than this is from a process that died holding it

export interface StoredState extends GuardState {
  updated: number;
}

// One session id as one safe file name. Hermes session ids are opaque text.
export function sessionFile(dir: string, id: string): string {
  const safe = (id || "").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "session";
  return path.join(dir, `${safe}.json`);
}

// The session as the file holds it. Anything unreadable is a fresh session: the guard still decides,
// it just knows nothing about the calls before this one.
export function loadState(file: string): GuardState {
  let stored: Partial<StoredState> = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return emptyState();
  }
  const files = stored.files && typeof stored.files === "object" ? stored.files : {};
  return { files, counts: { ...emptyState().counts, ...(stored.counts ?? {}) }, denials: { ...emptyState().denials, ...(stored.denials ?? {}) } };
}

// `now` started life as `base` and ended here, so what it added is what the file gains. Counters
// that way survive two calls of one session; file origins from both calls are kept, this call's
// winning where both name the same file.
export function mergeState(stored: GuardState, base: GuardState, now: GuardState): GuardState {
  const change = (get: (s: GuardState) => number) => Math.max(0, get(stored) + (get(now) - get(base)));
  const merged = { ...stored.files, ...now.files };
  const keys = Object.keys(merged);
  const files = keys.length > MAX_FILES ? Object.fromEntries(keys.slice(-MAX_FILES).map((k) => [k, merged[k]])) : merged;
  return {
    files,
    counts: {
      rule: change((s) => s.counts.rule),
      model: change((s) => s.counts.model),
      asked: change((s) => s.counts.asked),
      blocked: change((s) => s.counts.blocked),
    },
    denials: { consecutive: change((s) => s.denials.consecutive), total: change((s) => s.denials.total) },
  };
}

// Write one session's state. Never throws: a session that cannot be saved is a session that
// remembers nothing, which is how it was before this file existed.
export function saveState(file: string, base: GuardState, now: GuardState): void {
  const dir = path.dirname(file);
  const lock = `${file}.lock`;
  const locked = acquire(lock);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const state = mergeState(loadState(file), base, now);
    // Only the rename is seen by another process, so a reader never gets half a file.
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...state, updated: Date.now() }));
    fs.renameSync(tmp, file);
  } catch {
    return;
  } finally {
    if (locked) fs.rmSync(lock, { recursive: true, force: true });
  }
  pruneSessions(dir);
}

// Delete sessions idle since MAX_AGE_MS, so the folder does not grow for ever. Returns how many.
export function pruneSessions(dir: string): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".json") && !name.endsWith(".warm")) continue;
    try {
      if (Date.now() - fs.statSync(path.join(dir, name)).mtimeMs > MAX_AGE_MS) {
        fs.unlinkSync(path.join(dir, name));
        removed++;
      }
    } catch {
      continue;
    }
  }
  return removed;
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const mtime = (p: string) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

// mkdir is the only atomic "create if absent" a plain file system offers, so the lock is a folder.
// After LOCK_WAIT_MS the caller writes anyway: the write is atomic, so the worst case is that a
// parallel call's change is lost, and no answer should wait longer than that.
function acquire(lock: string): boolean {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
      if (Date.now() - mtime(lock) > LOCK_STALE_MS) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) return false;
      sleep(20);
    }
  }
}
