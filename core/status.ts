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

// What an ask means in a session nobody can answer.
export const noUiText = (config: Config) => {
  const headless = config.withoutUi.rules;
  const extra = someRules([[headless.deny.length, "deny"], [headless.allow.length, "allow"]]);
  return `asks ${config.withoutUi.onAsk === "allow" ? "run" : "blocked"}${extra ? ` + ${extra} rules` : ""}`;
};

// The prompt-timeout clause, shared by the rule row.
export const promptClause = (config: Config) => `prompts: ${config.promptTimeoutMs ? `block after ${afterTimeout(config.promptTimeoutMs)}` : "wait forever"}`;
