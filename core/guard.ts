// The decision pipeline, shared by every host: the stage 1 rules, then the scorers in `decider`
// order, then the chat decider, then the prompt or the host's stand-in for one.
//
// A host gives this file what only it knows: which tool call means what (`subject`), what the
// session said so far (`transcript`), who can answer a prompt (`hasUI`, `ask`), and where its own
// files and its log are. It gets back one of allow, block, ask, or none.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bashVerdict, commitWrites, compileRules, fileVerdict, isRootLike, makeScope, readVerdict, within, type Scope, type SessionFiles, type Verdict } from "../rules.ts";
import { denyMessage, type Outcome, type TranscriptItem } from "../automode.ts";
import { classify, classifierContext, classifierName, type Registry } from "./classifier.ts";
import { decideWithLlm, llmName, type ChatRegistry } from "./llm.ts";
import { flagged, type Config } from "./config.ts";
import { afterTimeout, clip } from "./util.ts";

const HOME = os.homedir();

// What one call is about: the command text or the file it touches. `label` is what the file rules
// call the tool: "write" replaces a whole file, "edit" keeps the file's origin.
export type GuardSubject = { kind: "bash" | "write" | "read"; label: string; subject: string };

// A confirm prompt: what to show, what to answer with, and how long to wait.
export interface GuardPrompt {
  title: string;
  choices: string[];
  // 0 waits forever.
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface GuardHost {
  // The host's name, for reasons about its own files: "Pi", "Hermes".
  product: string;
  // Files of the guard itself: a change to them always asks and can never be allowed away.
  guarded: string[];
  // The host's own files and folders (Pi's agent directory, a Hermes home): changes to them ask.
  ownDirs: string[];
  log(entry: Record<string, unknown>): void;
  // What the call is about, or undefined for a tool no rule covers.
  subject(tool: string, input: Record<string, unknown>): GuardSubject | undefined;
}

/** What one call's session offers: who can answer, what the session said, what answers the model. */
export interface GuardSession {
  // True when a person can answer a confirm prompt.
  hasUI: boolean;
  // The chat decider's transport; undefined when `decider` has no "llm".
  chat?: ChatRegistry;
  // Where a classifier that names a provider is looked up.
  registry?: Registry;
  // The model of the session, used when the config names none.
  sessionModel?: Record<string, unknown>;
  // The session as the deciders see it, with the call under review last.
  transcript(pending: { tool: string; input: unknown; id?: string; files?: Record<string, string> } | undefined, decided: ReadonlyMap<string, Outcome>): TranscriptItem[];
  // A confirm prompt, when `hasUI`. Without it an ask goes back to the caller unresolved.
  ask?(prompt: GuardPrompt): Promise<{ choice?: string; timedOut?: boolean }>;
  notify?(message: string, level: "info" | "warning"): void;
  // Save a wider pattern or folder in the host's own config file; the error text when it cannot.
  persist?(target: { dir?: string; pattern?: string }): string | undefined;
}

export interface GuardRequest {
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  toolCallId?: string;
  signal?: AbortSignal;
  session: GuardSession;
}

export type Decision =
  // No rule covers this tool, or the guard is off.
  | { action: "none" }
  | { action: "allow"; by: string }
  | { action: "block"; by: string; reason: string }
  // A prompt is needed and nobody here can show one: the host decides what asking means.
  | { action: "ask"; reason: string; tool: string; subject: string; key: string };

export interface GuardStatus {
  enabled: boolean;
  counts: { rule: number; model: number; asked: number; blocked: number };
  denials: { consecutive: number; total: number };
  // The rules in force, as counts for the status line.
  rules: { deny: number; ask: number; classify: number; allow: number };
  allowedPaths: string[];
}

export interface Guard {
  /** Text every prompt repeats, for a config the host had to ignore. */
  notice?: string;
  evaluate(request: GuardRequest): Promise<Decision>;
  status(): GuardStatus;
  setEnabled(on: boolean): void;
}

export function createGuard(config: Config, host: GuardHost): Guard {
  // The user's rules, plus the patterns saved with Always allow during this session. Without a
  // UI the withoutUi rules are added.
  const allowPatterns = [...config.rules.allow];
  // Patterns allowed for this session in a prompt. They never replace a firm ask (rules.ts).
  const picked: string[] = [];
  let pickedRules = compileRules({}).allow;
  const compile = () => {
    const { allow, deny } = config.withoutUi.rules;
    return {
      ui: compileRules({ ...config.rules, allow: allowPatterns }),
      headless: compileRules({ ...config.rules, allow: [...allowPatterns, ...allow], deny: [...config.rules.deny, ...deny] }),
    };
  };
  let rules = compile();
  const allowedPaths = [...config.allowedPaths];
  const guarded = [...host.guarded, ...config.guardedPaths];
  let enabled = config.enabled;
  const counts = { rule: 0, model: 0, asked: 0, blocked: 0 };
  // Denials by the chat decider, the backstop Claude Code has for a pushed-or-compromised agent.
  const denials = { consecutive: 0, total: 0 };
  // Exact commands and paths the user allowed for the rest of the session.
  const sessionAllowed = new Set<string>();
  // Files the session wrote or downloaded, as far as the rules saw it.
  const files: SessionFiles = new Map();
  // Git checkouts per working directory, as they were when the session first used it. A worktree
  // added later counts only inside the folder that holds the main checkout, so `git worktree add`
  // cannot open an arbitrary folder.
  const repositories = new Map<string, string[]>();
  // Calls this guard held back, by tool call id, for the outcome lines the decider reads.
  const decided = new Map<string, Outcome>();
  // Tool calls of one message run in parallel; show one prompt at a time.
  let prompts: Promise<unknown> = Promise.resolve();

  const guard: Guard = {
    setEnabled(on) {
      enabled = on;
    },
    status() {
      return { enabled, counts, denials, rules: { deny: rules.ui.deny.length, ask: rules.ui.ask.length, classify: rules.ui.classify.length, allow: rules.ui.allow.length }, allowedPaths };
    },
    async evaluate(request) {
      const session = request.session;
      if (!enabled) return { action: "none" };
      const input = request.input;
      const now = checkouts(request.cwd);
      if (!repositories.has(request.cwd)) repositories.set(request.cwd, now);
      const roots = repositories.get(request.cwd)!;
      const parent = path.dirname(now[0] ?? "/");
      for (const dir of now) if (!roots.includes(dir) && !isRootLike(parent) && within(dir, parent)) roots.push(dir);
      const scope: Scope = makeScope(request.cwd, guarded, {
        rules: session.hasUI ? rules.ui : rules.headless,
        picked: pickedRules,
        piDirs: host.ownDirs,
        product: host.product,
        allowedPaths: [...allowedPaths, ...roots],
        files,
        project: (p) => inCheckout(p, roots),
        chatDecider: config.decider.includes("llm"),
      });
      const target = host.subject(request.tool, input);
      if (!target) return { action: "none" };
      const subject = target.subject;
      let verdict: Verdict;
      if (target.kind === "bash") {
        verdict = bashVerdict(subject, scope);
      } else if (target.kind === "write") {
        verdict = fileVerdict(target.label, subject, scope);
      } else {
        // Reads are not checked, except for credential files.
        const secret = readVerdict(target.label, subject, scope);
        if (!secret) return { action: "none" };
        verdict = secret;
      }

      const entry: Record<string, unknown> = { tool: request.tool, cwd: request.cwd, subject: clip(subject, 4000), rule: verdict.action, reason: verdict.reason };
      const finish = (outcome: string, by: string) => {
        if (outcome === "allow") commitWrites(scope);
        host.log({ ...entry, outcome, by });
      };
      const held = (outcome: Outcome) => {
        if (request.toolCallId) decided.set(request.toolCallId, outcome);
      };
      // A call allowed while it was not critical asks again once the same text is, for example a
      // script that a download has since replaced.
      const key = `${verdict.critical ? "critical" : ""}\0${request.tool}\0${request.cwd}\0${subject}`;
      // The user allowed this exact call for the session, so no model gets to block it again.
      if (verdict.action === "classify" && sessionAllowed.has(key)) {
        finish("allow", "session");
        return { action: "allow", by: "session" };
      }

      // The classifiers, in `decider` order. A score at or above askAbove asks you. When another
      // decider comes next, a score from allowBelow up, or no score, goes to that one; otherwise
      // the call runs. Two kinds of call skip the classifiers and go to the chat model: an ask from
      // the rules, and a call that runs files the session wrote. A classifier sees only the
      // command, so it cannot tell whether the user asked for it or what the file holds.
      let toLlm = false;
      if (verdict.action === "classify") {
        const chain = verdict.ruleAsk || verdict.files ? config.decider.filter((d) => d === "llm") : config.decider;
        const steps: Record<string, unknown>[] = [];
        for (const [i, stage] of chain.entries()) {
          if (stage === "llm") {
            toLlm = true;
            break;
          }
          const last = i === chain.length - 1;
          const items = config.classifier.contextChars ? session.transcript({ tool: request.tool, input }, decided) : [];
          const state = classifierContext(config, { tool: request.tool, cwd: request.cwd, command: subject }, items);
          const result = await classify(config, state, request.signal, session.registry, stage);
          steps.push({ decider: stage, model: classifierName(config, stage), ...result });
          entry.steps = steps;
          const risk = "answers" in result ? flagged(config, result.answers, stage) : undefined;
          if (risk) {
            verdict = { ...verdict, action: "ask", reason: risk };
            break;
          }
          if (!last && ("error" in result || result.answers.risky >= config[stage].allowBelow)) continue;
          if ("error" in result) {
            verdict = { ...verdict, action: "ask", reason: `model gave no answer: ${result.error}` };
            break;
          }
          counts.model++;
          finish("allow", stage);
          return { action: "allow", by: stage };
        }
        if (!chain.length) verdict = { ...verdict, action: "ask" };
      }

      if (toLlm) {
        const llm = config.llm;
        const actionFiles = verdict.files?.length ? fileContents(verdict.files) : undefined;
        const items = session.transcript({ tool: request.tool, input, id: request.toolCallId, files: actionFiles }, decided);
        const sessionModel = session.sessionModel;
        const decision = await decideWithLlm(config, items, request.signal, session.chat, sessionModel);
        Object.assign(entry, {
          model: llmName(llm, sessionModel ? `${sessionModel.provider}/${sessionModel.id}` : undefined),
          llm: { stage: "stage" in decision ? decision.stage : undefined, tokens: "tokens" in decision ? decision.tokens : undefined },
        });

        if ("error" in decision) {
          entry.llmError = decision.error;
          // Claude Code's iron gate: with no answer the call is held back, not waved through. Without
          // a UI an ask would fall to `withoutUi`, and a non-answer is easier to cause than an allow.
          if (llm.onNoAnswer === "ask" && session.hasUI) {
            verdict = { ...verdict, action: "ask", reason: `the decider gave no answer (${decision.error})` };
          } else {
            counts.blocked++;
            held(decision.unparsed ? "automode-parsing-error" : "automode-unavailable");
            host.log({ ...entry, outcome: "block", by: "llm-unavailable" });
            const retry = decision.lasting
              ? "retrying the same action fails the same way, so tell the user"
              : "retrying the same action is appropriate if the user asked for it";
            return { action: "block", by: "llm-unavailable", reason: denyMessage(`auto mode classifier unavailable: ${decision.error}. This was not a policy decision; ${retry}.`) };
          }
        } else if (decision.block) {
          entry.llmCategory = decision.category;
          entry.llmReason = decision.reason;
          denials.total++;
          denials.consecutive++;
          // Deny-and-continue, with Claude Code's backstop: after a run of denials the human is
          // asked instead of the agent being left to push against the wall.
          const exhausted = denials.consecutive >= llm.maxConsecutiveDenials || denials.total >= llm.maxTotalDenials;
          // Without a UI an ask falls to `withoutUi`, which could run what the decider denied.
          if (!session.hasUI || (llm.onBlock === "block" && !exhausted)) {
            counts.blocked++;
            held("automode-blocked");
            host.log({ ...entry, outcome: "block", by: "llm" });
            session.notify?.(`Auto mode blocked ${request.tool}: ${decision.category ?? decision.reason}`, "warning");
            return { action: "block", by: "llm", reason: denyMessage(decision.reason) };
          }
          const why = exhausted ? `${decision.reason} (${denials.consecutive} denials in a row, ${denials.total} this session)` : decision.reason;
          verdict = { ...verdict, action: "ask", reason: why };
        } else {
          denials.consecutive = 0;
          counts.model++;
          finish("allow", "llm");
          return { action: "allow", by: "llm" };
        }
      }

      if (verdict.action === "allow") {
        counts.rule++;
        finish("allow", "rule");
        return { action: "allow", by: "rule" };
      }
      if (verdict.action === "deny") {
        counts.blocked++;
        held("blocked-by-permissions");
        finish("block", "rule");
        session.notify?.(`Blocked ${request.tool}: ${verdict.reason}`, "warning");
        return { action: "block", by: "rule", reason: `Blocked by the auto mode guard: ${verdict.reason}. Do not retry it or work around it. Tell the user it was blocked.` };
      }

      if (sessionAllowed.has(key)) {
        finish("allow", "session");
        return { action: "allow", by: "session" };
      }
      if (!session.hasUI) {
        // Root, credentials, downloaded code and the guard's own files never run unasked.
        if (config.withoutUi.onAsk === "allow" && !verdict.critical && !verdict.locked) {
          finish("allow", "no-ui");
          return { action: "allow", by: "no-ui" };
        }
        counts.blocked++;
        held("blocked-by-permissions");
        finish("block", "no-ui");
        return { action: "block", by: "no-ui", reason: `This needs the user's approval (${verdict.reason}) and there is no UI to ask. Do not work around it. Tell the user.` };
      }
      // A host with a way to ask that does not show prompts itself (Hermes hands the ask back).
      if (!session.ask) return { action: "ask", reason: verdict.reason, tool: request.tool, subject, key };

      counts.asked++;
      // While the config file is ignored every prompt says so, since the defaults decide differently.
      const title = `Auto mode: allow ${request.tool}?\n${verdict.reason}\n\n${clip(subject, 1200)}${guard.notice ? `\n\n${guard.notice}` : ""}`;
      // The same choices whatever asked: this call once, this exact call for the session, Block,
      // and then the wider one, for a command's pattern or a folder outside the working directory.
      // The wider choice can also be saved to the config file, except a pattern that came from an
      // ask: that one is the ask itself, so it is offered for the session only.
      const dir = verdict.dir?.replace(HOME, "~");
      const covers = dir ? `changes in ${dir}` : verdict.pattern ? `"${verdict.pattern}"` : undefined;
      const wider = covers ? `Allow ${covers} for this session` : undefined;
      const always = covers && !verdict.fromAsk ? `Always allow ${covers}` : undefined;
      const choices = ["Allow once", "Allow for this session", "Block", ...(wider ? [wider] : []), ...(always ? [always] : [])];
      const asked = prompts.then(() => session.ask!({ title, choices, timeoutMs: config.promptTimeoutMs, signal: request.signal }));
      prompts = asked.catch(() => undefined);
      const answer = await asked;
      if (answer.timedOut) {
        counts.blocked++;
        // To the decider this reads as a call nobody approved, which is how it should be treated.
        held("rejected-by-user");
        finish("block", "timeout");
        session.notify?.(`Auto mode blocked ${request.tool}: no answer in ${afterTimeout(config.promptTimeoutMs)}`, "warning");
        return { action: "block", by: "timeout", reason: `The confirm prompt got no answer in ${afterTimeout(config.promptTimeoutMs)}, so it was treated as a block. Do not retry it or work around it. Tell the user and ask how to proceed.` };
      }
      const choice = answer.choice;
      // A dismissed prompt leaves no choice, which is neither of the two wider ones even when
      // nothing wider could be offered, so the absent choice is ruled out first.
      const took = choice !== undefined && (choice === wider || choice === always);
      if (took) {
        if (verdict.dir) allowedPaths.push(verdict.dir);
        else if (choice === always) {
          allowPatterns.push(verdict.pattern!);
          rules = compile();
        } else {
          picked.push(verdict.pattern!);
          pickedRules = compileRules({ allow: picked }).allow;
        }
      }
      if (choice !== undefined && choice === always) {
        const error = session.persist?.(verdict.dir ? { dir } : { pattern: verdict.pattern! });
        if (error) session.notify?.(error, "warning");
      }
      // The exact command text only, which is all there is when nothing wider could be offered.
      if (choice === "Allow for this session") sessionAllowed.add(key);
      if (choice === "Allow once" || choice === "Allow for this session" || took) {
        finish("allow", "user");
        return { action: "allow", by: "user" };
      }
      counts.blocked++;
      held("rejected-by-user");
      finish("block", "user");
      return { action: "block", by: "user", reason: `The user blocked this (${verdict.reason}). Do not retry it or work around it. Ask the user how to proceed.` };
    },
  };
  return guard;
}

// What the files a classified call runs hold now, for the decider to judge with the call.
function fileContents(paths: string[]): Record<string, string> {
  return Object.fromEntries(
    paths.map((p) => {
      try {
        return [p, fs.readFileSync(p, "utf8")];
      } catch (e) {
        return [p, `(cannot be read: ${(e as Error).message})`];
      }
    }),
  );
}

// ---- git ----

function git(dir: string, ...args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
  } catch {
    return undefined;
  }
}
const realpath = (p: string) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
};

// The checkouts of the git repository that holds `cwd`: the main one and its worktrees. Empty
// outside a repository. $HOME and the directories above it are left out.
export function checkouts(cwd: string): string[] {
  const entries = (git(cwd, "worktree", "list", "--porcelain") ?? "").split("\n\n");
  return entries
    .filter((entry) => !/^bare$/m.test(entry))
    .flatMap((entry) => /^worktree (.+)$/m.exec(entry)?.[1] ?? [])
    .map(realpath)
    .filter((dir) => !isRootLike(dir));
}

// True when `file` is tracked or ignored by the repository checked out in one of `roots`. A
// repository cloned inside a checkout is a different one, so its files do not count.
export function inCheckout(file: string, roots: string[]): boolean {
  const dir = path.dirname(file);
  const top = git(dir, "rev-parse", "--show-toplevel")?.trim();
  if (!top || !roots.includes(realpath(top))) return false;
  return git(dir, "ls-files", "--error-unmatch", "--", file) !== undefined || git(dir, "check-ignore", "-q", "--", file) !== undefined;
}
