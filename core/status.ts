// The wording a status command uses for a config, so two hosts describe one config the same way.
// Each host still writes its own rows: what a Pi model is and what a named endpoint is differ.

import type { Config } from "./config.ts";
import { afterTimeout } from "./util.ts";

export const statusRow = (label: string, text: string) => `${label.padEnd(15)}${text}`;

// "2 deny, 1 ask", skipping the zero counts. "" when all are zero.
export const someRules = (pairs: [number, string][]) => pairs.filter(([n]) => n).map(([n, what]) => `${n} ${what}`).join(", ");

// One scoring stage's thresholds. `last` means nothing decides after it, so there is no middle band.
export const scoreBands = (stage: { allowBelow: number; askAbove: number }, last: boolean) =>
  last || stage.allowBelow >= stage.askAbove ? `allow < ${stage.askAbove}, ask >= ${stage.askAbove}` : `allow < ${stage.allowBelow}, next ${stage.allowBelow}-${stage.askAbove}, ask >= ${stage.askAbove}`;

// The session line: how the calls so far went. Both hosts print it from core/guard.ts's own counts.
export const sessionRow = (status: { counts: { rule: number; model: number; asked: number; blocked: number }; denials: { consecutive: number; total: number } }) =>
  statusRow("Session:", `${status.counts.rule} allowed by rule, ${status.counts.model} by model, ${status.counts.asked} asked, ${status.counts.blocked} blocked${status.denials.total ? `, ${status.denials.total} LLM denials (${status.denials.consecutive} in a row)` : ""}`);

// What an ask means in a session nobody can answer.
export const noUiText = (config: Config) => {
  const headless = config.withoutUi.rules;
  const extra = someRules([[headless.deny.length, "deny"], [headless.allow.length, "allow"]]);
  return `asks ${config.withoutUi.onAsk === "allow" ? "run" : "blocked"}${extra ? ` + ${extra} rules` : ""}`;
};

// The prompt-timeout clause, shared by the rule row.
export const promptClause = (config: Config) => `prompts: ${config.promptTimeoutMs ? `block after ${afterTimeout(config.promptTimeoutMs)}` : "wait forever"}`;

// What one status block says about the host: how it names each step of the pipeline, and which two
// files it reads. Pi runs a classifier process and takes models from its own registry; a Hermes call
// reads one config file and names the endpoint its config points at. Both read the same config.
export interface StatusHost {
  // The config problem the host knows about, if any.
  notice?: string;
  // The chat decider, as this host names it.
  llm: string;
  // The classifier process, with whatever the host knows about it.
  command: string;
  // Where the scorer runs, and whether it answers.
  classifier: string;
  // The config file and the decision log, spelled the way the host spells them.
  config: string;
  log: string;
}

// One status block, one numbered row per step: the same shape in both hosts, with the host's own
// words for what each step is.
export function statusRows(config: Config, status: Parameters<typeof sessionRow>[0], host: StatusHost): string {
  const describe = (stage: string, i: number) => {
    const label = `${i + 2}. ${stage === "llm" ? "LLM" : stage === "command" ? "Command" : "Classifier"}:`;
    const last = i === config.decider.length - 1;
    if (stage === "llm") {
      const notes = [config.llm.twoStage ? "two-stage" : "one stage", `thinking:${config.llm.thinkingLevel}`];
      if (config.llm.onBlock === "ask") notes.push("asks instead of blocking");
      if (config.llm.onNoAnswer === "ask") notes.push("asks when it has no answer");
      return statusRow(label, `${host.llm} (${notes.join(", ")})`);
    }
    if (stage === "command") return statusRow(label, `${host.command} (${scoreBands(config.command, last)})`);
    const more = Object.keys(config.classifier.extraQuestions);
    const extra = more.length ? `, extra: ${more.join(", ")}` : "";
    return statusRow(label, `${host.classifier} (${scoreBands(config.classifier, last)}${extra})`);
  };
  const { deny, ask, classify, allow } = status.rules;
  const yours = someRules([[deny, "deny"], [ask, "ask"], [classify, "classify"], [allow, "allow"], [status.allowedPaths.length, "allowed paths"]]) || "none";
  return [
    `Auto mode: ${status.enabled ? "on" : "OFF for this session   (turn on: /automode-classifier on)"}`,
    ...(host.notice ? [`Config error: ${host.notice}`] : []),
    statusRow("1. Rules:", `${yours} (no UI: ${noUiText(config)}, ${promptClause(config)})`),
    ...(config.decider.length ? config.decider.map(describe) : [statusRow("2. Decider:", "none, classify verdicts ask you")]),
    "",
    sessionRow(status),
    statusRow("Config:", host.config),
    statusRow("Log:", host.log),
  ].join("\n");
}
