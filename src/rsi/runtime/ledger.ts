/** Project-global experiment ledger and lineage graph.
 *
 * The ledger is generated from durable run state, never from model memory. It
 * is refreshed after every state/final write so new baseline, candidate,
 * ablation and rebuttal evidence appears without an explicit export step.
 *
 * A family is the model-definition identity, not the git commit: changing only
 * optimizer/scheduler/stage hyperparameters keeps the same family, while a
 * changed model-definition file starts a new family.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { AgentContext } from "../agents/base.ts";
import type { Evidence, Problem } from "../types.ts";

export type LedgerKind = "baseline" | "subset" | "full" | "ablation" | "rebuttal";

export interface LedgerExperiment {
  id: string;
  family_id: string;
  family_label: string;
  parent_id: string | null;
  parent_commit: string | null;
  kind: LedgerKind;
  run_id: string;
  run_ids: string[];
  idea_id: string;
  scope: string;
  commit: string | null;
  label: string;
  decision: string;
  metrics: Record<string, number>;
  samples: number;
  timestamp: string;
  model_file: string | null;
  model_blob: string | null;
  selected: boolean;
}

export interface LedgerRun {
  run_id: string;
  root: string;
  problem: string;
  updated_at: string;
  aborted: boolean;
  accepted: boolean;
  decision_path: string[];
}

export interface LedgerFamily {
  id: string;
  label: string;
  model_file: string | null;
  model_blob: string | null;
  experiments: number;
}

export interface LedgerSnapshot {
  version: 1;
  project: string;
  updated_at: string;
  ledger_dir: string;
  runs: LedgerRun[];
  families: LedgerFamily[];
  experiments: LedgerExperiment[];
}

export interface LedgerOptions {
  projectRoot: string;
  runsRoots?: string[];
  ledgerDir?: string;
}

interface RunState {
  problem: Problem;
  state: Record<string, unknown>;
  runId: string;
  root: string;
  updatedAt: string;
}

interface PendingExperiment extends Omit<LedgerExperiment, "parent_id" | "family_label" | "run_ids"> {
  parent_commit: string | null;
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function readJson(file: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The target-owned model-definition file, not a hyperparameter/config file. */
export function modelDefinitionFile(problem: Problem): string | null {
  const env = record(problem.remote?.env);
  const keys = Object.keys(env).sort();
  for (const key of keys) {
    if (/MODEL_FILE$/i.test(key) || /MODEL_DEFINITION$/i.test(key)) {
      const value = string(env[key]);
      if (value) return value;
    }
  }
  return null;
}

function gitBlob(repo: string | null, commit: string | null, file: string | null): string | null {
  if (!repo || !commit || !file) return null;
  try {
    const result = spawnSync("git", ["-C", repo, "rev-parse", `${commit}:${file}`], {
      encoding: "utf8",
      timeout: 5000,
    });
    return result.status === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

function familyFor(problem: Problem): { id: string; label: string; file: string | null; blob: string | null } {
  const file = modelDefinitionFile(problem);
  const repo = problem.repo ? path.resolve(problem.repo) : null;
  const commit = string((problem as unknown as { repo_ref?: unknown }).repo_ref) || null;
  const blob = gitBlob(repo, commit, file);
  const identity = blob ? `model:${blob}` : file ? `model-file:${file}` : "model:default";
  const id = `fam-${hash(identity).slice(0, 12)}`;
  const label = file ? `${file}${blob ? ` @ ${blob.slice(0, 8)}` : ""}` : "default model";
  return { id, label, file, blob };
}

function modelFileForCommit(problem: Problem, commit: string | null): { file: string | null; blob: string | null } {
  const file = modelDefinitionFile(problem);
  const repo = problem.repo ? path.resolve(problem.repo) : null;
  return { file, blob: gitBlob(repo, commit, file) };
}

function experimentId(fingerprint: string): string {
  return `exp-${hash(fingerprint).slice(0, 16)}`;
}

function metricText(metrics: Record<string, number>): string {
  return Object.keys(metrics).sort().map((name) => `${name}=${metrics[name]}`).join(", ") || "no metrics";
}

function runDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .filter((dir) => fs.existsSync(path.join(dir, "state.json")));
  } catch {
    return [];
  }
}

function loadRuns(roots: string[]): RunState[] {
  const seen = new Set<string>();
  const runs: RunState[] = [];
  for (const root of roots) {
    for (const dir of runDirs(root)) {
      const resolved = path.resolve(dir);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      const state = readJson(path.join(dir, "state.json"));
      const problem = record(record(state).problem) as unknown as Problem;
      if (!problem?.id) continue;
      runs.push({
        problem,
        state: record(state),
        runId: path.basename(dir),
        root: dir,
        updatedAt: (() => {
          try { return fs.statSync(path.join(dir, "state.json")).mtime.toISOString(); }
          catch { return new Date(0).toISOString(); }
        })(),
      });
    }
  }
  return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function addEvidence(
  output: PendingExperiment[],
  state: RunState,
  evidence: Evidence | null,
  kind: LedgerKind,
  opts: { ideaId?: string; parentCommit?: string | null; decision?: string; selected?: boolean } = {},
): void {
  if (!evidence || !evidence.scope) return;
  const commit = evidence.code?.commit ?? null;
  const model = modelFileForCommit(state.problem, commit);
  const family = familyFor({ ...state.problem, repo_ref: commit ?? state.problem.repo_ref } as Problem);
  const parentCommit = opts.parentCommit ?? evidence.code?.parent ?? null;
  const ideaId = opts.ideaId ?? evidence.idea_id ?? "baseline";
  const label = evidence.label || evidence.scope;
  const fingerprint = stable({ kind, scope: evidence.scope, ideaId, commit, label, metrics: evidence.metrics });
  output.push({
    id: experimentId(fingerprint),
    family_id: family.id,
    parent_commit: parentCommit,
    kind,
    run_id: state.runId,
    idea_id: ideaId,
    scope: evidence.scope,
    commit,
    label,
    decision: opts.decision ?? (kind === "baseline" ? "baseline" : "candidate"),
    metrics: evidence.metrics,
    samples: evidence.samples?.length ?? 0,
    timestamp: state.updatedAt,
    model_file: model.file,
    model_blob: model.blob,
    selected: opts.selected === true,
  });
}

function collectRun(state: RunState): PendingExperiment[] {
  const out: PendingExperiment[] = [];
  const baseline = state.state.baseline as Evidence | null;
  const baselineFull = state.state.baseline_full as Evidence | null;
  const traces = array(state.state.traces) as Array<Record<string, unknown>>;
  const best = state.state.best_evidence as Evidence | null;
  const bestCommit = best?.code?.commit ?? null;

  addEvidence(out, state, baseline, "baseline", { ideaId: "baseline", decision: "baseline" });
  addEvidence(out, state, baselineFull, "baseline", {
    ideaId: "baseline-full",
    parentCommit: baseline?.code?.commit ?? null,
    decision: "baseline",
  });

  const baselineCommit = (scope: string): string | null =>
    scope === "full" ? baselineFull?.code?.commit ?? baseline?.code?.commit ?? null : baseline?.code?.commit ?? null;

  for (const rawTrace of traces) {
    const idea = record(rawTrace.idea);
    const ideaId = string(idea.id) || "idea";
    const evidenceList = array(rawTrace.evidence) as Evidence[];
    let previousCommit: string | null = null;
    for (let index = 0; index < evidenceList.length; index += 1) {
      const evidence = evidenceList[index];
      if (!evidence?.scope) continue;
      const parent = previousCommit ?? evidence.code?.parent ?? baselineCommit(evidence.scope);
      addEvidence(out, state, evidence, evidence.scope === "full" ? "full" : "subset", {
        ideaId,
        parentCommit: parent,
        decision: index === evidenceList.length - 1 ? string(rawTrace.decision) : "candidate",
      });
      previousCommit = evidence.code?.commit ?? previousCommit;
    }
  }

  for (const raw of array(state.state.ablations) as Array<Record<string, unknown>>) {
    const evidence = (raw.evidence ?? null) as Evidence | null;
    addEvidence(out, state, evidence, "ablation", {
      ideaId: string(raw.plan_id) || "ablation",
      parentCommit: bestCommit,
      decision: raw.ok === true ? "good" : "refine",
    });
  }
  for (const evidence of array(state.state.rebuttals) as Evidence[]) {
    addEvidence(out, state, evidence, "rebuttal", {
      ideaId: evidence.idea_id,
      parentCommit: bestCommit,
      decision: "rebuttal",
    });
  }
  // Mark the final evidence selected without duplicating it.
  for (const item of out) {
    if (bestCommit && item.commit === bestCommit && item.scope === "full") item.selected = true;
  }
  return out;
}

function familyNodes(families: Map<string, LedgerFamily>): LedgerFamily[] {
  return [...families.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function resolveParents(experiments: LedgerExperiment[]): void {
  // A commit can have both subset and full evidence; never let the full record
  // shadow the subset parent just because it was merged later.
  const byCommitAndScope = new Map<string, LedgerExperiment>();
  const baselines = new Map<string, LedgerExperiment>();
  for (const item of experiments) {
    if (item.commit) byCommitAndScope.set(`${item.commit}:${item.scope}`, item);
    if (item.kind === "baseline") baselines.set(`${item.family_id}:${item.scope}`, item);
  }
  for (const item of experiments) {
    let parent: LedgerExperiment | undefined;
    if (item.parent_commit) {
      parent = byCommitAndScope.get(`${item.parent_commit}:${item.scope}`) ??
        byCommitAndScope.get(`${item.parent_commit}:subset`) ??
        byCommitAndScope.get(`${item.parent_commit}:full`);
      if (parent?.id === item.id) parent = undefined;
    }
    if (!parent) {
      const baseline = baselines.get(`${item.family_id}:${item.scope}`) ??
        baselines.get(`${item.family_id}:subset`) ??
        baselines.get(`${item.family_id}:full`);
      if (baseline && baseline.id !== item.id) parent = baseline;
    }
    item.parent_id = parent?.id ?? null;
  }
  // A parent edge must not point to a different family's baseline when a
  // same-family baseline exists; cross-family edges are kept only for model
  // definition changes, where that is the actual lineage.
}

function mergeExperiments(pending: PendingExperiment[]): LedgerExperiment[] {
  const map = new Map<string, LedgerExperiment>();
  for (const item of pending) {
    const existing = map.get(item.id);
    if (!existing) {
      map.set(item.id, { ...item, run_ids: [item.run_id], family_label: "", parent_id: null });
      continue;
    }
    if (!existing.run_ids.includes(item.run_id)) existing.run_ids.push(item.run_id);
    existing.selected ||= item.selected;
    if (item.timestamp > existing.timestamp) existing.timestamp = item.timestamp;
  }
  return [...map.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
}

function mermaid(project: string, families: LedgerFamily[], experiments: LedgerExperiment[]): string {
  const ids = new Map<string, string>();
  experiments.forEach((item, index) => ids.set(item.id, `N${index}`));
  const familyNodes = new Map<string, string>();
  families.forEach((family, index) => familyNodes.set(family.id, `F${index}`));
  const lines = ["```mermaid", "graph TD", `  P["${escapeMermaid(project)}"]`];
  for (const family of families) {
    const node = familyNodes.get(family.id)!;
    lines.push(`  subgraph ${node}["${escapeMermaid(`family: ${family.label}`)}"]`);
    for (const item of experiments.filter((candidate) => candidate.family_id === family.id)) {
      const label = family.label ? `${item.kind} ${item.idea_id}` : `${item.kind} ${item.idea_id}`;
      const detail = [item.commit ? item.commit.slice(0, 8) : item.label, metricText(item.metrics), item.decision]
        .filter(Boolean).join(" · ");
      lines.push(`    ${ids.get(item.id)}["${escapeMermaid(`${label} · ${detail}`)}"]`);
    }
    lines.push("  end");
    lines.push(`  P --> ${node}`);
  }
  for (const item of experiments) {
    if (item.parent_id) lines.push(`  ${ids.get(item.parent_id)} --> ${ids.get(item.id)}`);
  }
  lines.push("```", "");
  return lines.join("\n");
}

function dot(project: string, families: LedgerFamily[], experiments: LedgerExperiment[]): string {
  const ids = new Map(experiments.map((item, index) => [item.id, `N${index}`]));
  const lines = [
    "digraph ledger {",
    "  rankdir=LR;",
    "  graph [fontname=\"Helvetica\"];",
    "  node [shape=box, fontname=\"Helvetica\", fontsize=9];",
    `  P [label="${escapeDot(project)}", shape=ellipse];`,
  ];
  for (const family of families) {
    lines.push(`  subgraph cluster_${family.id.replace(/[^A-Za-z0-9_]/g, "_")} {`);
    lines.push(`    label="${escapeDot(`family: ${family.label}`)}";`);
    for (const item of experiments.filter((candidate) => candidate.family_id === family.id)) {
      const label = `${item.kind} ${item.idea_id}\\n${item.commit ? item.commit.slice(0, 8) : item.label}\\n${metricText(item.metrics)}\\n${item.decision}${item.selected ? " SELECTED" : ""}`;
      lines.push(`    ${ids.get(item.id)} [label="${escapeDot(label)}"];`);
    }
    lines.push("  }");
    lines.push(`  P -> cluster_${family.id.replace(/[^A-Za-z0-9_]/g, "_")} [style=dashed, arrowhead=none];`);
  }
  for (const item of experiments) {
    if (item.parent_id) lines.push(`  ${ids.get(item.parent_id)} -> ${ids.get(item.id)};`);
  }
  lines.push("}", "");
  return lines.join("\n");
}

function escapeMermaid(value: string): string {
  return value.replace(/"/g, "'").replace(/\n/g, " ");
}

function escapeDot(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function tree(project: string, families: LedgerFamily[], experiments: LedgerExperiment[]): string {
  const children = new Map<string, LedgerExperiment[]>();
  for (const item of experiments) {
    const parent = item.parent_id ?? `family:${item.family_id}`;
    const list = children.get(parent) ?? [];
    list.push(item);
    children.set(parent, list);
  }
  const lines = [project];
  const familyList = families;
  familyList.forEach((family, familyIndex) => {
    const lastFamily = familyIndex === familyList.length - 1;
    lines.push(`${lastFamily ? "└─" : "├─"} family ${family.label} [${family.id}]`);
    const roots = experiments.filter((item) => item.family_id === family.id && !item.parent_id);
    const render = (item: LedgerExperiment, prefix: string, last: boolean) => {
      const selected = item.selected ? " *selected*" : "";
      lines.push(`${prefix}${last ? "└─" : "├─"} ${item.kind} ${item.idea_id} · ${item.commit?.slice(0, 8) ?? item.label} · ${metricText(item.metrics)} · ${item.decision}${selected}`);
      const kids = children.get(item.id) ?? [];
      kids.forEach((child, index) => render(child, `${prefix}${last ? "   " : "│  "}`, index === kids.length - 1));
    };
    roots.forEach((root, index) => render(root, `${lastFamily ? "   " : "│  "}`, index === roots.length - 1));
  });
  return `${lines.join("\n")}\n`;
}

function markdown(snapshot: LedgerSnapshot): string {
  const lines = [
    `# Experiment ledger: ${snapshot.project}`,
    "",
    `Updated: \`${snapshot.updated_at}\``,
    "",
    `Families: ${snapshot.families.length}; experiments: ${snapshot.experiments.length}; runs: ${snapshot.runs.length}`,
    "",
    "| family | kind | idea | scope | metrics | decision | commit | run |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const item of snapshot.experiments) {
    lines.push(`| ${item.family_label} | ${item.kind} | ${item.idea_id} | ${item.scope} | ${metricText(item.metrics)} | ${item.decision}${item.selected ? " + selected" : ""} | ${item.commit?.slice(0, 10) ?? item.label} | ${item.run_ids.join(", ")} |`);
  }
  lines.push("", "## Graph", "", "See [`graph.md`](graph.md) and [`tree.txt`](tree.txt).", "");
  return lines.join("\n");
}

function writeIfChanged(file: string, content: string): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let previous: string | null = null;
  try { previous = fs.readFileSync(file, "utf8"); } catch { /* new file */ }
  if (previous === content) return false;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
  return true;
}

interface LineageNode {
  id: string;
  label: string;
  detail: string;
  kind: string;
  parent: string | null;
  family: string;
}

/** Org-chart input: project → model-definition family → experiments. */
function lineageNodes(project: string, families: LedgerFamily[], experiments: LedgerExperiment[]): LineageNode[] {
  const nodes: LineageNode[] = [{
    id: "project",
    label: project,
    detail: "RSI experiment lineage",
    kind: "root",
    parent: null,
    family: "",
  }];
  const familyNode = new Map<string, string>();
  for (const family of families) {
    const id = `family-${family.id}`;
    familyNode.set(family.id, id);
    nodes.push({
      id,
      label: family.label,
      detail: `${family.experiments} experiment${family.experiments === 1 ? "" : "s"} · same model definition`,
      kind: "family",
      parent: "project",
      family: family.id,
    });
  }
  for (const item of experiments) {
    const fallback = familyNode.get(item.family_id) ?? "project";
    const parent = item.kind === "baseline" ? fallback : item.parent_id ?? fallback;
    const label = item.kind === "baseline"
      ? `baseline ${item.scope} · ${item.commit?.slice(0, 8) ?? item.label}`
      : `${item.kind} ${item.idea_id}`;
    nodes.push({
      id: item.id,
      label,
      detail: `${metricText(item.metrics)} · ${item.decision}${item.selected ? " · SELECTED" : ""} · ${item.commit?.slice(0, 8) ?? item.label}`,
      kind: item.kind === "baseline" ? "baseline" : item.kind,
      parent,
      family: item.family_id,
    });
  }
  return nodes;
}

function renderLineage(ledgerDir: string, lineage: unknown): void {
  const jsonFile = path.join(ledgerDir, "lineage.json");
  const changed = writeIfChanged(jsonFile, `${JSON.stringify(lineage, null, 2)}
`);
  if (!changed || process.env.RSI_LEDGER_RENDER === "0") return;
  // Optional: PNG/SVG are generated only when matplotlib is available. The
  // JSON/Markdown/DOT files above remain the portable source of truth.
  const script = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "render_lineage.py");
  try {
    spawnSync("python3", [script, jsonFile, ledgerDir], { stdio: "ignore", timeout: 60000 });
  } catch {
    /* rendering is best effort; the ledger itself is durable */
  }
}

/** Rebuild the project ledger from all durable run states. */
export function refreshLedger(options: LedgerOptions): LedgerSnapshot {
  const projectRoot = path.resolve(options.projectRoot);
  const ledgerDir = options.ledgerDir
    ? path.resolve(options.ledgerDir)
    : process.env.RSI_LEDGER_DIR
      ? path.resolve(projectRoot, process.env.RSI_LEDGER_DIR)
      : path.join(projectRoot, "ledger");
  const runsRoots = [...new Set([
    ...(options.runsRoots ?? []),
    path.join(projectRoot, "runs"),
  ].map((item) => path.resolve(item)))];
  const runs = loadRuns(runsRoots);
  const pending: PendingExperiment[] = [];
  const runRows: LedgerRun[] = [];
  for (const run of runs) {
    const problem = run.problem as Problem;
    pending.push(...collectRun(run));
    const final = readJson(path.join(run.root, "final.json")) as Record<string, unknown> | null;
    const extra = record(record(final).extra);
    runRows.push({
      run_id: run.runId,
      root: run.root,
      problem: problem.id,
      updated_at: run.updatedAt,
      aborted: run.state.aborted === true,
      accepted: extra.accepted === true,
      decision_path: array(run.state.decision_path).map(String),
    });
  }
  const experiments = mergeExperiments(pending);
  const familyMap = new Map<string, LedgerFamily>();
  for (const item of experiments) {
    const family = familyMap.get(item.family_id) ?? {
      id: item.family_id,
      label: `${item.model_file ?? "default"}${item.model_blob ? ` @ ${item.model_blob.slice(0, 8)}` : ""}`,
      model_file: item.model_file,
      model_blob: item.model_blob,
      experiments: 0,
    };
    family.experiments += 1;
    familyMap.set(item.family_id, family);
    item.family_label = family.label;
  }
  resolveParents(experiments);
  const families = familyNodes(familyMap);
  const project = runs[0]?.problem.id ?? path.basename(projectRoot);
  const snapshot: LedgerSnapshot = {
    version: 1,
    project,
    updated_at: new Date().toISOString(),
    ledger_dir: ledgerDir,
    runs: runRows,
    families,
    experiments,
  };
  const jsonText = `${JSON.stringify(snapshot, null, 2)}\n`;
  const graphFamilies = families;
  writeIfChanged(path.join(ledgerDir, "ledger.json"), jsonText);
  writeIfChanged(path.join(ledgerDir, "experiments.jsonl"), experiments.map((item) => JSON.stringify(item)).join("\n") + (experiments.length ? "\n" : ""));
  writeIfChanged(path.join(ledgerDir, "ledger.md"), markdown(snapshot));
  writeIfChanged(path.join(ledgerDir, "graph.md"), mermaid(project, graphFamilies, experiments));
  writeIfChanged(path.join(ledgerDir, "graph.dot"), dot(project, graphFamilies, experiments));
  writeIfChanged(path.join(ledgerDir, "tree.txt"), tree(project, graphFamilies, experiments));
  const lineage = {
    version: 1,
    project,
    updated_at: snapshot.updated_at,
    layout: "org-chart tree; y=inheritance level; one primary parent; families are model-definition blobs",
    family_rule: "same model-definition file blob = same family; hyperparameter-only changes remain in the family",
    nodes: lineageNodes(project, graphFamilies, experiments),
    families,
    runs: runRows,
  };
  renderLineage(ledgerDir, lineage);
  return snapshot;
}

/** Refresh from an AgentContext; ledger errors must never break a run. */
export function refreshLedgerFromContext(ctx: AgentContext): void {
  try {
    const projectRoot = ctx.projectRoot ?? path.dirname(path.resolve(ctx.config.outDir));
    refreshLedger({ projectRoot, runsRoots: [ctx.config.outDir] });
  } catch {
    /* ledger is observable output, not a research gate */
  }
}
