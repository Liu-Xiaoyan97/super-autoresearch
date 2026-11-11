import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ArtifactStore } from "../src/rsi/runtime/store.ts";
import { RemoteRunner } from "../src/rsi/runtime/workspace.ts";
import type { ExperimentRequest } from "../src/rsi/runtime/workspace.ts";
import type { RemoteConfig } from "../src/rsi/types.ts";
import { tempDir } from "./helpers.ts";

/** Fake ssh/rsync that execute against the local filesystem. */
function fakeRemoteBin(): string {
  const bin = tempDir("rsi-fakebin-");
  const rsync = `#!/usr/bin/env bash
set -euo pipefail
args=("$@")
src="\${args[\${#args[@]}-2]}"
dst="\${args[\${#args[@]}-1]}"
dst="\${dst#*:}"
dst="\${dst//\\'/}"
mkdir -p "$dst"
cp -a "$src"/. "$dst"/
`;
  const ssh = `#!/usr/bin/env bash
set -euo pipefail
for last in "$@"; do :; done
case "$last" in
  mkdir\\ -p\\ *) eval "$last" ;;
  cat\\ *) eval "$last" ;;
  bash\\ -lc\\ *) inner="\${last#bash -lc }"; eval "bash -lc $inner" ;;
  *) echo "fake ssh: unsupported command: $last" >&2; exit 2 ;;
esac
`;
  fs.writeFileSync(path.join(bin, "rsync"), rsync, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "ssh"), ssh, { mode: 0o755 });
  return bin;
}

test("RemoteRunner rsyncs the local worktree, runs over ssh, and fetches metrics", async () => {
  const oldPath = process.env.PATH;
  const bin = fakeRemoteBin();
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const local = tempDir("rsi-local-");
    fs.mkdirSync(path.join(local, "bench"), { recursive: true });
    fs.writeFileSync(
      path.join(local, "bench", "run.py"),
      [
        "import argparse, json, os",
        "from pathlib import Path",
        "p = argparse.ArgumentParser()",
        "p.add_argument('--scope')",
        "p.add_argument('--out')",
        "args = p.parse_args()",
        "Path(args.out).write_text(json.dumps({'metrics': {'word_ppl': 12.5, 'gpu': os.environ.get('CUDA_VISIBLE_DEVICES')}}))",
        "",
      ].join("\n"),
      "utf8",
    );
    const remote: RemoteConfig = {
      host: "fake-host",
      dir: tempDir("rsi-remote-"),
      worktree: "",
      out: "",
      setup: "",
      python: "python3",
      ssh_args: [],
      rsync_args: [],
      gpu_ids: "2",
      env: { HF_HOME: "/data/hf" },
      timeout_s: 0,
      excludes: [],
    };
    const store = new ArtifactStore(tempDir("rsi-remote-store-"));
    const runner = new RemoteRunner(store, {
      remote,
      command: ["{python}", "bench/run.py", "--scope", "{scope}", "--out", "{out}"],
      runId: "run-1",
    });
    const req: ExperimentRequest = {
      idea_id: "h1",
      scope: "subset",
      repo: {
        path: local,
        label: "h1-subset",
        parent: null,
        patch: "",
        repo: local,
        commit: "deadbeef",
        branch: "rsi/run-1/h1-subset-1",
      },
      datasets: [],
      metrics: ["word_ppl"],
      idea: null,
      label: "h1-subset",
    };
    const result = await runner.run(req);
    assert.equal(result.status, "ok", result.stderr);
    assert.equal(result.metrics.word_ppl, 12.5);
    assert.equal(result.metrics.gpu, 2);
    assert.ok(fs.existsSync(path.join(remote.dir, "rsi", "run-1", "worktree", "bench", "run.py")));
    const log = JSON.parse(fs.readFileSync(path.join(store.root, "artifacts", "experiments", "remote-0001.json"), "utf8"));
    assert.equal(log.mode, "remote");
    assert.equal(log.gpu_ids, "2");
    assert.match(log.command, /CUDA_VISIBLE_DEVICES=2/);
  } finally {
    process.env.PATH = oldPath;
  }
});
