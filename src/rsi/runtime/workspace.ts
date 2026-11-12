/**
 * Git-native experiment execution.
 *
 * Candidate code is never copied into the run directory. The target project is
 * an external git repository; every candidate is a **branch + commit** in that
 * repository, checked out in one per-run `git worktree`:
 *
 *   target repo (external)             runs/<run_id>/worktree
 *   ├── rsi/<run>/baseline             one checkout, reused per candidate
 *   ├── rsi/<run>/h1-subset-1          (branches + commits stay in git)
 *   └── ...
 *
 * RSI core knows nothing about the target project. It only runs
 * `Problem.experiment_command` (or the default `run_experiment.py`) inside the
 * candidate's worktree and reads `{"metrics": {...}}` from `--out`.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { crc32, unit } from "../crc32.ts";
import type { Config } from "../config.ts";
import {
  type Evidence,
  type ExperimentResult,
  type Idea,
  type Problem,
  type RemoteConfig,
  type RepoRef,
  type Scope,
  clampMetric,
  problemMetric,
} from "../types.ts";
import { ArtifactStore } from "./store.ts";

export const SUBSET_FRACTION_KEY = "subset_fraction";

/** Default rsync excludes: VCS, caches, checkpoints, data and binary artifacts. */
export const DEFAULT_RSYNC_EXCLUDES = [
  ".git",
  "runs",
  "patches",
  "artifacts",
  "results",
  "checkpoints",
  "pretrained",
  "data",
  "datasets",
  "build",
  "dist",
  "logs",
  ".cache",
  ".pytest_cache",
  ".mypy_cache",
  "__pycache__",
  "node_modules",
  ".venv",
  ".venv-*",
  ".conda",
  "*.pyc",
  "*.pyo",
  "*.pt",
  "*.pth",
  "*.bin",
  "*.safetensors",
  "*.parquet",
  "*.arrow",
  "*.sqlite",
  "*.db",
  "*.log",
  "*.zip",
  "*.tar",
  "*.tar.gz",
];
export const HEADROOM_GAIN = 2;

export const DEFAULT_EXPERIMENT_COMMAND = [
  "python3",
  "run_experiment.py",
  "--scope",
  "{scope}",
  "--out",
  "{out}",
];

export interface ExperimentRequest {
  idea_id: string;
  scope: Scope;
  repo: RepoRef;
  datasets: string[];
  metrics: string[];
  idea: Idea | null;
  label: string;
  /** Scope-specific budget env (subset screen), merged by the runner. */
  env?: Record<string, string>;
}

export interface Runner {
  run(req: ExperimentRequest): Promise<ExperimentResult>;
}

export interface Workspace {
  readonly problem: Problem;
  readonly config: Config;
  readonly root: string;
  baselineRepo(): Promise<RepoRef>;
  writePatch(repo: RepoRef, patch: string, label: string): Promise<RepoRef>;
  diff(a: RepoRef, b: RepoRef): Promise<string>;
  run(repo: RepoRef, scope: Scope, idea?: Idea | null, seed?: number): Promise<ExperimentResult>;
  /** Source context for coding agents (git tree + relevant files at a commit). */
  brief?(repo: RepoRef, query?: string, maxChars?: number): string;
}

function okResult(metrics: Record<string, number>): ExperimentResult {
  return {
    metrics,
    status: "ok",
    log_path: "",
    stdout: "",
    stderr: "",
    wall_time_s: 0,
  };
}

// --------------------------------------------------------------------------- //
// simulated runner (offline contract)
// --------------------------------------------------------------------------- //

export class SimulatedRunner implements Runner {
  private readonly problem: Problem;
  private readonly config: Config;
  private readonly store: ArtifactStore;

  constructor(problem: Problem, config: Config, root: string | ArtifactStore) {
    this.problem = problem;
    this.config = config;
    this.store = typeof root === "string" ? new ArtifactStore(root) : root;
  }

  async run(req: ExperimentRequest): Promise<ExperimentResult> {
    let names = req.metrics.length ? req.metrics.slice() : this.problem.metrics.map((m) => m.name);
    if (!names.length) names = Object.keys(this.problem.reported_metrics).sort();
    if (!names.length) names = ["score"];

    const values: Record<string, number> = {};
    names.forEach((name, index) => {
      const baseline = this.problem.reported_metrics[name] ?? 1;
      let gain = 0;
      if (req.idea) {
        const idea = req.idea;
        const suffix = index === 0 ? "" : `:${name}`;
        gain = unit(idea.mechanism || idea.id, 1000) * 0.5 - 0.1;
        gain += this.config.guidanceWeight * idea.domain_fit * 0.2;
        gain += unit(idea.id + suffix, 97) * 0.02 - 0.01;
        if (req.scope === "subset") {
          gain = gain * 1.15 + unit(idea.id + "sub" + suffix, 53) * 0.02 - 0.01;
        }
      }
      const spec = problemMetric(this.problem, name);
      const direction = spec?.direction === "min" ? -1 : 1;
      let value: number;
      if (spec?.bounds) {
        const [low, high] = spec.bounds;
        const start = Math.min(Math.max(baseline, low), high);
        const span = direction > 0 ? high - start : start - low;
        value = start + direction * gain * span * HEADROOM_GAIN;
      } else {
        value = baseline * (1 + direction * gain);
      }
      values[name] = clampMetric(value, spec);
    });

    const key = crc32(JSON.stringify(req));
    const logPath = this.store.writeJson(`experiments/simulated-${key.toString(16).padStart(8, "0")}.json`, {
      mode: "simulated",
      request: req,
      metrics: values,
    });
    return { ...okResult(values), log_path: logPath };
  }
}

// --------------------------------------------------------------------------- //
// subprocess runner
// --------------------------------------------------------------------------- //

/** Expand {scope}/{out}/{repo}/{commit} in an experiment command. */
export function expandCommand(
  command: readonly string[],
  req: ExperimentRequest,
  repoPath: string,
  out: string,
  python = "python3",
): string[] {
  return command.map((token) =>
    token
      .replaceAll("{scope}", req.scope)
      .replaceAll("{out}", out)
      .replaceAll("{repo}", path.resolve(repoPath))
      .replaceAll("{commit}", req.repo.commit ?? "")
      .replaceAll("{python}", python),
  );
}

/**
 * The subset screen uses a real fraction of the full budget, not a two-step
 * smoke: steps = max(1, min(floor(full * fraction), cap)). The target adapter
 * reads the declared env key; the full scope is untouched.
 */
export function subsetBudgetEnv(
  problem: Problem,
  config: Config,
  scope: Scope,
): Record<string, string> {
  // Subset screening and component ablations share the short real budget.
  if (scope !== "subset" && scope !== "ablation") return {};
  const budget = problem.budget;
  if (!budget?.full_steps || !budget.steps_env) return {};
  const fraction = budget.subset_fraction ?? config.subsetFraction;
  const cap = budget.subset_max_steps ?? config.subsetMaxSteps;
  const steps = Math.max(1, Math.min(Math.floor(budget.full_steps * fraction), Math.floor(cap)));
  return { [budget.steps_env]: String(steps) };
}

export interface SubprocessOptions {
  timeoutS?: number;
  signal?: AbortSignal;
  /** Command template; `{scope}`, `{out}`, `{repo}`, `{commit}` are substituted. */
  command?: readonly string[] | null;
}

export class SubprocessRunner implements Runner {
  private readonly store: ArtifactStore;
  private readonly command: readonly string[];
  private readonly signal?: AbortSignal;
  readonly timeoutS: number;
  private sequence = 0;

  constructor(root: string | ArtifactStore, opts: SubprocessOptions = {}) {
    this.store = typeof root === "string" ? new ArtifactStore(root) : root;
    this.timeoutS = opts.timeoutS ?? 300;
    this.signal = opts.signal;
    this.command = opts.command?.length ? opts.command : DEFAULT_EXPERIMENT_COMMAND;
  }

  private expand(req: ExperimentRequest, out: string): string[] {
    return expandCommand(this.command, req, req.repo.path, out);
  }

  async run(req: ExperimentRequest): Promise<ExperimentResult> {
    const started = Date.now();
    const sequence = ++this.sequence;
    const out = this.store.artifact(`experiments/process-${String(sequence).padStart(4, "0")}.json`);
    const repo = path.resolve(req.repo.path);
    const argv = this.expand(req, out);

    const failure = (stdout: string, stderr: string): ExperimentResult => ({
      metrics: {},
      status: "failed",
      log_path: out,
      stdout,
      stderr: stderr.trim(),
      wall_time_s: (Date.now() - started) / 1000,
    });
    const errorText = (reason: unknown): string =>
      reason instanceof Error ? `${reason.name}: ${reason.message}` : `AbortError: ${String(reason)}`;
    if (this.signal?.aborted) return failure("", errorText(this.signal.reason));

    const result = await new Promise<ExperimentResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let closed = false;
      let cancellation: string | undefined;
      let processError: Error | undefined;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const grouped = process.platform !== "win32";
      const child = spawn(argv[0], argv.slice(1), {
        cwd: repo,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...(req.env ?? {}) },
        // A new process group lets us terminate ordinary descendants as well.
        detached: grouped,
      });
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (grouped && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            stderr += `\n${errorText(error)}`;
            child.kill(signal);
          }
        }
      };
      const finish = () => {
        if (settled || !closed || killTimer) return;
        settled = true;
        clearTimeout(timer);
        this.signal?.removeEventListener("abort", abort);
        if (cancellation || processError) {
          resolve(failure(stdout, `${stderr}\n${cancellation ?? errorText(processError)}`));
          return;
        }
        const wall = (Date.now() - started) / 1000;
        try {
          if (exitCode !== 0) throw new Error(`benchmark exited with status ${exitCode ?? exitSignal}`);
          const data = JSON.parse(fs.readFileSync(out, "utf8")) as Record<string, unknown>;
          const raw = (data.metrics ?? data) as Record<string, unknown>;
          if (!raw || typeof raw !== "object" || !Object.keys(raw).length) {
            throw new Error("benchmark output must contain nonempty metrics");
          }
          const metrics: Record<string, number> = {};
          for (const [name, value] of Object.entries(raw)) {
            const parsed = typeof value === "number" ? value : Number(value);
            if (!Number.isFinite(parsed)) throw new Error("benchmark metrics must be finite");
            metrics[String(name)] = parsed;
          }
          resolve({ metrics, status: "ok", log_path: out, stdout, stderr, wall_time_s: wall });
        } catch (error) {
          resolve(failure(stdout, `${stderr}\n${errorText(error)}`));
        }
      };
      const stop = (reason: unknown) => {
        if (settled || cancellation) return;
        cancellation = errorText(reason);
        clearTimeout(timer);
        // Give adapters a brief opportunity to clean up children they started
        // in separate sessions. Then kill our group even if its leader exited.
        kill("SIGTERM");
        killTimer = setTimeout(() => {
          kill("SIGKILL");
          killTimer = undefined;
          finish();
        }, 500);
      };
      const abort = () => stop(this.signal!.reason);
      const timer = setTimeout(
        () => stop(new DOMException(`exceeded ${this.timeoutS}s`, "TimeoutError")),
        this.timeoutS * 1000,
      );
      this.signal?.addEventListener("abort", abort, { once: true });
      if (this.signal?.aborted) abort();
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        processError = error;
        // A failed spawn has no process or descendants to wait for.
        if (!child.pid) {
          closed = true;
          finish();
        }
      });
      child.on("close", (code, signal) => {
        closed = true;
        exitCode = code;
        exitSignal = signal;
        finish();
      });
    });
    return result;
  }
}

// --------------------------------------------------------------------------- //
// remote runner (local git + rsync + ssh GPU server)
// --------------------------------------------------------------------------- //

export function shellQuote(value: string): string {
  if (value && /^[A-Za-z0-9_./:=@+,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface RemoteInvocation {
  /** Command executed inside the remote worktree (already shell-quoted). */
  inner: string;
  /** Environment assignments for the remote shell. */
  env: Record<string, string>;
}

/** Build the remote command; pure, so it can be tested without a server. */
export function buildRemoteInvocation(
  remote: RemoteConfig,
  command: readonly string[],
  req: ExperimentRequest,
  remoteWorktree: string,
  remoteOut: string,
): RemoteInvocation {
  if (!remote.gpu_ids) {
    throw new Error('remote.gpu_ids is required; use "0" for a single GPU');
  }
  const env: Record<string, string> = {
    // Explicit target/operator overrides (including smoke-test budgets) win
    // over the automatic subset budget injected into req.env.
    ...(req.env ?? {}),
    ...remote.env,
    CUDA_VISIBLE_DEVICES: remote.gpu_ids,
  };
  const argv = expandCommand(command, req, remoteWorktree, remoteOut, remote.python)
    .map((token) => shellQuote(token))
    .join(" ");
  const exports = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  const timeout = remote.timeout_s > 0 ? `timeout ${Math.trunc(remote.timeout_s)} ` : "";
  const setup = remote.setup.trim() ? `${remote.setup.trim()}; ` : "";
  const inner = `cd ${shellQuote(remoteWorktree)} && ${setup}${exports ? `export ${exports}; ` : ""}${timeout}${argv}`;
  return { inner, env };
}

/** Expand {run_id} (and {repo}) in a remote path template. */
export function expandRemoteTemplate(template: string, runId: string, repoName: string): string {
  return template.replaceAll("{run_id}", safeName(runId)).replaceAll("{repo}", repoName);
}

export interface RemoteTransportResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

export type RemoteTransport = (
  binary: string,
  args: readonly string[],
  opts: { timeoutS?: number; signal?: AbortSignal },
) => Promise<RemoteTransportResult>;

export async function sh(
  binary: string,
  args: readonly string[],
  opts: { timeoutS?: number; signal?: AbortSignal } = {},
): Promise<RemoteTransportResult> {
  if (opts.signal?.aborted) return { code: 1, stdout: "", stderr: "Aborted", killed: true };
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    const abort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", abort, { once: true });
    const timer = opts.timeoutS
      ? setTimeout(() => {
          if (settled) return;
          child.kill("SIGKILL");
        }, opts.timeoutS * 1000)
      : null;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}`.trim(), killed: false });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
        killed: signal === "SIGKILL" || signal === "SIGTERM",
      });
    });
  });
}

export interface RemoteOptions {
  remote: RemoteConfig;
  command: readonly string[] | null;
  runId: string;
  timeoutS?: number;
  signal?: AbortSignal;
  /** Testable transport boundary; production uses real subprocesses. */
  transport?: RemoteTransport;
}

export class RemoteRunner implements Runner {
  private readonly store: ArtifactStore;
  private readonly remote: RemoteConfig;
  private readonly command: readonly string[];
  private readonly runId: string;
  private readonly timeoutS: number;
  private readonly signal?: AbortSignal;
  private readonly transport: RemoteTransport;
  private sequence = 0;

  constructor(root: string | ArtifactStore, opts: RemoteOptions) {
    this.store = typeof root === "string" ? new ArtifactStore(root) : root;
    this.remote = opts.remote;
    this.command = opts.command?.length ? opts.command : DEFAULT_EXPERIMENT_COMMAND;
    this.runId = opts.runId;
    this.timeoutS = opts.timeoutS ?? opts.remote.timeout_s ?? 7200;
    this.signal = opts.signal;
    this.transport = opts.transport ?? sh;
  }

  private sh(binary: string, args: readonly string[], opts: { timeoutS?: number } = {}): Promise<RemoteTransportResult> {
    return this.transport(binary, args, { ...opts, signal: this.signal });
  }

  private sshBase(): string[] {
    return [...this.remote.ssh_args, this.remote.host];
  }

  /**
   * Kill a detached remote process group after a local abort/timeout. This
   * deliberately uses a fresh transport call: `this.sh` carries the already
   * aborted signal and would skip the cleanup SSH itself.
   */
  private async cleanupRemote(pidFile: string): Promise<void> {
    const script = [
      `p=$(cat ${shellQuote(pidFile)} 2>/dev/null) || exit 0`,
      `[ -n "$p" ] || exit 0`,
      `kill -TERM -- -$p 2>/dev/null || true`,
      `sleep 2`,
      `kill -KILL -- -$p 2>/dev/null || true`,
      `rm -f ${shellQuote(pidFile)}`,
    ].join("; ");
    try {
      await this.transport("ssh", [...this.sshBase(), "--", script], { timeoutS: 30 });
    } catch {
      /* best effort: the server may be unreachable after the abort */
    }
  }

  async run(req: ExperimentRequest): Promise<ExperimentResult> {
    const started = Date.now();
    if (!this.remote.dir) {
      return {
        metrics: {},
        status: "failed",
        log_path: "",
        stdout: "",
        stderr: "remote.dir is empty",
        wall_time_s: 0,
      };
    }
    if (!this.remote.host) {
      return {
        metrics: {},
        status: "failed",
        log_path: "",
        stdout: "",
        stderr: "remote.host is empty (set remote.host or RSI_REMOTE_HOST)",
        wall_time_s: 0,
      };
    }
    if (!this.remote.gpu_ids) {
      return {
        metrics: {},
        status: "failed",
        log_path: "",
        stdout: "",
        stderr: 'remote.gpu_ids is required; use "0" for a single GPU',
        wall_time_s: 0,
      };
    }
    if (!this.remote.dir && !this.remote.worktree) {
      return {
        metrics: {},
        status: "failed",
        log_path: "",
        stdout: "",
        stderr: "remote.dir or remote.worktree is required",
        wall_time_s: 0,
      };
    }
    const seq = ++this.sequence;
    const repoName = safeName(path.basename(path.resolve(req.repo.repo ?? req.repo.path)));
    const baseDir = this.remote.dir || "~/rsi";
    // Reuse the target root by default. A per-run worktree is an explicit
    // isolation choice, not the default: `--delete` keeps one source mirror
    // current instead of copying the whole project for every run.
    const worktreeTemplate = this.remote.worktree || baseDir;
    const remoteWorktree = expandRemoteTemplate(worktreeTemplate, this.runId, repoName);
    // Results remain per run and are excluded from source synchronization, so
    // reusing the worktree never deletes checkpoints or evaluation evidence.
    const outTemplate =
      this.remote.out || path.posix.join(baseDir, "results", "{run_id}");
    const remoteOutDir = expandRemoteTemplate(outTemplate, this.runId, repoName);
    const remoteOut = path.posix.join(remoteOutDir, `process-${String(seq).padStart(4, "0")}.json`);
    const logPath = this.store.artifact(`experiments/remote-${String(seq).padStart(4, "0")}.json`);
    let stdout = "";
    let stderr = "";

    const mkdir = await this.sh("ssh", [
      ...this.sshBase(),
      "--",
      `mkdir -p ${shellQuote(remoteWorktree)} ${shellQuote(remoteOutDir)}`,
    ], { timeoutS: 120 });
    if (mkdir.code !== 0) {
      return this.fail(logPath, stdout + mkdir.stdout, stderr + mkdir.stderr, started);
    }

    // Combine defaults, repo-specific excludes, and everything ignored by
    // .gitignore. Using --exclude-from keeps the rsync command line bounded.
    const excludes = new Set([
      ...DEFAULT_RSYNC_EXCLUDES,
      ...this.remote.excludes,
      ...gitIgnoredPaths(req.repo.path),
    ]);
    const excludeFile = this.store.path("rsync", `excludes-${String(seq).padStart(4, "0")}.txt`);
    fs.writeFileSync(excludeFile, `${[...excludes].join("\n")}\n`, "utf8");
    const rsyncArgs = [
      "-az",
      "--delete",
      "--exclude-from",
      excludeFile,
      ...this.remote.rsync_args,
      `${path.resolve(req.repo.path)}/`,
      `${this.remote.host}:${shellQuote(remoteWorktree)}/`,
    ];
    const synced = await this.sh("rsync", rsyncArgs, { timeoutS: 1800 });
    stdout += synced.stdout;
    stderr += synced.stderr;
    if (synced.code !== 0) return this.fail(logPath, stdout, stderr, started);

    const invocation = buildRemoteInvocation(this.remote, this.command, req, remoteWorktree, remoteOut);
    // Run the experiment in its own remote session and record its PID. A local
    // abort kills only the SSH client; the cleanup below reaches the remote
    // process group by PID. An untracked `ssh` would leave training running.
    const pidFile = path.posix.join(remoteOutDir, `.rsi-${String(seq).padStart(4, "0")}.pid`);
    const tracked = `echo $$ > ${shellQuote(pidFile)}; ${invocation.inner}; rc=$?; if [ $rc -eq 0 ]; then rm -f ${shellQuote(pidFile)}; fi; exit $rc`;
    const launch = `if command -v setsid >/dev/null 2>&1; then setsid bash -lc ${shellQuote(tracked)} & wait $!; else bash -lc ${shellQuote(tracked)} & wait $!; fi`;
    const run = await this.sh(
      "ssh",
      [...this.sshBase(), "--", `bash -lc ${shellQuote(launch)}`],
      { timeoutS: this.timeoutS },
    );
    stdout += run.stdout;
    stderr += run.stderr;
    if (run.killed || this.signal?.aborted || run.code !== 0) {
      await this.cleanupRemote(pidFile);
    }
    if (run.killed) stderr += this.signal?.aborted ? "\nAborted: remote process group terminated" : `\nTimeoutError: remote command exceeded ${this.timeoutS}s`;

    const fetched = await this.sh("ssh", [...this.sshBase(), "--", `cat ${shellQuote(remoteOut)}`], {
      timeoutS: 120,
    });
    // Keep the original report even on nonzero remote exits or invalid JSON.
    const rawReportPath = this.store.writeText(`experiments/remote-${String(seq).padStart(4, "0")}.report.raw.txt`, fetched.stdout);
    let metrics: Record<string, number> = {};
    let status: ExperimentResult["status"] = "failed";
    if (run.code === 0 && fetched.code === 0) {
      try {
        const data = JSON.parse(fetched.stdout) as Record<string, unknown>;
        const raw = (data.metrics ?? data) as Record<string, unknown>;
        if (raw && typeof raw === "object" && Object.keys(raw).length) {
          for (const [name, value] of Object.entries(raw)) {
            const parsed = typeof value === "number" ? value : Number(value);
            if (!Number.isFinite(parsed)) throw new Error(`metric ${name} is not finite`);
            metrics[name] = parsed;
          }
          status = "ok";
        }
      } catch (error) {
        stderr += `\nRemoteResultError: ${(error as Error).message}`;
      }
    } else if (run.code !== 0) {
      stderr += `\nremote command exited with status ${run.code}`;
    } else {
      stderr += "\nremote result file could not be fetched";
    }

    const result: ExperimentResult = {
      metrics,
      status,
      log_path: logPath,
      stdout,
      stderr: stderr.trim(),
      wall_time_s: (Date.now() - started) / 1000,
    };
    this.store.writeJson(`experiments/remote-${String(seq).padStart(4, "0")}.json`, {
      mode: "remote",
      host: this.remote.host,
      remote_worktree: remoteWorktree,
      remote_out: remoteOut,
      gpu_ids: this.remote.gpu_ids,
      command: invocation.inner,
      raw_report_path: rawReportPath,
      remote_exit: run.code,
      fetch: fetched,
      result,
    });
    return result;
  }

  private fail(logPath: string, stdout: string, stderr: string, started: number): ExperimentResult {
    const result: ExperimentResult = {
      metrics: {},
      status: "failed",
      log_path: logPath,
      stdout,
      stderr: stderr.trim(),
      wall_time_s: (Date.now() - started) / 1000,
    };
    this.store.writeJson(`experiments/${path.basename(logPath)}`, result);
    return result;
  }
}

// --------------------------------------------------------------------------- //
// git helpers
// --------------------------------------------------------------------------- //

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Paths ignored by the repository's .gitignore files, relative to root. */
export function gitIgnoredPaths(root: string): string[] {
  const result = git(
    root,
    ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
    true,
  );
  if (result.status !== 0) return [];
  return result.stdout.split("\0").filter(Boolean);
}

function git(cwd: string, args: string[], allowFailure = false): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const out: GitResult = {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${result.error ? String(result.error) : ""}`,
  };
  if (!allowFailure && out.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${out.stderr || out.stdout}`);
  }
  return out;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "candidate";
}

/** Extract a unified diff from model prose or a fenced block. */
export function extractUnifiedDiff(text: string): string | null {
  if (!text) return null;
  const fenced = /```(?:diff|patch)\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/^(diff --git |--- )/m);
  if (start < 0) return null;
  const lines = body.slice(start).split("\n");
  const kept: string[] = [];
  let inHunk = false;
  for (const line of lines) {
    const header = /^(diff --git |index |--- |\+\+\+ |@@ )/.test(line);
    const content = inHunk && /^([ +\-\\]|$)/.test(line);
    if (header || content) {
      kept.push(line);
      if (line.startsWith("@@ ")) inHunk = true;
      continue;
    }
    if (inHunk) break; // prose after a hunk is not part of the patch
  }
  const diff = kept.join("\n").trimEnd();
  if (!/^\+\+\+ /m.test(diff) || !/^@@ /m.test(diff)) return null;
  return `${diff}\n`;
}

function tokensOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9_]{3,}/g)) out.add(match[0]);
  return out;
}

// --------------------------------------------------------------------------- //
// git workspace
// --------------------------------------------------------------------------- //

export class GitWorkspace implements Workspace {
  readonly problem: Problem;
  readonly config: Config;
  readonly root: string;
  readonly store: ArtifactStore;
  readonly runner: Runner;
  private readonly sourceOverride: string | undefined;

  private source = "";
  private baseCommit = "";
  private worktree = "";
  private branchSeq = 0;
  private branchPrefix = "";
  private initialized = false;

  constructor(problem: Problem, config: Config, root: string, runner?: Runner, sourceOverride?: string, signal?: AbortSignal) {
    this.problem = problem;
    this.config = config;
    this.root = root;
    this.sourceOverride = sourceOverride;
    this.store = new ArtifactStore(root);
    this.runner =
      runner ??
      (config.runner === "simulated"
        ? new SimulatedRunner(problem, config, this.store)
        : problem.remote
          ? new RemoteRunner(this.store, {
              remote: problem.remote,
              command: problem.experiment_command,
              runId: config.runId,
              timeoutS: problem.remote.timeout_s || config.maxWallTimeS,
              signal,
            })
          : new SubprocessRunner(this.store, {
              timeoutS: config.maxWallTimeS,
              command: problem.experiment_command,
              signal,
            }));
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    const repoPath = this.problem.repo ? path.resolve(this.problem.repo) : null;
    if (repoPath) {
      if (!fs.existsSync(repoPath)) {
        throw new Error(
          `problem.repo not found: ${repoPath}. Prepare the target repository first.`,
        );
      }
      const top = git(repoPath, ["rev-parse", "--show-toplevel"], true);
      if (top.status !== 0) {
        throw new Error(`problem.repo is not a git repository: ${repoPath}`);
      }
      this.source = top.stdout.trim();
      const ref = this.problem.repo_ref || "HEAD";
      this.baseCommit = git(this.source, ["rev-parse", ref]).stdout.trim();
    } else if (this.sourceOverride && fs.existsSync(path.join(this.sourceOverride, ".git"))) {
      // A resumed synthetic run reuses the previous repository so the commits
      // recorded in state.json are still reachable.
      this.source = this.sourceOverride;
      this.baseCommit = git(this.source, ["rev-parse", this.problem.repo_ref || "HEAD"]).stdout.trim();
    } else {
      this.source = path.join(this.root, "synthetic");
      if (!fs.existsSync(path.join(this.source, ".git"))) {
        fs.mkdirSync(this.source, { recursive: true });
        git(this.source, ["init", "-q"]);
        const values: Record<string, number> = {};
        for (const metric of this.problem.metrics) {
          values[metric.name] = this.problem.reported_metrics[metric.name] ?? 1;
        }
        const fallback = Object.keys(values).length
          ? values
          : Object.keys(this.problem.reported_metrics).length
            ? { ...this.problem.reported_metrics }
            : { score: 1 };
        fs.writeFileSync(
          path.join(this.source, "run_experiment.py"),
          [
            '"""Synthetic scaffold, not a scientific benchmark."""',
            "import argparse, json",
            "from pathlib import Path",
            "p = argparse.ArgumentParser()",
            "p.add_argument('--scope')",
            "p.add_argument('--out')",
            "args = p.parse_args()",
            `Path(args.out).write_text(json.dumps({'metrics': ${JSON.stringify(fallback)}}))`,
            "",
          ].join("\n"),
          "utf8",
        );
        fs.writeFileSync(
          path.join(this.source, "README.md"),
          "# Synthetic baseline scaffold\nNo source repository was configured.\n",
          "utf8",
        );
        git(this.source, ["add", "-A"]);
        git(this.source, [
          "-c",
          "user.name=RSI",
          "-c",
          "user.email=rsi@local",
          "commit",
          "-q",
          "-m",
          "synthetic baseline",
        ]);
      }
      this.baseCommit = git(this.source, ["rev-parse", "HEAD"]).stdout.trim();
    }

    // Branch names must be unique across runs that share a problem id/seed but
    // write to different out dirs; the run root hash provides that namespace.
    const namespace = crc32(path.resolve(this.root)).toString(16).padStart(8, "0");
    this.branchPrefix = `rsi/${safeName(this.config.runId)}-${namespace}`;
    this.worktree = path.join(this.root, "worktree");
    fs.rmSync(this.worktree, { recursive: true, force: true });
    // The same repository can be mounted under different host/container paths.
    // Global prune would unregister another runtime's live (locally invisible)
    // user worktrees. Reclaim only our own explicitly selected worktree path.
    git(this.source, ["worktree", "add", "--force", "--detach", this.worktree, this.baseCommit]);
    this.initialized = true;
  }

  private checkout(commit: string, clean = false): void {
    git(this.worktree, ["checkout", "--detach", commit]);
    if (clean) {
      git(this.worktree, ["reset", "--hard", commit]);
      git(this.worktree, ["clean", "-fdq"]);
    }
  }

  async baselineRepo(): Promise<RepoRef> {
    await this.init();
    this.checkout(this.baseCommit, true);
    return {
      path: this.worktree,
      label: "baseline",
      parent: null,
      patch: "",
      repo: this.source,
      commit: this.baseCommit,
      branch: "detached",
    };
  }

  async writePatch(repo: RepoRef, patch: string, label: string): Promise<RepoRef> {
    await this.init();
    const parent = repo.commit || this.baseCommit;
    this.checkout(parent, true);
    const diff = extractUnifiedDiff(patch);
    let applyLog = "no unified diff; prose patch recorded only";
    if (diff) {
      const patchFile = path.join(this.worktree, ".rsi.patch");
      fs.writeFileSync(patchFile, diff, "utf8");
      // Strict first. A model diff can carry a correct body but a malformed
      // hunk header; --recount fixes counts, and -C3 tolerates an off-by-one
      // trailing context that git otherwise rejects. Only fall back when the
      // exact same patch would apply, so placement is still verified.
      let strategy = "strict";
      let applied = git(this.worktree, ["apply", "--whitespace=nowarn", "--recount", ".rsi.patch"], true);
      if (applied.status !== 0) {
        const check = git(this.worktree, ["apply", "--check", "--whitespace=nowarn", "--recount", "--unidiff-zero", ".rsi.patch"], true);
        if (check.status === 0) {
          strategy = "recount-zero";
          applied = git(this.worktree, ["apply", "--whitespace=nowarn", "--recount", "--unidiff-zero", ".rsi.patch"], true);
        }
      }
      applyLog = `strategy=${strategy} status=${applied.status}\n${applied.stdout}${applied.stderr}`.trim();
      fs.rmSync(patchFile, { force: true });
    }
    const safe = safeName(label);
    const branch = `${this.branchPrefix}/${safe}-${++this.branchSeq}`;
    git(this.worktree, ["checkout", "-B", branch]);
    git(this.worktree, ["add", "-A"]);
    const status = git(this.worktree, ["status", "--porcelain"]).stdout.trim();
    let commit = parent;
    if (status) {
      git(this.worktree, [
        "-c",
        "user.name=RSI",
        "-c",
        "user.email=rsi@local",
        "commit",
        "-q",
        "-m",
        `rsi: ${label}`,
      ]);
      commit = git(this.worktree, ["rev-parse", "HEAD"]).stdout.trim();
    }
    fs.writeFileSync(this.store.path("patches", `${safe}.diff`), diff ?? patch, "utf8");
    fs.writeFileSync(this.store.path("patches", `${safe}.apply.log`), `${applyLog}\n`, "utf8");
    return {
      path: this.worktree,
      label,
      parent: repo.label === "baseline" && label.startsWith("baseline") ? null : parent,
      patch,
      repo: this.source,
      commit,
      branch,
    };
  }

  async diff(a: RepoRef, b: RepoRef): Promise<string> {
    await this.init();
    if (!a.commit || !b.commit) return "";
    const out = git(this.worktree, ["diff", "--no-color", a.commit, b.commit], true).stdout;
    // In simulated mode no code is executed; the recorded patch is the only
    // code-level evidence a mock run can offer. Real runs never get this fallback.
    if (!out && this.config.runner === "simulated" && b.patch) return b.patch;
    return out;
  }

  async run(repo: RepoRef, scope: Scope, idea: Idea | null = null, seed?: number): Promise<ExperimentResult> {
    await this.init();
    if (repo.commit) {
      const head = git(this.worktree, ["rev-parse", "HEAD"], true);
      if (head.stdout.trim() !== repo.commit) this.checkout(repo.commit);
    }
    const env = subsetBudgetEnv(this.problem, this.config, scope);
    const seedEnv = this.problem.budget?.seed_env;
    if (seed !== undefined && seedEnv) env[seedEnv] = String(seed);
    const req: ExperimentRequest = {
      idea_id: idea?.id ?? "baseline",
      scope,
      repo,
      datasets: scope === "subset" ? this.problem.subset_datasets.slice() : this.problem.datasets.slice(),
      metrics: this.problem.metrics.map((m) => m.name),
      idea,
      label: repo.label,
      env,
    };
    const result = await this.runner.run(req);
    this.store.writeJson(`experiments/provenance-${safeName(repo.label)}-${scope}.json`, {
      request: req,
      result,
      commit: repo.commit,
      branch: repo.branch,
    });
    return result;
  }

  /** Build a bounded source brief from a git commit, not from copied files. */
  brief(repo: RepoRef, query = "", maxChars = 18000): string {
    const commit = repo.commit || this.baseCommit;
    if (!commit) return "";
    const listed = git(this.worktree, ["ls-tree", "-r", "-l", commit], true);
    if (listed.status !== 0) return "";
    const entries = listed.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [meta, name] = line.split("\t");
        const size = Number(meta.split(/\s+/)[3] ?? 0);
        return { name, size };
      })
      .filter(
        (entry) =>
          !entry.name.startsWith(".git/") &&
          !["patch.txt", "patch.apply.log", ".rsi.patch", "run_experiment.py"].includes(entry.name) &&
          /\.(py|md|toml|json|ya?ml|txt)$/.test(entry.name),
      );
    const tokens = [...tokensOf(query)].slice(0, 20);
    const codeExt = new Set([".py", ".ts", ".tsx", ".js", ".go", ".rs", ".java", ".c", ".cc", ".cpp", ".h"]);
    const sourceDir = /(^|\/)(src|lib|pkg|mamba_ssm|scripts|bench|tests)\//;
    const scored = entries
      .slice(0, 180)
      .map((entry) => {
        let text = "";
        if (entry.size <= 120_000) {
          const shown = git(this.worktree, ["show", `${commit}:${entry.name}`], true);
          if (shown.status === 0) text = shown.stdout;
        }
        const lower = `${entry.name}\n${text.slice(0, 20_000)}`.toLowerCase();
        const matches = tokens.reduce((sum, token) => sum + (lower.includes(token) ? 1 : 0), 0);
        const score =
          matches * 4 +
          (codeExt.has(path.extname(entry.name)) ? 3 : 0) +
          (sourceDir.test(entry.name) ? 2 : 0);
        return { ...entry, score, text };
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const fullTree = entries.slice(0, 120).map((entry) => entry.name).join("\n");
    const tree = fullTree.slice(0, Math.min(3500, Math.floor(maxChars * 0.3)));
    const parts = [`Repository tree at ${commit.slice(0, 12)}:\n${tree}`];
    let used = tree.length;
    for (const file of scored.slice(0, 6)) {
      if (!file.text || used > maxChars) continue;
      const budget = Math.max(0, Math.min(4000, maxChars - used));
      if (budget < 500) break;
      parts.push(`--- FILE: ${file.name} (${file.size} bytes) ---\n${file.text.slice(0, budget)}`);
      used += Math.min(file.text.length, budget);
    }
    return parts.join("\n\n");
  }
}


export function evidenceFromResult(
  ideaId: string,
  scope: Scope,
  result: ExperimentResult,
  repo: RepoRef,
  baselineMetrics: Record<string, number> = {},
): Evidence {
  return {
    idea_id: ideaId,
    scope,
    metrics: result.metrics,
    baseline_metrics: baselineMetrics,
    code: repo,
    result,
    label: repo.label,
  };
}
