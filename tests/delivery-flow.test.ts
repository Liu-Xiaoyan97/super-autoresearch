import test from "node:test";
import assert from "node:assert/strict";
import { checkRejection } from "../src/rsi/agents/coding.ts";
import { Orchestrator } from "../src/rsi/core/orchestrator.ts";
import { ResearchState } from "../src/rsi/core/state.ts";
import { GitWorkspace } from "../src/rsi/runtime/workspace.ts";
import { makeCheckpoint, makeEvidence, makeIdea, makeIntegrity, makeManuscript, makeReview, makeTrace, makeVerdict } from "../src/rsi/types.ts";
import { makeContext } from "./helpers.ts";

function verificationContext() {
  const ctx = makeContext({ config: { runner: "subprocess" } });
  ctx.workspace.reviewSources = undefined;
  ctx.workspace.diff = async () => "candidate implementation diff";
  ctx.workspace.brief = () => "model.py: transform(x) returns a tensor through the requested mechanism.";
  return ctx;
}

function evidence(commit = "candidate", scope: "subset" | "full" = "full") {
  const result = { status: "ok" as const, metrics: { auroc: 0.95 }, stdout: "", stderr: "", wall_time_s: 0, log_path: "" };
  return makeEvidence({ idea_id: "idea", scope, metrics: result.metrics,
    code: { path: "target", commit, parent: "base", patch: "patch", label: commit },
    result, samples: scope === "subset" ? [{ seed: 7, metrics: result.metrics, result }] : [] });
}

function orchestrator() {
  const ctx = makeContext();
  const o = new Orchestrator(ctx);
  // These tests inspect the state machine independently of the project ledger.
  (o as any).persist = () => {};
  o.state.bestIdea = makeIdea({ id: "idea" });
  o.state.bestEvidence = evidence();
  o.state.bestCode = o.state.bestEvidence.code;
  o.state.bestSubset = evidence("candidate", "subset");
  return o;
}

test("module rejection prevents target checks and experiment delivery", async () => {
  const ctx = verificationContext();
  (ctx.llm as any).script = { ...(ctx.llm as any).script, "code.verify": { decision: "engineer", modules: [], findings: ["forward does not call the new module"] } };
  let checks = 0;
  ctx.workspace.check = async () => { checks++; throw new Error("must not run"); };
  const candidate = evidence();
  const failure = await checkRejection(ctx, makeIdea({ id: "idea" }), "subset", candidate, candidate.code!, "candidate");
  assert.equal(checks, 0);
  assert.match(failure!.result!.stderr, /forward does not call/);
});

test("repair evidence carries required stdout and traceback", async () => {
  const ctx = verificationContext();
  ctx.workspace.check = async () => ({ commit: "candidate", parent: "base", languages: ["python"], changed_files: ["model.py"], status: "failed", checks: [
    { id: "style", command: [], status: "failed", severity: "advisory", exit_code: 1, stdout: "style noise", stderr: "", duration_s: 0 },
    { id: "tests", command: [], status: "failed", severity: "required", exit_code: 1, stdout: "Traceback: tensor dimensions 2 and 16", stderr: "", duration_s: 0 },
  ] });
  const candidate = evidence();
  const failure = await checkRejection(ctx, makeIdea({ id: "idea" }), "subset", candidate, candidate.code!, "candidate");
  assert.match(failure!.result!.stderr, /tensor dimensions 2 and 16/);
  assert.doesNotMatch(failure!.result!.stderr, /style noise/);
});

test("cancellation propagates out of candidate checks", async () => {
  const ctx = verificationContext();
  ctx.workspace.check = async () => { throw new DOMException("stop", "AbortError"); };
  const candidate = evidence();
  await assert.rejects(checkRejection(ctx, makeIdea(), "subset", candidate, candidate.code!, "candidate"), { name: "AbortError" });
});

test("engineering revisions retain the root search identity", () => {
  const ctx = makeContext();
  const state = new ResearchState(ctx.problem, ctx.config);
  state.seeds = [makeIdea({ id: "seed" })];
  state.record(makeTrace({ seed_id: "seed", idea: makeIdea({ id: "seed-eng", parent_ids: ["seed"] }), decision: "good" }));
  assert.equal(state.nextSeeds(1).length, 0);
  assert.equal(state.evaluatedIds.has("seed"), true);
});

test("audit reference, attribution and report identity survive restore", () => {
  const o = orchestrator();
  o.state.auditBaseline = { ...o.state.bestCode!, commit: "original" };
  o.state.specReports.idea = { commit: "candidate", report: makeIntegrity({ score_verified: false }) };
  o.state.ablationCommit = "candidate";
  o.state.manuscriptCommit = "candidate";
  const restored = ResearchState.fromDict(o.ctx.problem, o.ctx.config, o.state.toDict());
  assert.equal(restored.auditBaseline?.commit, "original");
  assert.equal(restored.specReports.idea.report.score_verified, false);
  assert.equal(restored.ablationCommit, "candidate");
  assert.equal(restored.manuscriptCommit, "candidate");
});

test("new incumbent re-plans ablation instead of reusing old results", async () => {
  const o = orchestrator();
  o.state.ablationCommit = "old";
  o.state.ablationPlans = [{ id: "old-plan", component: "old", variant_of: "old", description: "", expects: "" }];
  o.state.ablations = [{ plan_id: "old-plan", component: "old", metrics: {}, ok: true, evidence: evidence("old") }];
  let plans = 0, runs = 0;
  o.agents.ablationPlanner.plan = async () => { plans++; return [{ id: "new-plan", component: "new", variant_of: "idea", description: "", expects: "" }]; };
  o.agents.ablationCoder.runPlan = async () => { runs++; return { plan_id: "new-plan", component: "new", metrics: {}, ok: true, evidence: evidence() }; };
  o.agents.ablationCritic.judge = async () => makeVerdict({ decision: "good" });
  await (o as any).ablations();
  assert.equal(plans, 1);
  assert.equal(runs, 1);
  assert.equal(o.state.ablations[0].plan_id, "new-plan");
});

test("bad attribution blocks final acceptance", async () => {
  const o = orchestrator();
  o.state.review = makeReview({ score: 10 });
  o.state.reviews = Array.from({ length: o.ctx.config.reviewPanelSize }, () => makeReview({ score: 10 }));
  o.state.metaReview = { decision: "accept", critique: "", score: 10, round: 0 };
  o.state.manuscript = makeManuscript();
  o.state.manuscriptCommit = "candidate";
  o.state.ablationCommit = "candidate";
  o.state.ablationVerdict = makeVerdict({ decision: "bad" });
  (o as any).exportIntegrity = async () => makeIntegrity({ score_verified: true, method_code_alignment: 1 });
  assert.equal((await (o as any).exportArtifacts()).extra.accepted, false);
});

test("meta attribution failure stops before drafting", async () => {
  const o = orchestrator();
  o.ctx.config.maxMetaRounds = 1;
  o.state.manuscript = makeManuscript();
  o.state.review = makeReview({ score: 10 });
  o.agents.metaReviewer.decide = async () => ({ decision: "refine", critique: "fix", score: 10, round: 0 });
  o.agents.fullSetEngineer.refine = async () => ({ idea: o.state.bestIdea!, evidence: evidence("revised") });
  (o as any).adopt = async () => true;
  (o as any).ablations = async () => { o.state.ablationVerdict = makeVerdict({ decision: "bad" }); };
  let drafts = 0;
  (o as any).draftAndReview = async () => { drafts++; };
  await assert.rejects((o as any).metaReview(), /data_gate_not_met/);
  assert.equal(drafts, 0);
});

test("resume continues a rejected paper", async () => {
  const o = orchestrator();
  o.ctx.config.minGoodTraces = 1;
  o.state.seeds = [o.state.bestIdea!];
  o.state.searchDone = true;
  o.state.decisionPath = ["limits.ok"];
  o.state.traces = [makeTrace({ idea: o.state.bestIdea!, decision: "good", evidence: [evidence()] })];
  o.state.manuscript = makeManuscript();
  o.state.manuscriptCommit = "candidate";
  o.state.review = makeReview({ score: 3 });
  o.state.metaReview = { decision: "refine", critique: "pending", score: 3, round: 0 };
  o.state.ablationCommit = "candidate";
  o.state.ablationVerdict = makeVerdict({ decision: "good" });
  o.state.ablations = [{ plan_id: "p", component: "c", metrics: {}, ok: true, evidence: evidence() }];
  (o as any).baseline = async () => {};
  (o as any).exportArtifacts = async () => ({});
  let calls = 0;
  (o as any).paperLoop = async () => { calls++; };
  await o.run({ resume: true });
  assert.equal(calls, 1, JSON.stringify({ aborted: o.state.aborted, reason: o.state.abortReason, path: o.state.decisionPath }));
});

test("missing spec report triggers a new audit after resume", async () => {
  const o = orchestrator();
  let audits = 0;
  o.agents.specAuditor.audit = async () => { audits++; return makeIntegrity({ score_verified: false }); };
  const report = await (o as any).exportIntegrity();
  assert.equal(audits, 1);
  assert.equal(report.score_verified, false);
  assert.equal(o.state.specReports.idea.commit, "candidate");
});

test("method audit uses the immutable reference after baseline promotion", async () => {
  const o = orchestrator();
  o.state.auditBaseline = { ...o.state.bestCode!, commit: "original" };
  o.state.baseline = evidence("candidate", "subset");
  o.state.manuscript = makeManuscript();
  o.state.specReports.idea = { commit: "candidate", report: makeIntegrity({ score_verified: true }) };
  let reference = "";
  o.ctx.workspace.diff = async (a) => { reference = a.commit!; return "diff"; };
  o.agents.referenceAuditor.audit = async () => makeIntegrity({ score_verified: true });
  o.agents.methodCodeAuditor.audit = async () => makeIntegrity({ score_verified: true });
  await (o as any).exportIntegrity();
  assert.equal(reference, "original");
});

test("subset and ablation use identical dataset lists", async () => {
  const ctx = makeContext();
  ctx.problem.subset_datasets = ["screen"];
  ctx.problem.datasets = ["screen", "holdout"];
  const datasets: string[][] = [];
  const workspace = new GitWorkspace(ctx.problem, ctx.config, ctx.store.root, { run: async (request) => {
    datasets.push(request.datasets);
    return { status: "ok", metrics: { auroc: 0.9 }, stdout: "", stderr: "", log_path: "", wall_time_s: 0 };
  } });
  const repo = await workspace.baselineRepo();
  await workspace.run(repo, "subset");
  await workspace.run(repo, "ablation");
  assert.deepEqual(datasets, [["screen"], ["screen"]]);
});

test("invalid seed execution stops before scheduling more seeds", async () => {
  const { runSeeded } = await import("../src/rsi/agents/coding.ts");
  let calls = 0;
  const measured = await runSeeded({ run: async () => {
    calls++;
    return { status: "failed" as const, metrics: {}, stdout: "", stderr: "invalid shape", wall_time_s: 0, log_path: "" };
  } }, {}, null, [7, 8, 9], () => {});
  assert.equal(calls, 1);
  assert.equal(measured.samples[0].result?.status, "failed");
});

test("module audit cache avoids a duplicate model call", async () => {
  const { ImplementationVerifier } = await import("../src/rsi/agents/coding.ts");
  const ctx = verificationContext();
  const verifier = new ImplementationVerifier(ctx);
  const idea = makeIdea({ id: "idea" });
  const repo = evidence().code!;
  await verifier.verify(idea, repo, "subset");
  await verifier.verify(idea, repo, "subset");
  await verifier.verify(idea, { ...repo, patch: "" }, "full");
  assert.equal((ctx.llm as any).count("code.verify"), 1);
});

test("module review requires committed source before asking a model", async () => {
  const { ImplementationVerifier } = await import("../src/rsi/agents/coding.ts");
  const ctx = verificationContext();
  ctx.workspace.brief = () => "";
  const result = await new ImplementationVerifier(ctx).verify(makeIdea(), evidence().code!, "subset");
  assert.equal(result.decision, "engineer");
  assert.equal((ctx.llm as any).count("code.verify"), 0);
});

test("a failed control seed blocks component attribution", async () => {
  const o = orchestrator();
  o.state.bestSubset = null;
  let calls = 0;
  o.ctx.workspace.run = async () => ({ status: ++calls === 1 ? "ok" : "failed", metrics: { auroc: 0.95 }, stdout: "", stderr: "shape failure", log_path: "", wall_time_s: 0 });
  await assert.rejects((o as any).incumbentSubset(o.state.bestIdea, o.state.bestEvidence), /data_gate_not_met/);
  assert.equal(calls, 2);
  assert.equal(o.state.bestSubset, null);
});

test("module review covers complete source and requires immutable independent tests", async () => {
  const { ImplementationVerifier } = await import("../src/rsi/agents/coding.ts");
  const ctx = verificationContext();
  ctx.workspace.reviewSources = () => [
    { path: "model.py", text: "source".repeat(6000) + "FINAL_SOURCE_MARKER", trustedTest: false },
    { path: "tests/test_model.py", text: "def test_forward(): assert forward(1) == 2", trustedTest: true },
  ];
  const requests: string[] = [];
  ctx.llm.structured = async (request, spec) => {
    requests.push(request.user);
    return spec.parse({ decision: "good", modules: ["model.py:forward implements mechanism"],
      tests: ["tests/test_model.py:test_forward validates mechanism and entry point"], findings: [] });
  };
  const audit = await new ImplementationVerifier(ctx).verify(makeIdea(), evidence().code!, "subset");
  assert.equal(audit.decision, "good");
  assert.ok(requests.some((request) => request.includes("FINAL_SOURCE_MARKER")));
  ctx.workspace.reviewSources = () => [{ path: "model.py", text: "assert forward(1) == 2", trustedTest: false }];
  const rejected = await new ImplementationVerifier(ctx).verify(makeIdea(), evidence("other").code!, "subset");
  assert.equal(rejected.decision, "engineer");
  assert.match(rejected.test_gaps.join(" "), /untrusted/);
});

test("resume validates scientific protocol while allowing runtime budget changes", () => {
  const ctx = makeContext();
  const state = new ResearchState(ctx.problem, ctx.config);
  const snapshot = state.toDict();
  assert.throws(() => ResearchState.fromDict({ ...ctx.problem, datasets: ["changed"] }, ctx.config, snapshot), /protocol differs/);
  assert.throws(() => ResearchState.fromDict(ctx.problem, { ...ctx.config, subsetSeeds: 99 }, snapshot), /protocol differs/);
  assert.doesNotThrow(() => ResearchState.fromDict(ctx.problem, { ...ctx.config, maxLlmCalls: 9999 }, snapshot));
  assert.throws(() => ResearchState.fromDict(ctx.problem, ctx.config, { ...snapshot, state_version: 99 }), /unsupported/);
  assert.throws(() => ResearchState.fromDict({ ...ctx.problem, diagnose_command: ["python", "other.py"] }, ctx.config, snapshot), /protocol differs/);
  assert.throws(() => ResearchState.fromDict({ ...ctx.problem, remote: { env: { CONTEXT: "2048" } } as any }, ctx.config, snapshot), /protocol differs/);
});

test("legacy candidate evidence is retired while baseline and history survive", () => {
  const ctx = makeContext({ config: { runner: "subprocess" } });
  const state = new ResearchState(ctx.problem, ctx.config);
  const candidate = evidence();
  const idea = makeIdea({ id: "idea" });
  state.baseline = makeEvidence({ idea_id: "baseline", code: { ...candidate.code!, parent: null }, metrics: { auroc: 0.5 } });
  state.adopt(idea, candidate);
  state.record(makeTrace({ idea, decision: "good", evidence: [candidate] }));
  state.searchDone = true;
  const restored = ResearchState.fromDict(ctx.problem, ctx.config, state.toDict());
  assert.equal(restored.bestEvidence, null);
  assert.equal(restored.traces.length, 1);
  assert.equal(restored.traces[0].invalid, true);
  assert.equal(restored.evaluatedIds.has("idea"), false);
  assert.ok(restored.baseline);
  assert.equal(restored.searchDone, false);
});

test("each persisted candidate checks its own environment before evidence reuse", () => {
  const ctx = makeContext({ config: { runner: "subprocess" } });
  const state = new ResearchState(ctx.problem, ctx.config);
  const one = evidence("one"), two = evidence("two");
  one.code!.check_environment = "python-env";
  two.code!.check_environment = "native-env";
  state.record(makeTrace({ idea: makeIdea({ id: "one" }), decision: "good", evidence: [one] }));
  state.record(makeTrace({ idea: makeIdea({ id: "two" }), decision: "good", evidence: [two] }));
  const restored = ResearchState.fromDict(ctx.problem, ctx.config, state.toDict());
  assert.equal(restored.invalidateCandidateEnvironment(new Map([["one", "python-env"], ["two", "native-env"]])), 0);
  assert.equal(restored.invalidateCandidateEnvironment(new Map([["one", "python-env"], ["two", "changed-env"]])), 1);
  assert.equal(restored.goodTraces().length, 1);
  assert.equal(restored.goodTraces()[0].idea.id, "one");
  restored.record(makeTrace({ idea: makeIdea({ id: "two" }), decision: "good", evidence: [{ ...two, code: { ...two.code!, check_environment: "changed-env" } }] }));
  restored.invalidateCandidateEnvironment(new Map([["one", "python-env"], ["two", "changed-env"]]));
  assert.equal(restored.evaluatedIds.has("two"), true);
});

test("environment retirement preserves completed seeds in either trace order and after restore", () => {
  for (const reverse of [false, true]) {
    for (const decision of ["good", "bad"] as const) {
      const ctx = makeContext({ config: { runner: "subprocess" } });
      const state = new ResearchState(ctx.problem, ctx.config);
      state.seeds = [makeIdea({ id: "root" }), makeIdea({ id: "retry" })];
      const old = evidence("old"), current = evidence("current"), retry = evidence("retry");
      old.code!.check_environment = "old-env";
      current.code!.check_environment = "current-env";
      const traces = [
        makeTrace({ seed_id: "root", idea: makeIdea({ id: "old" }), decision: "good", evidence: [old] }),
        makeTrace({ seed_id: "root", idea: makeIdea({ id: "current" }), decision, evidence: [current] }),
      ];
      for (const trace of reverse ? traces.reverse() : traces) state.record(trace);
      state.record(makeTrace({ seed_id: "retry", idea: makeIdea({ id: "retry" }), decision: "good", evidence: [retry] }));
      state.checkpoint(makeCheckpoint({ idea_id: "root", trace: makeTrace({ seed_id: "root", evidence: [old] }) }));
      const environments = new Map([["old", "changed-env"], ["current", "current-env"]]);
      state.invalidateCandidateEnvironment(environments);
      for (const restored of [state, ResearchState.fromDict(ctx.problem, ctx.config, JSON.parse(JSON.stringify(state.toDict())))]) {
        restored.invalidateCandidateEnvironment(environments);
        assert.equal(restored.evaluatedIds.has("root"), true);
        assert.equal(restored.evaluatedIds.has("current"), true);
        assert.equal(restored.evaluatedIds.has("old"), false);
        assert.equal(restored.checkpointFor("root"), null);
        assert.deepEqual(restored.nextSeeds(2).map((idea) => idea.id), ["retry"]);
        assert.equal(restored.traces.filter((trace) => !trace.invalid).length, 1);
      }
    }
  }
});

test("normal resume retires changed-environment evidence before continuing research", async () => {
  const o = orchestrator();
  o.ctx.config.runner = "subprocess";
  o.state.bestCode!.check_environment = "old-env";
  o.state.bestSubset!.code!.check_environment = "old-env";
  o.state.record(makeTrace({ idea: o.state.bestIdea!, decision: "good", evidence: [o.state.bestEvidence!] }));
  o.ctx.workspace.preflight = async () => ({ commit: "base", parent: null, languages: ["python"], changed_files: [],
    status: "ok", checks: [], environment_fingerprint: "startup-env" });
  let checks = 0;
  o.ctx.workspace.check = async () => {
    checks++;
    return { commit: "candidate", parent: "base", languages: ["python"], changed_files: [], status: "ok", checks: [], environment_fingerprint: "new-env" };
  };
  (o as any).baseline = async () => {};
  (o as any).limitations = async () => {};
  (o as any).seedIdeas = async () => {};
  (o as any).ideaSearchWithReseeding = async () => {
    assert.equal(o.state.bestEvidence, null);
    assert.equal(o.state.goodTraces().length, 0);
    throw new DOMException("audit complete", "AbortError");
  };
  (o as any).exportArtifacts = async () => ({});
  await o.run({ resume: true });
  assert.equal(checks, 1);
  assert.equal(o.state.traces[0].invalid, true);
});

test("ablation plans require committed component evidence and never synthesize fillers", async () => {
  const { AblationPlanner } = await import("../src/rsi/agents/ablation.ts");
  const ctx = verificationContext();
  ctx.workspace.reviewSources = () => [{ path: "model.py", text: "def align(x): return x", trustedTest: false }];
  (ctx.llm as any).script = { "ablation.plan": { plans: [
    { id: "real", component: "alignment", code_refs: ["model.py:align"], description: "Remove alignment.", expects: "Score decreases.", variant_of: "idea" },
    { id: "fake", component: "invented", code_refs: ["missing.py:fake"], description: "Remove fake.", expects: "Score decreases.", variant_of: "idea" },
  ], hypothesis: "Component evidence." } };
  const plans = await new AblationPlanner(ctx).plan(makeIdea({ id: "idea" }), { best: evidence(), n: 5 });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].component, "alignment");
  assert.deepEqual(plans[0].code_refs, ["model.py:align"]);
  assert.match(plans[0].description, /subset/);
});

test("delivery rejects reviewed assertions absent from the execution report", async () => {
  const ctx = verificationContext();
  (ctx.llm as any).script = { "code.verify": { decision: "good", modules: ["model.py:forward"],
    tests: ["tests/test_model.py:test_forward verifies entry point"], findings: [] } };
  ctx.workspace.check = async () => ({ commit: "candidate", parent: "base", languages: ["python"], changed_files: ["model.py"], status: "ok", checks: [
    { id: "tests", command: [], status: "ok", severity: "required", exit_code: 0, stdout: "", stderr: "", duration_s: 0,
      executed_tests: ["tests/test_other.py:test_other"] },
  ] });
  const base = evidence();
  const failure = await checkRejection(ctx, makeIdea(), "subset", base, base.code!, "assertion-mismatch");
  assert.match(failure!.result!.stderr, /did not execute/);
});

test("delivery matches file and class identities without accepting name prefixes", async () => {
  const ctx = verificationContext();
  (ctx.llm as any).script = { "code.verify": { decision: "good", modules: ["model.py:forward"],
    tests: ["tests/test_model.py::TestModel::test_step checks the update"], findings: [] } };
  let executed = ["tests/test_model.py::TestModel::test_step_disabled", "tests/test_other.py::TestModel::test_step"];
  ctx.workspace.check = async () => ({ commit: "candidate", parent: "base", environment_fingerprint: "test-env", languages: ["python"], changed_files: ["model.py"], status: "ok", checks: [
    { id: "tests", command: [], status: "ok", severity: "required", kind: "test", exit_code: 0, stdout: "", stderr: "", duration_s: 0,
      executed_tests: executed },
  ] });
  const candidate = evidence();
  const failure = await checkRejection(ctx, makeIdea(), "subset", candidate, candidate.code!, "prefix-mismatch");
  assert.match(failure!.result!.stderr, /did not execute/);
  executed = ["tests/test_model.py::TestModel::test_step[param]"];
  assert.equal(await checkRejection(ctx, makeIdea(), "subset", candidate, candidate.code!, "exact-match"), null);
  executed = [];
  const absent = await checkRejection(ctx, makeIdea(), "subset", candidate, candidate.code!, "missing-report");
  assert.match(absent!.result!.stderr, /no execution evidence/);
});

test("startup failure stops before any model or experiment call", async () => {
  const o = orchestrator();
  o.ctx.config.runner = "subprocess";
  o.ctx.workspace.preflight = async () => ({ commit: "base", parent: null, languages: ["python"], changed_files: [], status: "failed", checks: [] });
  let calls = 0;
  (o as any).baseline = async () => { calls++; };
  (o as any).limitations = async () => { calls++; };
  (o as any).exportArtifacts = async (interrupted: boolean) => ({ interrupted });
  const final = await o.run();
  assert.equal(calls, 0);
  assert.equal(o.state.abortReason, "check_environment_unavailable");
  assert.deepEqual(final, { interrupted: true });
});
