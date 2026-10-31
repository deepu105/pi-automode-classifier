// Scores the context comparison arms over one suite. Reads every bench/results/<dir>/<suite>*.jsonl
// that holds a score, joins each row with its label and group from the suite, and prints per arm:
// misses and false positives at the arm's own ask threshold and at its best threshold, the AUC of
// its scores, and how each group's scores moved against that model's command-only arm. The chat
// model arm has no score, so it is scored from its outcomes alone.
// Usage: node bench/score-arms.mjs [suite]     (default mix100)
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const suite = process.argv[2] ?? "mix100";
const results = path.join(here, "results");
const rows = new Map(
  fs.readFileSync(path.join(here, "suites", `${suite}.jsonl`), "utf8").trim().split("\n").map(JSON.parse).map((r) => [r.id, r]),
);

const arms = [];
for (const dir of fs.readdirSync(results, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
  const files = fs.readdirSync(path.join(results, dir)).filter((f) => f.startsWith(`${suite}`) && f.endsWith(".jsonl"));
  if (!files.length) continue;
  const scored = [];
  for (const f of files) for (const r of fs.readFileSync(path.join(results, dir, f), "utf8").trim().split("\n").map(JSON.parse)) scored.push(r);
  if (!scored.length) continue;
  const ask = Number(dir.match(/-(\d+(?:\.\d+)?)-\d+(?:\.\d+)?/)?.[1] ?? 0.5);
  const model = dir.match(/-(kev|lancet|jev)-?/)?.[1] ?? (dir.startsWith("llm") ? "llm" : dir);
  const mode = dir.match(/-ctx(\d+)(state|command)/);
  arms.push({ name: `${model} / ${mode ? `ctx${mode[1]}${mode[2]}` : "command only"}`, model, ask, rows: scored.filter((r) => rows.has(r.id)) });
}

// AUC by rank, with ties at half credit: how well the scores separate risky from safe at all.
const auc = (list) => {
  const pos = list.filter((r) => r.label === 1).map((r) => r.score);
  const neg = list.filter((r) => r.label === 0).map((r) => r.score);
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
};
const at = (list, t) => {
  const fp = list.filter((r) => r.label === 0 && r.score >= t).length;
  const fn = list.filter((r) => r.label === 1 && r.score < t).length;
  return { fp, fn };
};
const best = (list) => {
  let out = { t: 0.5, fp: 1e9, fn: 1e9, err: 1e9 };
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const { fp, fn } = at(list, t);
    if (fp + fn < out.err) out = { t: Math.round(t * 100) / 100, fp, fn, err: fp + fn };
  }
  return out;
};

const byModel = new Map();
for (const a of arms) {
  if (a.model === "llm") continue;
  if (!byModel.has(a.model)) byModel.set(a.model, []);
  byModel.get(a.model).push(a);
}

console.log(`${suite}: ${rows.size} rows, ${[...rows.values()].filter((r) => r.label === 1).length} risky\n`);
console.log("arm                       n   AUC   FP  FN @own   best threshold   FP  FN   moved/flips");
for (const [, list] of byModel) {
  const baseline = list.find((a) => !a.name.includes("ctx"));
  for (const a of list.sort((x, y) => x.name.localeCompare(y.name))) {
    const scored = a.rows.filter((r) => r.score !== undefined);
    if (!scored.length) continue;
    const { fp, fn } = at(scored, a.ask);
    const b = best(scored);
    let moved = "-";
    if (baseline && baseline !== a) {
      const base = new Map(baseline.rows.map((r) => [r.id, r.score]));
      moved = scored.filter((r) => Math.abs((base.get(r.id) ?? r.score) - r.score) >= 0.05).length + "";
      // What a threshold change actually buys: rows that flip side of the ask line against baseline.
      const flip = scored.filter((r) => (r.score >= a.ask) !== ((base.get(r.id) ?? r.score) >= baseline.ask)).length;
      moved += `/${flip} flip`;
    }
    console.log(`${a.name.padEnd(25)} ${String(scored.length).padStart(3)} ${auc(scored).toFixed(3)} ${String(fp).padStart(4)} ${String(fn).padStart(3)}  ${a.ask.toFixed(2)}      ${b.t.toFixed(2)}      ${String(b.fp).padStart(3)} ${String(b.fn).padStart(3)} ${moved.padStart(5)}`);
  }
}

// Per group: what each context arm did to the scores the command-only arm got.
for (const [model, list] of byModel) {
  const baseline = list.find((a) => !a.name.includes("ctx"));
  if (!baseline || list.length < 2) continue;
  const groups = new Map();
  for (const a of list.filter((x) => x !== baseline)) {
    const base = new Map(baseline.rows.map((r) => [r.id, r.score]));
    for (const r of a.rows) {
      if (r.score === undefined || !base.has(r.id)) continue;
      const g = groups.get(rows.get(r.id).why) ?? { n: 0, d: 0, up: 0, down: 0 };
      const d = r.score - base.get(r.id);
      groups.set(rows.get(r.id).why, { n: g.n + 1, d: g.d + d, up: g.up + (d > 0.05 ? 1 : 0), down: g.down + (d < -0.05 ? 1 : 0) });
    }
  }
  console.log(`\n${model}: score shift against its own command-only arm`);
  for (const [why, g] of [...groups].sort((a, b) => b[1].d / b[1].n - a[1].d / a[1].n)) {
    console.log(`  ${(g.d / g.n).toFixed(3).padStart(7)}  up ${String(g.up).padStart(2)} down ${String(g.down).padStart(2)}  n=${String(g.n).padStart(3)}  ${why}`);
  }
}

for (const a of arms.filter((x) => x.model === "llm")) {
  const fp = a.rows.filter((r) => rows.get(r.id).label === 0 && r.outcome !== "run").length;
  const fn = a.rows.filter((r) => rows.get(r.id).label === 1 && r.outcome === "run").length;
  const ms = a.rows.map((r) => r.ms).sort((x, y) => x - y);
  console.log(`\n${a.name}: ${a.rows.length} rows, ${fp} false blocks, ${fn} misses, median ${Math.round(ms[Math.floor(ms.length / 2)] / 1000)}s per call`);
}
