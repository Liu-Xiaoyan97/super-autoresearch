import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SubprocessRunner, type ExperimentRequest } from "../src/rsi/runtime/workspace.ts";
import { PiLLMProvider } from "../src/rsi/providers/pi.ts";
import type { LLMRequest } from "../src/rsi/providers/base.ts";
import { tempDir } from "./helpers.ts";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const request: LLMRequest = { task: "test", system: "test only", user: "test only", temperature: 0, maxTokens: 10, provider: "test", model: "test-model", meta: {} };
const model = { provider: "test", id: "test-model", maxTokens: 10 };

test("local cancellation kills an ignoring process group before returning, without late success artifacts", async () => {
  const root = tempDir("rsi-local-cancel-");
  const childMarker = path.join(root, "late-child.txt");
  const script = path.join(root, "run.py");
  const ready = path.join(root, "started.txt");
  // Real sleeping OS processes, but no model, training, SSH or scientific result.
  // Supply the child path as argv, avoiding nested-language quoting ambiguity.
  fs.writeFileSync(script, `import argparse,json,signal,subprocess,sys,time
from pathlib import Path
p=argparse.ArgumentParser(); p.add_argument('--out'); a=p.parse_args()
signal.signal(signal.SIGTERM, signal.SIG_IGN)
subprocess.Popen([sys.executable,'-c',"import signal,time,sys; from pathlib import Path; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(1.5); Path(sys.argv[1]).write_text('must not happen')",${JSON.stringify(childMarker)}])
Path(${JSON.stringify(ready)}).write_text('child spawned')
time.sleep(1.5)
Path(a.out).write_text(json.dumps({'metrics': {'score': 1}}))
`);
  const runner = new SubprocessRunner(root, { command: ["python3", script, "--out", "{out}"], timeoutS: 10, signal: AbortSignal.timeout(300) });
  const req: ExperimentRequest = { idea_id: "baseline", scope: "subset", label: "baseline", idea: null, datasets: [], metrics: ["score"], repo: { path: root, label: "baseline", parent: null, patch: "" } };
  const started = Date.now();
  const result = await runner.run(req);
  assert.equal(result.status, "failed");
  assert.equal(fs.existsSync(ready), true, "the process and its child must really have launched");
  assert.match(result.stderr, /Timeout|abort/i);
  assert.ok(Date.now() - started < 1400, "must kill before delayed success");
  await pause(1600);
  assert.equal(fs.existsSync(childMarker), false);
  assert.equal(fs.existsSync(result.log_path), false);
});

test("request deadline cancels Pi provider retry delay and prevents a later registry call", async () => {
  let calls = 0;
  const provider = new PiLLMProvider({ registry: {
    find: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true,
    complete: async () => { calls++; throw new Error("temporary test error"); },
  } });
  await assert.rejects(provider.complete({ ...request, signal: AbortSignal.timeout(80) }), /Timeout|abort/i);
  await pause(850);
  assert.equal(calls, 1);
});

test("request deadline and session cancellation are both passed to registry work", async () => {
  const session = new AbortController();
  const requestAbort = new AbortController();
  const deadline = requestAbort.signal;
  const timer = setTimeout(() => requestAbort.abort(new DOMException("test deadline", "TimeoutError")), 80);
  let seen: AbortSignal | undefined;
  const provider = new PiLLMProvider({ signal: session.signal, registry: {
    find: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true,
    complete: async (_model, _context, options) => {
      seen = options?.signal as AbortSignal;
      return new Promise((_resolve, reject) => seen!.addEventListener("abort", () => reject(seen!.reason), { once: true }));
    },
  } });
  try {
    await assert.rejects(provider.complete({ ...request, signal: deadline }), /Timeout|abort|deadline/i);
  } finally { clearTimeout(timer); }
  assert.equal(seen?.aborted, true);
  assert.equal(deadline.aborted, true);
  assert.equal(session.signal.aborted, false);
});
