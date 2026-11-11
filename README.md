# RSI — 作为 Pi 扩展的 ScientistTwo

这是对以下论文的忠实、可运行实现：

> **ScientistTwo: Pioneering the Human Knowledge Frontier with Autonomous AI**
> Nam, Yoon, Pan, Wang, Meng, Ranganathan, Pfister — Google Cloud AI Research
> [arXiv:2609.19644](https://arxiv.org/abs/2609.19644)

实现形态是 **Pi（pi-agent）包 / 扩展**，而不是独立应用。闭环
`candidate → critic → refine` 在 Pi 内运行；模型调用走 Pi 的 provider
注册表，默认路由为 `opencode-go/deepseek-v4.1-flash`。

论文的核心是一个闭环、自我改进的多智能体研究系统。唯一允许把假设提升为
incumbent 的条件，是相对于**复现基线**的严格更优测量。论文和代码库是输出，
闭环本身才是目的。

| 论文 | 本包实现 |
|---|---|
| §3.1 limitations → seed ideas → novelty filter | `src/rsi/agents/limitations.ts`、`agents/ideas.ts` |
| §3.2 subset → critic → engineer → full-set | `src/rsi/agents/coding.ts`、`critics.ts`、`engineering.ts`、`runtime/workspace.ts` |
| §3.3 idea evolution from execution traces | `src/rsi/agents/ideas.ts`、`core/orchestrator.ts` |
| §3.4 ablations + attribution | `src/rsi/agents/ablation.ts` |
| §3.5 draft → peer review → rebuttal experiments | `src/rsi/agents/writing.ts`、`review.ts` |
| §3.6 meta-review → idea refinement → re-draft | `src/rsi/agents/review.ts`、`core/orchestrator.ts` |
| §4.3 integrity audit（score/spec/refs/method-code） | `src/rsi/agents/integrity.ts` |
| Listing 1 stage 抽象 | `src/rsi/core/stage.ts` |
| 附录 A.2 超参数 | `src/rsi/config.ts`（每个值标注 `[PAPER]` / `[CHOICE]`） |

## 扩展暴露的入口

| 入口 | 作用 |
|---|---|
| `rsi_research` 工具 | 接受一次研究请求；立即返回 run id 与 ticket id，SOP 在后台 task ticket 中运行（`wait: true` 才阻塞） |
| `rsi_superagent` 工具 | `status`、`tickets`、`ticket`、`events`、`policy`、`answer`、`note`、`retry`、`stop`、`attach` |
| `rsi_inspect` 工具 | 汇总一次 run；运行中则返回协议状态，不把完整 state 灌进上下文 |
| `rsi_replay` 工具 | 只用 traces 重建决策路径；不调用模型、不访问 workspace |
| `/rsi` 命令 | `run`、`status`、`tickets`、`ticket`、`events`、`policy`、`answer`、`note`、`retry`、`stop`、`wait`、`inspect`、`replay`、`list`、`models`、`help` |
| `rsi-superagent` skill | 前台 agent 的协议操作说明：接受、转述、回答、停止、策略 |
| `rsi-research` skill | 快速上手与排错 |
| `/rsi-research` prompt | 一次性“派工 → 等待报告 → inspect → replay →（可选）真实运行”工作流 |

### 一个前台 agent + superagent 协议

RSI 扩展本身就是
[`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)
协议的宿主：你只和一个前台 agent（当前 Pi 会话）对话，它只做接单、路由和转述，
不亲自跑研究。一次研究是一张 **run ticket**，由 SOP driver 以 §3.1–§3.6 推进；
SOP 内部每一次 agent 调用都是 **task ticket**，由 worker（默认是独立 Pi 会话，
`agents=inline` 时是同协议的进程内调用）执行并回传结构化 **report**。

- **授权**：`policy` 有 `off` / `observe`（默认）/ `auto` 三种接单模式；只有明确
  对人的请求才自动接单，自动观测（benchmark、review、定时任务）最多只能延续已
  订阅的 run。`sop.spend` 需要明确请求，`sop.experiment` 需要人确认。
- **报告**：只有 run 结束、受阻、失败或提问时才通知前台；task 级进度不打扰人。
  问题会变成 **attention**，`rsi_superagent action=answer` 是唯一能让它继续的操作。
- **数值门不可被模型翻转**：promotion 只能由“相对复现基线的严格实测提升”产生；
  策略只能决定谁可以花钱、导出，不能决定哪个候选更好。
- **持久化**：`runs/<run_id>/superagent/state.json`（ticket、mandate、decision）
  与 `events.jsonl`（有序领域事件）；每个命令原子落盘。重启后不会假装恢复半个
  SOP：run 会以 blocked + 恢复问题结束，由人决定是否新开一次 run。

完整协议、概念与工具见 [`docs/SUPERAGENT.md`](docs/SUPERAGENT.md)，提示词与
worker 契约在 `prompts/superagent/`。

## 快速开始（容器）

```bash
cd "/Users/liuxiaoyan/workspace/RSI "

./container/up.sh creds      # opencode-go key → container/.env
./container/up.sh auth       # 完整 ~/.pi/agent/auth.json → 容器（含 OAuth provider）
./container/up.sh build      # 仅首次需要
./container/up.sh run
./container/up.sh shell      # 然后执行：pi
```

`container/pi-home/settings.json` 已经配置：

```json
{
  "defaultProvider": "opencode-go",
  "defaultModel": "deepseek-v4.1-flash",
  "packages": ["/workspace/RSI", "npm:pi-web-search"]
}
```

进入 Pi 后：

```text
/rsi help
/rsi run examples/ood_frozen_encoder.json --mock
/rsi inspect ood-frozen-encoder-s7
/rsi replay ood-frozen-encoder-s7
```

mock 运行是确定性的、免费的，几秒内就能跑到实验阶段。provider 运行会消耗
真实调用，并先弹确认。

详见 [`docs/CONTAINER.md`](docs/CONTAINER.md)、
[`docs/PROVIDER.md`](docs/PROVIDER.md)。

## 快速开始（离线 CLI，无需 Pi / API key）

```bash
node src/rsi/cli.ts run examples/ood_frozen_encoder.json --mock
node src/rsi/cli.ts inspect ood-frozen-encoder-s7
node src/rsi/cli.ts replay  ood-frozen-encoder-s7
npm test
npm run typecheck
```

每次 run 写入：

```text
runs/<run_id>/
  state.json        运行结束时的完整研究状态
  traces.jsonl      只追加：每次 LLM 调用、阶段转换、决策
  final.json        paper、review、meta-review、integrity、decision_path
  artifacts/        final.tex、模拟/溯源实验日志
  worktree/         本次 run 的 git worktree（所有候选共用一个 checkout）
  patches/          每个候选的 diff 与 git apply 日志
```

## 指向真实模型

扩展使用 Pi 的 model registry，因此任何已认证的 Pi provider 都可直接用：

```text
rsi_research { problem: "...", provider: "opencode-go", model: "glm-5.3-flash" }
```

容器内可用环境变量覆盖：

```bash
RSI_MODEL=glm-5.3-flash
RSI_CODING_MODEL=kimi-k3     # coding / ablation / rebuttal / draft_enhancer
```

`opencode-go` 需要 `x-opencode-session` 头；嵌套调用和 worker 会话会自动
携带 Pi 的 session id。凭据复制、验证和排错见
[`docs/PROVIDER.md`](docs/PROVIDER.md)。

### 联网检索

容器安装了 [`pi-web-search`](https://github.com/ttttmr/pi-web-search)，使用
provider 原生 web search（无需额外搜索 API key）。`web_search` 使用
`container/pi-home/web-search.json` 指定的检索模型：

```json
{ "provider": "opencode-go", "model": "gpt-5.6-luna" }
```

RSI 的 novelty 与 reference-audit worker 会自动获得 `web_search` 工具，用来
检索真实文献；其他 agent 不联网，避免生成阶段被搜索结果污染。

## 探索方向引导（超出论文）

论文允许 agent 自由选择方向；`Problem` 带有一层研究方向约束：

```json
{
  "domain": "time series forecasting",
  "subfield": "zero-shot / retrieval-augmented",
  "directions": [
    { "id": "d1", "title": "spectral priors", "description": "DMD/FFT constraints",
      "keywords": ["DMD", "spectral"], "weight": 1.0, "must_include": false },
    { "id": "d2", "title": "safety gating", "description": "no-harm fallback",
      "weight": 0.8, "must_include": true }
  ],
  "forbidden": ["finetuning the backbone"]
}
```

- 引导只进入**生成阶段**，绝不进入 critic 的算术；
- 排序分数为 `novelty + guidance_weight · domain_fit`；
- `must_include` 只有在 `strict_directions: true` 时才是硬门；
- 每个 `Idea` 记录 `direction_ids`；manuscript 必须提到某个方向；
- 离线模拟器包含 `domain_fit` 项，所以有引导/无引导的 run 在测试中可区分。

## Git 原生与严格解耦

- 目标项目是**外部 git 仓库**；RSI 不为每个候选复制目录。
- 每个候选是目标仓库中的 **branch + commit**（`rsi/<run_id>/<label>`）；
  一个 run 只使用一个 `git worktree`（`runs/<run_id>/worktree`），所有候选复用。
- `RepoRef` 记录 `repo`、`commit`、`branch`、`parent`；最终状态和 `final.json`
  都以 commit 为代码身份，`worktree` 路径只是临时 checkout。
- `Problem` 只暴露通用契约：`repo`、`repo_ref`、`experiment_command`
  （`{scope}`、`{out}`、`{repo}`、`{commit}`）。RSI 核心不导入目标项目，
  不知道 Mamba、DFM 或任何项目细节。
- 项目基准属于目标项目本身。`integrations/` 只是可选适配器模板，不在 Pi
  扩展加载路径内，也不被 `src/rsi/` 引用。

## 目标仓库：dfm-ssm

针对真实 Mamba + DFM 仓库的 fixture 在 `examples/dfm_ssm.json`，默认指向
`vendor/dfm-ssm`（不进入 git）。准备：

```bash
./scripts/setup-dfm-ssm.sh
```

该脚本克隆 `git@gitlab.com:Liu-Xiaoyan97/dfm-ssm.git`，并在目标仓库内创建
`rsi-bench` 分支，放入 `bench/rsi_dfm_train_eval.py` 和 `bench/dfm_lm_eval.py`。
指标是 **wikitext word-ppl**（lm-eval 的 `word_perplexity`，越低越好）：
先训练 DFM-Mamba checkpoint，再用 lm-eval 在 wikitext 上评测。

GPU 服务器通过通用 `remote` 配置执行：本地 git worktree 用 `rsync` 同步到
服务器，SSH 远程运行，`gpu_ids` 写入 `CUDA_VISIBLE_DEVICES`；服务器不需要联网。
详见 [`docs/REMOTE.md`](docs/REMOTE.md)。

coding agent 会拿到 git commit 上的目录树 + 相关源码摘要，返回 unified diff；
workspace 在目标仓库的 **git worktree** 上执行 `git apply`，并把候选写成
`rsi/<run_id>/<label>` 分支上的 commit。不会为每个候选复制文件；diff 失败会写入
`patches/*.apply.log` 并保持父 commit 不变，绝不伪造测量提升。真实优化运行建议
在装有依赖的机器上执行，并把结果写回 `runs/<run_id>/`。

## 容器内交互运行远程 RSI（GPU）

这一节是实际操作手册。RSI 在容器里运行，目标代码在外部 GPU 服务器上训练/评测；
**只上传目标仓库的 worktree，不上传 RSI 项目本身**。

### 已经准备好的部分

- 容器：`pi-agent-rsi`，Pi 自动加载 `/workspace/RSI` 与 `npm:pi-web-search`
- 远程：SSH 别名 `8818`，用户 `sl`，GPU 0（A800 80GB）
- 容器 SSH：`/root/.ssh/config`，通过 `socat` + `host.docker.internal:7890` 出网
- 目标仓库：`vendor/dfm-ssm` 的 `rsi-bench` 分支
- benchmark：`bench/rsi_dfm_train_eval.py` + `bench/dfm_lm_eval.py`
- 指标：lm-eval `wikitext` 的 `word_perplexity`（`word_ppl`，越低越好）
- 服务器 smoke 资产：`/home/sl/rsi-data/{tiny-mamba,tokenizer,train.jsonl}`

### 1. 进入容器和 Pi

```bash
cd "/Users/liuxiaoyan/workspace/RSI "
./container/up.sh shell

# 容器内
cd /workspace/RSI
pi
```

### 2. 给 superagent 最高权限

`runner=subprocess` 默认会被 `sop.experiment` 的 `person` 规则挡住。两种方式：

**当前会话立即放开：**

```text
/rsi policy allow
```

**启动时默认放开：**

```bash
RSI_SUPERAGENT_POLICY=yolo pi
```

容器 compose 默认已经是 `RSI_SUPERAGENT_POLICY=yolo`；如果当前容器是旧进程，
用上面的 `/rsi policy allow` 或重启容器即可。

### 3. 先跑 mock 远程链路（不花 LLM 费用）

```text
/rsi run examples/dfm_ssm.json --mock --runner subprocess --max-refine-rounds 0 --max-review-refinements 0
```

查看状态：

```text
/rsi status <run_id>
/rsi inspect <run_id>
```

### 4. 真实 provider + GPU 0

```text
/rsi run examples/dfm_ssm.json --runner subprocess --thinking low --max-refine-rounds 0 --max-review-refinements 0 --max-llm-calls 120 --max-wall-time-s 3000
```

如果仍然出现 Attention：

```text
/rsi status <run_id>
/rsi tickets <run_id>
/rsi answer <run_id> <ticket_id> "Approved: prepared offline DFM environment on server 8818, GPU 0, real remote benchmark."
/rsi wait <run_id>
```

结束后：

```text
/rsi inspect <run_id>
/rsi replay <run_id>
```

### 5. 不走 superagent 的 CLI 方式

在容器内：

```bash
cd /workspace/RSI

NODE_USE_ENV_PROXY=1 node src/rsi/cli.ts run examples/dfm_ssm.json   --provider opencode   --model deepseek-v4.1-flash   --runner subprocess   --max-refine-rounds 0   --max-review-refinements 0   --max-llm-calls 120   --max-wall-time-s 3000   --out runs   --seed 7
```

CLI 不经过 superagent 的 `person` 门，适合先验证远程链路。

### 6. 改 GPU / 训练预算

`examples/dfm_ssm.json`：

```jsonc
"remote": {
  "host": "8818",
  "dir": "/home/sl/rsi",
  "python": "/home/sl/coral-eval-env-recovery-20261109-1345/.eval-venv/bin/python",
  "gpu_ids": "0",              // 改成 "1" / "0,1" 选择 GPU
  "timeout_s": 3600,
  "env": {
    "RSI_DFM_BASE_MODEL": "/home/sl/rsi-data/tiny-mamba",
    "RSI_DFM_TOKENIZER": "/home/sl/rsi-data/tokenizer",
    "RSI_DFM_TRAIN_DATA": "/home/sl/rsi-data/train.jsonl",
    "RSI_DFM_BACKEND": "reference",
    "RSI_DFM_TRAIN_STEPS": "2"
  }
}
```

训练预算同时出现在 `experiment_command`：

```jsonc
"--train-steps", "2",
"--train-batch-size", "2",
"--grad-accum", "2",
"--max-length", "256",
"--lm-eval-batch-size", "1",
"--eval-max-length", "512",
"--flow-time", "off"
```

- `gpu_ids` 直接写入 `CUDA_VISIBLE_DEVICES`；RSI 不做 GPU 排队/锁卡。
- 多卡只提供可见性；DDP 需要在目标仓库 benchmark/trainer 内实现。
- `RSI_DFM_BACKEND=reference` 是纯 PyTorch Mamba 路径；服务器装了
  `selective_scan_cuda` 后可改 `native`。
- `flow_time=off` 用 causal backbone 计算 lm-eval logits；改成 `1.0` 走
  DFM forward，需与你们的评测协议一致。

### 7. 换成真实模型/数据

当前 `tiny-mamba` 是 3.3M 随机初始化模型，`word_ppl` 只是链路验证，不是科学结果。
要得到有意义的 word-ppl，把 `remote.env` 指向服务器上的真实资产：

```jsonc
"RSI_DFM_BASE_MODEL": "/path/to/real-mamba-or-dfm",
"RSI_DFM_TOKENIZER": "/path/to/tokenizer",
"RSI_DFM_TRAIN_DATA": "/path/to/train.jsonl"
```

同时提高 `--train-steps`、`--max-length`、batch size 和 `remote.timeout_s`。
服务器离线时，`lm-eval` 的 wikitext 数据集必须已缓存在
`HF_DATASETS_CACHE`，模型/tokenizer 必须本地存在。

### 8. 远程目录与本地产物

服务器每次 run：

```text
/home/sl/rsi/rsi/<run_id>/
  worktree/        # 从本地 git commit rsync 过去的候选代码（无 .git）
  out/             # checkpoint、lm-eval 结果、metrics JSON
```

本地：

```text
runs/<run_id>/
  state.json
  final.json
  traces.jsonl
  worktree/        # 本地唯一 git checkout
  patches/         # 每个候选的 diff + apply.log
  artifacts/experiments/remote-*.json
```

`state.json` / `final.json` 的 `code.commit`、`code.branch` 是候选代码的真实身份。

### 9. 当前容器的注意点

`ssh` / `rsync` / `socat` 是装在当前运行容器里的；如果 `down` 后重建容器，需要重装：

```bash
./container/up.sh exec bash -lc '
apt-get -o Acquire::http::Proxy=http://host.docker.internal:7890         -o Acquire::https::Proxy=http://host.docker.internal:7890 update -qq &&
DEBIAN_FRONTEND=noninteractive apt-get   -o Acquire::http::Proxy=http://host.docker.internal:7890   -o Acquire::https::Proxy=http://host.docker.internal:7890   install -y -qq openssh-client rsync socat
'
```

SSH key/config 在宿主 `container/ssh/`，已 gitignore，不会进入仓库。

## 设计保证

| 纯数值决策（模型无法翻转） | 模型可追加意见 |
|---|---|
| `ResultComparison`（采纳，I2） | `SubsetCritic` / `FullSetCritic` 的理由 |
| `Selector` 排序 | `AblationCritic`（可否决 GOOD） |
| `SpecAuditor.hard_violations` | `SpecAuditor` 额外违规 |
| `ReferenceAuditor.unknown_refs` | 额外违规 |
| `MethodCodeAuditor.lexical_alignment` 下限 | 只能向上修正 |
| `verify_scores` | — |

模型可以**阻止** promotion，但绝不能**导致** promotion。`accepted: true` 还要求
peer score ≥ 阈值、meta `accept`、integrity 审计干净；否则导出 incumbent 并记录
`export_reason`。`aborted: true` 表示科学上的死胡同或硬预算停止——这是诚实的
结果，不是 harness 故障。

离线模拟器约 20% 的失败率校准自论文报告的 80.4%（86/107）改进率，因此 mock
run 会同时覆盖成功与失败分支。

## 代码结构

```text
extensions/rsi.ts          Pi 扩展入口：工具 + /rsi 命令（前台 agent）
src/rsi/                   TypeScript 移植
  superagent/              superagent 协议：model、store、policy、sop、engine、
                           executor、runtime、tools、prompts
  core/                    orchestrator、state、Listing 1 stage
  agents/                  §3.1–§3.6 agents、critics、integrity
  providers/               Pi registry、PiWorker/SuperagentLLMProvider、离线 mock、CLI
  runtime/                 budget、artifact/trace store、workspace runners
  types.ts, config.ts      冻结模型、超参数
skills/rsi-superagent/     前台 agent 的协议操作说明
skills/rsi/SKILL.md        快速上手与排错
prompts/superagent/        orchestrator / worker / dispatch / replies / policy
prompts/rsi-research.md    /rsi-research prompt 模板
tests/                     node:test 套件（离线、无网络）
container/                 Dockerfile、compose、Kiri 辅助脚本、pi-home 配置
examples/                  Problem fixtures + mock script（含 dfm_ssm.json）
integrations/dfm_ssm/      dfm-ssm 的 train + lm-eval 适配器（可选，不属于核心）
scripts/                   仓库准备脚本
docs/                      SPEC、ARCHITECTURE、PROVIDER、CONTAINER、论文分析
legacy/python/             原 Python 实现（可执行规范）
```

## 测试

```bash
npm test            # 87 个离线测试：types、stage、mock、orchestrator、gates、replay
npm run typecheck   # tsc --noEmit，使用 ambient Pi 类型，不复制宿主包
```

覆盖重点：严格改进语义、subset/full/ablation 门、engineering 预算范围、guidance
门、review 循环、meta 改进、integrity 检查、artifact/replay 契约，以及成功和
abort 两条路径。

Python 参考实现仍可运行：

```bash
cd legacy/python
PYTHONPATH=src python3 -m pytest -q      # 134 passed
```

## 保真边界：这不是什么

- 论文中的数字（`86/107`、`+25.2%`、ScholarPeer/Stanford 分数）是其基础设施的
  评测结果，不在此复现。本仓库复现的是**机制**，并逐条标注 `[PAPER]` /
  `[CHOICE]` / `[INFERENCE]` / `[EXTENSION]`。
- `examples/ood_frozen_encoder.json` 是**合成** fixture，借用 Procrustes-DS 的
  任务框架；指标是占位值。
- `examples/meta_refine.json` + `examples/mock_script.json` 是**合成续写**，用于
  覆盖 §3.5 rebuttal 与 §3.6 meta-refinement。
- 模拟 runner 不是科学基准。`runner: "subprocess"` 会执行目标仓库的
  `run_experiment.py`；真实运行完全可能诚实地无法超过复现基线。
- `final.json` 记录 `runner`、`accepted`、`export_reason`；不要把 `accepted`
  理解为外部同行评审或论文录用。

## 阅读顺序

1. `docs/SPEC.md` — 契约：不变量、状态机、冻结模型、离线确定性规则。
2. `docs/SUPERAGENT.md` — superagent 协议：概念映射、授权、报告、工具、持久化。
3. `docs/ARCHITECTURE.md` — 模块 ↔ agent ↔ 论文章节的对应关系。
4. `docs/PROBLEM.md` — 在哪里定义指标、研究方向、研究代码路径。
5. `docs/REMOTE.md` — rsync + SSH 到 GPU 服务器、GPU 选择、离线服务器。
6. `docs/CONTAINER.md` / `docs/PROVIDER.md` — 运行 Pi 与 opencode-go。
7. `docs/analysis/*.md` — 论文逐节提取。
8. `legacy/python/README.md` — 可执行的 Python 参考实现。
