import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { runDiagnosis, validateDiagnosis } from "../src/rsi/runtime/diagnosis.ts";
import { ArtifactStore } from "../src/rsi/runtime/store.ts";
import type { RemoteConfig, RepoRef } from "../src/rsi/types.ts";
import { makeProblem } from "../src/rsi/types.ts";
import { tempDir } from "./helpers.ts";

const findings = [
  { id: "d1", title: "precision loss", axis: "numerics", evidence: "overflow 3%", severity: 0.9, actionable: true, measured: true, metric: "overflow", value: 0.03 },
  { id: "d2", title: "long context", axis: "context", evidence: "unmeasured hypothesis", severity: 0.4, actionable: true, measured: false },
];

function problem(diagnose: string[] | null, remote: RemoteConfig | null = null) {
  return makeProblem({
    id: "diag",
    repo: tempDir("rsi-diag-target-"),
    repo_ref: "HEAD",
    diagnose_command: diagnose,
    remote,
    subset_datasets: ["small"],
    metrics: [],
  });
}

function repoOf(p: ReturnType<typeof problem>): RepoRef {
  return { path: p.repo!, repo: p.repo!, label: "baseline", parent: null, patch: "", commit: "abc1234" };
}

function script(dir: string, body: string): string {
  fs.writeFileSync(path.join(dir, "diag.py"), body, "utf8");
  return dir;
}

const writer = (value: unknown) => `import argparse, json, pathlib
p=argparse.ArgumentParser(); p.add_argument('--repo'); p.add_argument('--out', required=True); a=p.parse_args()
pathlib.Path(a.out).parent.mkdir(parents=True, exist_ok=True)
pathlib.Path(a.out).write_text(${JSON.stringify(JSON.stringify(value))})
print('measured baseline')
`;

test("local diagnosis validates and ranks measured findings", async () => {
  const p = problem(["{python}", "diag.py", "--out", "{out}"]);
  script(p.repo!, writer({ status: "ok", findings: [...findings].reverse() }));
  const store = new ArtifactStore(tempDir("rsi-diag-store-"));
  const result = await runDiagnosis(p, repoOf(p), store, { timeoutS: 30 });
  assert.equal(result.status, "ok", result.error);
  assert.deepEqual(result.findings.map((finding) => finding.id), ["d1", "d2"]);
  assert.equal(result.findings[0].measured, true);
  assert.ok(fs.existsSync(result.log_path));
  const provenance = fs.readdirSync(store.artifact("experiments")).filter((file) => /^diagnosis-\d+-[0-9a-f]+\.json$/.test(file));
  assert.equal(provenance.length, 1);
});

for (const [name, report, error] of [
  ["no measured finding", { status: "ok", findings: [{ ...findings[0], measured: false }] }, /no measured finding/],
  ["duplicate ids", { status: "ok", findings: [findings[0], findings[0]] }, /duplicate finding id/],
  ["empty evidence", { status: "ok", findings: [{ ...findings[0], evidence: " " }] }, /evidence is required/],
  ["severity out of range", { status: "ok", findings: [{ ...findings[0], severity: 1.5 }] }, /severity must be in/],
  ["non-finite value", { status: "ok", findings: [{ ...findings[0], value: null }] }, /value must be a finite number/],
  ["missing actionable", { status: "ok", findings: [{ ...findings[0], actionable: "yes" }] }, /actionable must be boolean/],
  ["failed status", { status: "failed", findings }, /status is not ok/],
  ["empty findings", { status: "ok", findings: [] }, /no findings/],
] as const) {
  test(`diagnosis rejects ${name}`, () => {
    assert.throws(() => validateDiagnosis(report), error);
  });
}

test("a diagnosis command that writes no report fails instead of reusing old output", async () => {
  const p = problem(["{python}", "diag.py", "--out", "{out}"]);
  script(p.repo!, "print('nothing written')\n");
  const result = await runDiagnosis(p, repoOf(p), new ArtifactStore(tempDir("rsi-diag-store-")), { timeoutS: 20 });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /ENOENT|no such file/);
  assert.match(result.stdout, /nothing written/);
});

test("non-zero diagnosis keeps bounded evidence", async () => {
  const p = problem(["{python}", "diag.py", "--out", "{out}"]);
  script(p.repo!, "import sys\nprint('analysis crashed')\nsys.exit(7)\n");
  const result = await runDiagnosis(p, repoOf(p), new ArtifactStore(tempDir("rsi-diag-store-")), { timeoutS: 20 });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /exited 7/);
  assert.match(result.stdout, /analysis crashed/);
});

test("diagnosis timeout kills the process group promptly", async () => {
  const p = problem(["{python}", "diag.py", "--out", "{out}"]);
  script(p.repo!, "import time\ntime.sleep(20)\n");
  const started = Date.now();
  const result = await runDiagnosis(p, repoOf(p), new ArtifactStore(tempDir("rsi-diag-store-")), { timeoutS: 0.4 });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /killed|exited/);
  assert.ok(Date.now() - started < 6000, `timeout returned after ${Date.now() - started}ms`);
});

test("remote diagnosis uses real rsync/SSH expansion, injects env/GPU and fetches findings", async () => {
  const remoteRoot = tempDir("rsi-diag-remote-");
  const p = problem(["{python}", "diag.py", "--repo", "{repo}", "--out", "{out}"]);
  script(p.repo!, writer({ status: "ok", findings }));
  const remote: RemoteConfig = {
    host: "mock-host", dir: remoteRoot, worktree: "", out: "", python: "python3",
    setup: "", ssh_args: [], rsync_args: [], gpu_ids: "2",
    env: { RSI_DIAG_MODE: "measure" }, timeout_s: 30, excludes: [],
  };
  p.remote = remote;
  const calls: string[] = [];
  const transport = async (binary: string, args: readonly string[], _opts: { timeoutS?: number }) => {
    calls.push(`${binary} ${args.join(" ")}`);
    const quote = (value: string) => value.replaceAll("'", "");
    if (binary === "rsync") {
      const src = args[args.length - 2];
      const dst = quote(args[args.length - 1].replace(/^[^:]*:/, ""));
      fs.mkdirSync(dst, { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
      return { code: 0, stdout: "", stderr: "", killed: false };
    }
    const last = args[args.length - 1];
    if (last.startsWith("mkdir -p ")) {
      for (const dir of last.slice("mkdir -p ".length).split(/\s+/)) fs.mkdirSync(quote(dir), { recursive: true });
      return { code: 0, stdout: "", stderr: "", killed: false };
    }
    if (last.startsWith("bash -lc ")) {
      const inner = last.slice("bash -lc ".length);
      const command = inner.startsWith("'") ? inner.slice(1, -1).replaceAll("'\\''", "'") : inner;
      const result = spawnSync("bash", ["-lc", command], { encoding: "utf8" });
      return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", killed: false };
    }
    if (last.startsWith("cat ")) {
      try { return { code: 0, stdout: fs.readFileSync(quote(last.slice(4)), "utf8"), stderr: "", killed: false }; }
      catch (error) { return { code: 1, stdout: "", stderr: String(error), killed: false }; }
    }
    return { code: 1, stdout: "", stderr: `unsupported ${last}`, killed: false };
  };
  const store = new ArtifactStore(tempDir("rsi-diag-store-"));
  const result = await runDiagnosis(p, repoOf(p), store, { timeoutS: 30, transport: transport as any });
  assert.equal(result.status, "ok", `${result.error}\nSTDOUT:${result.stdout}\nSTDERR:${result.stderr}`);
  assert.equal(result.findings.length, 2);
  assert.ok(calls.some((line) => line.startsWith("rsync -az --delete")));
  assert.ok(calls.some((line) => line.includes("CUDA_VISIBLE_DEVICES=2")));
  assert.ok(calls.some((line) => line.includes("RSI_DIAG_MODE=measure")));
  assert.ok(calls.some((line) => line.startsWith("ssh") && line.includes(" -- cat ")));
  const bashCall = calls.find((line) => line.includes("bash -lc "));
  assert.ok(bashCall, "remote diagnosis must execute through SSH");
  assert.match(bashCall!, /--repo '?.*\/rsi\/diag-[^' ]+\/worktree'?/);
  assert.ok(!bashCall!.includes(p.repo!), "remote diagnosis must not expand {repo} to the local worktree");
  const raw = fs.readFileSync(path.join(store.root, "artifacts", "experiments", fs.readdirSync(store.artifact("experiments")).find((file) => file.endsWith(".raw.json"))!), "utf8");
  assert.match(raw, /precision loss/);
});

test("remote diagnosis failure writes the local log with remote stderr", async () => {
  const p = problem(["{python}", "diag.py", "--repo", "{repo}", "--out", "{out}"]);
  script(p.repo!, writer({ status: "ok", findings }));
  const remote: RemoteConfig = {
    host: "mock-host", dir: tempDir("rsi-diag-remote-fail-"), worktree: "", out: "", python: "python3",
    setup: "", ssh_args: [], rsync_args: [], gpu_ids: "0",
    env: {}, timeout_s: 30, excludes: [],
  };
  p.remote = remote;
  const transport = async (binary: string, args: readonly string[], _opts: { timeoutS?: number }) => {
    if (binary === "rsync") return { code: 0, stdout: "", stderr: "", killed: false };
    const last = args[args.length - 1];
    if (last.startsWith("mkdir -p ")) return { code: 0, stdout: "", stderr: "", killed: false };
    if (last.startsWith("bash -lc ")) {
      return { code: 1, stdout: "remote stdout", stderr: "remote stderr detail", killed: false };
    }
    return { code: 1, stdout: "", stderr: `unsupported ${last}`, killed: false };
  };
  const store = new ArtifactStore(tempDir("rsi-diag-store-"));
  const result = await runDiagnosis(p, repoOf(p), store, { timeoutS: 30, transport: transport as any });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /remote diagnosis exited 1/);
  assert.ok(fs.existsSync(result.log_path), "failure log must exist locally");
  const log = fs.readFileSync(result.log_path, "utf8");
  assert.match(log, /remote stderr detail/);
  assert.match(log, /remote stdout/);
});

test("diagnosis without a declared command is a usage error", async () => {
  const p = problem(null);
  await assert.rejects(runDiagnosis(p, repoOf(p), new ArtifactStore(tempDir("rsi-diag-store-")), { timeoutS: 10 }), /diagnose_command is required/);
});
