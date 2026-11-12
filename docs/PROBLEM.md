# 在哪里定义研究问题

RSI 的研究问题配置都在 **Problem JSON fixture** 里。RSI 是深度集成 Pi 的原生扩展，
不包含项目专属 integrations；训练、数据、checkpoint、评测 helper 与项目测试均属于
独立目标仓库。Problem 提供以下通用契约：

| 你要定义的东西 | 字段 | 例子 |
|---|---|---|
| 指标 | `metrics` | `{"name":"mse","direction":"min","tolerance":0.01}` |
| 研究方向 | `domain`、`subfield`、`directions`、`forbidden`、`constraints` | 见下方完整示例 |
| 研究代码路径 | `repo`、`repo_ref`、`experiment_command` | `/repos/mamba`、`rsi-bench`、`bench/rsi_dfm_train_eval.py` |
| 远程 GPU / 路径映射 | `remote` | `host`、`worktree`、`out`、`python`、`setup`、`gpu_ids` |

外部项目配置示例：`examples/dfm_ssm_external.json`。示例文件不是已通过验收的证明，
`repo_ref` 必须指向实际验证过的目标代码。合成示例：
`tests/fixtures/ood_frozen_encoder.json`、`tests/fixtures/meta_refine.json`。

## 完整注释示例

```jsonc
{
  "id": "dfm-ssm-wikitext-ppl",
  "statement": "Improve DFM-Mamba so wikitext word-ppl decreases after training.",
  "domain": "discrete flow matching / state space models",
  "subfield": "DFM-Mamba training and wikitext language modeling",
  "source_paper": "Mamba-3 (arXiv:2603.15569) with the DFM-Mamba path",

  // ── 研究代码路径（外部 git 仓库）────────────────────────────
  "repo": "/repos/mamba",        // 外部 git 仓库（compose 挂载）
  "repo_ref": "rsi-bench",         // 基线分支 / tag / commit；默认 HEAD
  "experiment_command": [          // 只放调用与占位符；参数放 remote.env
    "{python}", "bench/rsi_dfm_train_eval.py",
    "--repo", "{repo}",            // 候选 worktree 路径
    "--scope", "{scope}",          // subset / full / ablation / rebuttal
    "--out", "{out}"               // 必须写入 {"metrics": {...}} 的 JSON
  ],

  // ── subset 筛选预算（可选；真实小预算，不是 smoke）────────────
  "budget": {
    "full_steps": 954,             // full scope 的真实训练步数
    "subset_fraction": 0.1,        // 10%
    "subset_max_steps": 200,       // 但不超过 200 步
    "steps_env": "RSI_DFM_TRAIN_STEPS" // adapter 读取的训练步数环境变量
  },

  // ── 远程 GPU（可选；服务器离线）─────────────────────────────
  "remote": {
    "host": "",                    // 或 RSI_REMOTE_HOST
    "dir": "/data/rsi",
    "worktree": "/home/sl/projects/dfm-ssm-{run_id}",  // 本地→服务器项目路径
    "out": "/home/sl/projects/dfm-ssm-{run_id}/out",
    "python": "/opt/conda/envs/dfm/bin/python",
    "setup": "source /opt/conda/etc/profile.d/conda.sh && conda activate dfm",
    "ssh_args": ["-o", "BatchMode=yes"],
    "gpu_ids": "0",                // → CUDA_VISIBLE_DEVICES
    "env": {
      "HF_DATASETS_CACHE": "/data/hf/datasets",
      "RSI_DFM_TRAIN_DATA": "/data/dfm/train.jsonl",
      "RSI_DFM_BASE_MODEL": "/data/models/mamba-130m",
      "RSI_DFM_TOKENIZER": "/data/models/gpt-neox-tokenizer",
      "RSI_DFM_BACKEND": "native",
      "RSI_DFM_DEVICE": "cuda",
      "RSI_DFM_TRAIN_STEPS": "1000",
      "RSI_DFM_TRAIN_BATCH_SIZE": "2",
      "RSI_DFM_GRAD_ACCUM": "8",
      "RSI_DFM_MAX_LENGTH": "512",
      "RSI_DFM_BLOCK_LENGTH": "16",
      "RSI_DFM_LM_EVAL_BATCH_SIZE": "8",
      "RSI_DFM_EVAL_MAX_LENGTH": "2048",
      "RSI_DFM_FLOW_TIME": "off",
      "RSI_DFM_DATA_FORMAT": "auto",
      "RSI_DFM_OFFLINE": "1"
    },
    "timeout_s": 14400,
    "excludes": ["checkpoints", "pretrained", "data"]
  },

  // ── 指标（唯一的 promotion 依据）────────────────────────────
  "metrics": [
    {
      "name": "word_ppl",          // lm-eval wikitext word_perplexity
      "direction": "min",          // 越低越好
      "tolerance": 0.01,           // 1% 相对噪声带
      "weight": 1.0,
      "bounds": null
    }
  ],

  // 仅作为上下文 / 模拟 runner 的基线；subprocess 模式会真实复现基线
  "reported_metrics": { "word_ppl": 20.0 },

  // ── 研究方向（软引导，除非 strict_directions）────────────────
  "directions": [
    {
      "id": "dfm-objective",
      "title": "DFM training objective",
      "description": "Change the flow-matching objective or time schedule.",
      "keywords": ["flow", "posterior", "time", "loss"],
      "weight": 1.0,
      "must_include": false       // true + strict_directions ⇒ 硬门
    }
  ],
  "forbidden": [
    "changing the lm-eval task or word_ppl metric",
    "modifying bench/rsi_dfm_train_eval.py",
    "training on wikitext test data"
  ],
  "constraints": [
    "Evaluate with lm-eval task wikitext",
    "Match tokenizer/eval split/training budget",
    "Server is offline: use cached models/data"
  ],

  "datasets": ["wikitext-2-raw-v1"],
  "subset_datasets": ["wikitext-2-raw-v1"],
  "venue": "ICLR"
}
```

## 指标在哪里生效

| 位置 | 作用 |
|---|---|
| `Problem.metrics` | 唯一允许触发 promotion 的指标集合 |
| `metrics[0]` | **主指标**；subset 阶段还要额外满足 `subsetMargin`（默认 2%） |
| `direction` + `tolerance` | `isStrictlyBetter()`：所有指标不得回退超过 tolerance，且至少一个改进超过 tolerance |
| `bounds` | 模拟 runner 和 ablation 的 clamp；**真实 runner 不会被自动 clamp**，请在自己的 benchmark 里保证数值合法 |
| benchmark 输出 | 必须包含 `metrics` 中的键；额外键会记录，但不参与门 |
| `reported_metrics` | 模拟/上下文；不是比较目标。subprocess 模式比较的是**测得的 baseline**（复现或已验证 incumbent） |

实现：

- `src/rsi/types.ts` — `MetricSpec`、`metricDeltas()`、`isStrictlyBetter()`
- `src/rsi/config.ts` — `subsetMargin`、`minNovelty`、`reviewThreshold` 等
- `src/rsi/agents/critics.ts` — subset/full critic、ResultComparison

## subset 预算

`Problem.budget` 让 **subset 筛选和 component ablation** 使用真实的小预算，而不是 1–2 步 smoke：

```text
subset_steps = max(1, min(floor(full_steps * subset_fraction), subset_max_steps))
```

该值通过 `budget.steps_env` 注入 subset 和 ablation 实验；`budget.seed_env`
注入每个 subset 候选/ablation 的 seed（默认 3 个独立 seed，均值判定）。
full/rebuttal scope 不注入，继续用 adapter 的完整预算。ablation 只跑 subset
预算，并与 candidate 的 subset 对照比较，不触发 full 954 步。目标 adapter
必须接受 `--scope ablation`；
最新的 Coral regenerated adapter 已包含该分支。例如 `full_steps=954, subset_fraction=0.1, subset_max_steps=200` →
`95` 步。没有 `budget` 时，adapter 自己的默认值生效。

## 研究方向在哪里生效

| 字段 | 作用 |
|---|---|
| `domain` / `subfield` | 注入所有生成 prompt 与 manuscript framing |
| `directions[]` | 生成/进化 prompt；`NoveltyChecker` 输出 `direction_ids` 与 `domain_fit` |
| `directions[].must_include` | 只有 `strict_directions: true` 时是硬门 |
| `directions[].weight` | 目前只用于 `weight > 0` 的硬方向判定；排序使用全局 `guidanceWeight` |
| `forbidden` | 生成时禁止；`SpecAuditor` 还会对 diff 做确定性 token 检查 |
| `constraints` | 生成/审计 prompt |

排序与过滤：

```text
rank = novelty_score + guidance_weight * domain_fit
filter: domain_fit >= min_domain_fit
if strict_directions: 至少命中一个 must_include 方向
```

默认值在 `src/rsi/config.ts`：`guidanceWeight=0.5`、`minDomainFit=0.3`、
`strictDirections=false`、`guidanceInEvolution=true`。

运行时开启硬方向：

```text
/rsi run examples/my_problem.json --strict-directions
rsi_research { problem: "...", strict_directions: true }
node src/rsi/cli.ts run examples/my_problem.json --mock --strict-directions
```

## 研究代码路径与 benchmark 契约

- `repo`：必须是**外部 git 仓库**的路径（绝对路径，或相对当前 cwd）。
  推荐把宿主工作区挂到容器 `/repos`，然后写 `/repos/mamba`；也可以继续用
  `/repos/mamba`。git 提交/分支发生在该仓库，不在 RSI 仓库。
- `repo_ref`：基线 ref；默认 `HEAD`。adapter 应先在独立目标候选分支/ref 上
  实现并通过真实远程冒烟，才将实测 commit/ref 作为可用基线交付。示例中的
  `rsi-bench` 只是目标分支名，不由 RSI 安装或保证存在。
- `remote.worktree` / `remote.out`：本地项目路径到服务器路径的映射模板，支持
  `{run_id}`、`{repo}`。默认 `<remote.dir>/rsi/<run_id>/worktree`。
- `remote.python` / `remote.setup`：指定远程 Python 环境；`setup` 可执行
  `conda activate`、`module load` 等。
- `diagnose_command`（可选）：在**已复现 baseline** 的 worktree 上执行只读测量分析，
  与 `experiment_command` 使用相同的占位符、远程 rsync/SSH、`remote.env` 和超时。
  输出 `{"status":"ok","findings":[...]}`，每条 finding 含 `id/title/axis/evidence/
  severity/actionable/measured`，至少一条 `measured:true`。该阶段在 limitations/seeds
  之前运行；`searchPolicy:"depth"`（默认）只追当前最高严重度缺陷。项目专属数学分析
  代码放在目标仓库并由 fixture 声明路径，RSI core 不导入它。
- `experiment_command`：在候选 worktree 中执行；支持占位符：
  `{scope}`、`{out}`、`{repo}`、`{commit}`、`{python}`（远程 Python）。
  **只放调用/协议参数**；训练步数、batch、长度、backend、数据路径等放在
  `remote.env`，避免两处重复。显式命令行 flag 仍可临时覆盖 env。
- 默认命令（未设置时）：
  `python3 run_experiment.py --scope {scope} --out {out}`。
- benchmark 必须把 metrics 写到 `--out`：

```json
{"metrics": {"word_ppl": 18.42}}
```

- `datasets` / `subset_datasets` 目前是 prompt/manuscript 元数据，**不会自动传给
  benchmark**；需要时在 `experiment_command` 里自己加参数，或在 benchmark 内固定。
- 代码不会复制：`runs/<run_id>/worktree` 是唯一 checkout；
  候选是目标仓库里的 `rsi/<run_id>-<hash>/<label>-N` 分支 + commit。

### 生成与验收目标自有 adapter

在 Pi 内直接调用 skill；它不仅接线，也检查并补全目标仓库缺失的数据加载、真实
训练、checkpoint 保存/重载及 lm-eval 指标实现：

```text
/skill:rsi-adapter examples/<project>.json --repo /path/to/independent/target
```

可选确定性 helper 只生成初始文件：

```bash
python3 skills/rsi-adapter/scripts/scaffold_adapter.py \
  --problem examples/<project>.json \
  --repo /path/to/independent/target \
  --name project
```

脚本直接写入目标 `experiment_command` 的规范 bench 路径（默认
`bench/rsi_project_train_eval.py`）和 `.rsi/adapter/project.json`、
`.rsi/adapter/project.md`。不要在 RSI 内生成安装脚本或项目实现；评测 helper、
训练修复和项目测试都提交到目标独立候选 ref。

把待验收 Problem 的 `repo_ref` 指向该候选，在 Pi 中执行：

```text
/rsi smoke examples/<project>.json --repo /path/to/independent/target --timeout 900 --env RSI_PROJECT_TRAIN_STEPS=1 --env RSI_PROJECT_TRAIN_BATCH_SIZE=1
```

原生工具 `rsi_adapter_smoke` 接受 `problem`、`repo`、`timeout_s`、可选 fresh `out`
证据目录和 `env` 对象。命令可重复传 `--env KEY=VALUE`；变量必须由目标支持，
仅覆盖本次冒烟，不改正式预算。显式 `out` 必须尚不存在。

验收必须真实执行 worktree → rsync → SSH → 真实数据微型训练 → checkpoint
保存/新进程重载 → lm-eval 有限指标 → 拉回原始 JSON 与日志，不调用 LLM。
未通过保持 `blocked / remote not verified`，不能以 mock、help、dry-run 或只
评测已有 checkpoint 交付可用 ref。证据、preflight 和目录隔离要求见
[`REMOTE.md`](REMOTE.md)。

## 远程 GPU 服务器

加 `remote` 后，`GitWorkspace` 会在本地提交候选 commit，然后：

1. `rsync -az --delete` 本地 worktree → 服务器；
2. `ssh` 在远程 worktree 执行 `experiment_command`；
3. `CUDA_VISIBLE_DEVICES=<gpu_ids>` 选择 GPU；
4. 取回 `{out}` JSON，写入本地 artifact。

服务器不需要联网或 git remote；模型/数据/依赖必须预装。详见
[`REMOTE.md`](REMOTE.md)。

## 运行与查看

以下完整 SOP 命令以 adapter 已通过真实远程冒烟、`repo_ref` 已固定为前提；
`--mock` 只替换 LLM，不替代 adapter 验收。

```text
/rsi run examples/dfm_ssm_external.json --mock --runner subprocess
/rsi run examples/dfm_ssm_external.json --runner subprocess --thinking low
/rsi inspect <run_id>
/rsi replay <run_id>
```

输出：

```text
runs/<run_id>/
  state.json      problem + config + traces + best_idea/best_evidence
  final.json      paper/review/meta/integrity/decision_path + code commit
  traces.jsonl    每次 LLM 调用、阶段转换、决策
  worktree/       唯一 git checkout
  patches/        每个候选的 diff + apply log
  artifacts/      benchmark 日志、manuscript.tex
```

`state.json` / `final.json` 里的 `code.commit`、`code.branch` 是候选代码的
真实身份；`worktree` 只是 checkout，不能代替 commit。

## 默认值在哪里改

| 想改的东西 | 文件 |
|---|---|
| 超参数（subset margin、review 阈值、refine 轮数、预算） | `src/rsi/config.ts` |
| 指标解释/严格改进定义 | `src/rsi/types.ts` |
| 方向过滤/排序 | `src/rsi/agents/ideas.ts` |
| critic 门 | `src/rsi/agents/critics.ts` |
| benchmark 执行/占位符 | `src/rsi/runtime/workspace.ts` |
| 具体项目的 benchmark | 目标仓库（例如 `/repos/mamba/bench/rsi_dfm_train_eval.py`） |
| 远程 GPU / rsync / SSH | `Problem.remote` + `src/rsi/runtime/workspace.ts`；见 `docs/REMOTE.md` |
