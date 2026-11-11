import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { SimulatedRunner, SubprocessRunner } from "../src/rsi/runtime/workspace.ts";
import { ArtifactStore } from "../src/rsi/runtime/store.ts";
import { defaultConfig } from "../src/rsi/config.ts";
import type { ExperimentRequest } from "../src/rsi/runtime/workspace.ts";
import { loadProblem } from "../src/rsi/run.ts";
import { makeIdea } from "../src/rsi/types.ts";
import { fixture, tempDir } from "./helpers.ts";

function request(root: string, ideaId = "h1"): { req: ExperimentRequest; store: ArtifactStore } {
  const problem = loadProblem(fixture("ood_frozen_encoder"));
  const store = new ArtifactStore(root);
  return {
    store,
    req: {
      idea_id: ideaId,
      scope: "subset",
      repo: { path: root, label: "baseline", parent: null, patch: "" },
      datasets: ["cifar10"],
      metrics: problem.metrics.map((metric) => metric.name),
      idea: makeIdea({ id: ideaId, hypothesis: "h", mechanism: "spectral prior", domain_fit: 0.8 }),
      label: "baseline",
    },
  };
}

test("simulated runner is deterministic and respects metric bounds", async () => {
  const problem = loadProblem(fixture("ood_frozen_encoder"));
  const config = defaultConfig();
  const root = tempDir("rsi-sim-");
  const runner = new SimulatedRunner(problem, config, root);
  const first = await runner.run(request(root).req);
  const second = await runner.run(request(root).req);
  assert.deepEqual(first.metrics, second.metrics);
  assert.equal(first.status, "ok");
  for (const [name, value] of Object.entries(first.metrics)) {
    const spec = problem.metrics.find((metric) => metric.name === name);
    if (spec?.bounds) {
      assert.ok(value > spec.bounds[0] && value < spec.bounds[1], `${name}=${value}`);
    }
  }
});

test("subprocess failures are data, not exceptions", async () => {
  const root = tempDir("rsi-subprocess-");
  const runner = new SubprocessRunner(root, { timeoutS: 5 });
  const result = await runner.run(request(root).req);
  assert.equal(result.status, "failed");
  assert.ok(result.stderr.length > 0);
});

test("subprocess runner executes a benchmark and parses metrics", async () => {
  const root = tempDir("rsi-subprocess-ok-");
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(
    path.join(repo, "run_experiment.py"),
    [
      "import argparse, json",
      "from pathlib import Path",
      "p = argparse.ArgumentParser()",
      "p.add_argument('--scope')",
      "p.add_argument('--out')",
      "args = p.parse_args()",
      "Path(args.out).write_text(json.dumps({'metrics': {'auroc': 0.91}}))",
      "",
    ].join("\n"),
    "utf8",
  );
  const runner = new SubprocessRunner(root, { timeoutS: 20 });
  const req = request(root).req;
  req.repo = { path: repo, label: "baseline", parent: null, patch: "" };
  const result = await runner.run(req);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.metrics, { auroc: 0.91 });
});
