# 在哪里定义研究问题

RSI 的所有研究问题配置都在 **Problem JSON fixture** 里。扩展本身不知道任何具体项目；
你只需要提供三样东西：

| 你要定义的东西 | 字段 | 例子 |
|---|---|---|
| 指标 | `metrics` | `{"name":"mse","direction":"min","tolerance":0.01}` |
| 研究方向 | `domain`、`subfield`、`directions`、`forbidden`、`constraints` | 见下方完整示例 |
| 研究代码路径 | `repo`、`repo_ref`、`experiment_command` | `/repos/dfm-ssm`、`rsi-bench`、`bench/rsi_dfm_train_eval.py` |
| 远程 GPU / 路径映射 | `remote` | `host`、`worktree`、`out`、`python`、`setup`、`gpu_ids` |

最完整的真实示例：`examples/dfm_ssm.json`。合成示例：
`examples/ood_frozen_encoder.json`、`examples/meta_refine.json`。

## 完整注释示例

```jsonc
{
  "id": "dfm-ssm-wikitext-ppl",
  "statement": "Improve DFM-Mamba so wikitext word-ppl decreases after training.",
  "domain": "discrete flow matching / state space models",
  "subfield": "DFM-Mamba training and wikitext language modeling",
  "source_paper": "Mamba-3 (arXiv:2603.15569) with the DFM-Mamba path",

  // ── 研究代码路径（外部 git 仓库）────────────────────────────
  "repo": "/repos/dfm-ssm",        // 外部 git 仓库（compose 挂载）
  "repo_ref": "rsi-bench",         // 基线分支 / tag / commit；默认 HEAD
  "experiment_command": [          // 只放调用与占位符；参数放 remote.env
    "{python}", "bench/rsi_dfm_train_eval.py",
    "--repo", "{repo}",            // 候选 worktree 路径
    "--scope", "{scope}",          // subset / full / ablation / rebuttal
    "--out", "{out}"               // 必须写入 {"metrics": {...}} 的 JSON
  ],

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
| `reported_metrics` | 模拟/上下文；不是比较目标。subprocess 模式比较的是**复现的基线** |

实现：

- `src/rsi/types.ts` — `MetricSpec`、`metricDeltas()`、`isStrictlyBetter()`
- `src/rsi/config.ts` — `subsetMargin`、`minNovelty`、`reviewThreshold` 等
- `src/rsi/agents/critics.ts` — subset/full critic、ResultComparison

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
  推荐把宿主工作区挂到容器 `/repos`，然后写 `/repos/dfm-ssm`；也可以继续用
  `/workspace/RSI/vendor/dfm-ssm`。git 提交/分支发生在该仓库，不在 RSI 仓库。
- `repo_ref`：基线 ref；默认 `HEAD`。dfm 使用 `rsi-bench`，因为 benchmark
  脚本在目标仓库的那个分支上。
- `remote.worktree` / `remote.out`：本地项目路径到服务器路径的映射模板，支持
  `{run_id}`、`{repo}`。默认 `<remote.dir>/rsi/<run_id>/worktree`。
- `remote.python` / `remote.setup`：指定远程 Python 环境；`setup` 可执行
  `conda activate`、`module load` 等。
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

dfm-ssm 的准备：

```bash
./scripts/setup-dfm-ssm.sh
```

它克隆 `vendor/dfm-ssm`，并在目标仓库创建 `rsi-bench` 分支，放入
`bench/rsi_dfm_train_eval.py` 和 `bench/dfm_lm_eval.py`。

## 远程 GPU 服务器

加 `remote` 后，`GitWorkspace` 会在本地提交候选 commit，然后：

1. `rsync -az --delete` 本地 worktree → 服务器；
2. `ssh` 在远程 worktree 执行 `experiment_command`；
3. `CUDA_VISIBLE_DEVICES=<gpu_ids>` 选择 GPU；
4. 取回 `{out}` JSON，写入本地 artifact。

服务器不需要联网或 git remote；模型/数据/依赖必须预装。详见
[`REMOTE.md`](REMOTE.md)。

## 运行与查看

```text
/rsi run examples/dfm_ssm.json --mock --runner subprocess
/rsi run examples/dfm_ssm.json --runner subprocess --thinking low
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
| 具体项目的 benchmark | 目标仓库（例如 `vendor/dfm-ssm/bench/rsi_dfm_train_eval.py`） |
| 远程 GPU / rsync / SSH | `Problem.remote` + `src/rsi/runtime/workspace.ts`；见 `docs/REMOTE.md` |
