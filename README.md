# RSI — ScientistTwo on Pi

RSI 是 [ScientistTwo](https://arxiv.org/abs/2609.19644) 的 Pi 扩展实现：一个前台
agent 接单、路由和转述；后台按 §3.1–§3.6 推进研究。它不是独立应用，所有研究
命令都在容器内的 Pi 会话中执行。

当前 README 只描述**容器内的使用方式**，并以 `coral-rsi` 项目为例。

## 项目简介

### 研究闭环

```text
baseline（项目全局，实测）
  → limitations / seeds
  → subset 筛选（3 seeds × 95 步）
      → SubsetCritic
         ├─ invalid → 修复实现，不消耗工程轮
         ├─ 所有 seed 都差 → 淘汰
         ├─ 未达 margin → engineer
         └─ good → full 954 步
  → full 候选 / engineer
  → data gate（多轮 full good + ablation 归因）
  → paper loop（3 位独立 reviewer → rebuttal → meta-review）
```

关键约束：

- **目标项目拥有训练、checkpoint、评测和指标定义**；RSI 核心不导入目标项目代码。
- 候选只有在**实测**上严格优于 baseline 才会被采纳；`reported_metrics` 永远不能
  作为比较基线。
- baseline 是**项目全局**的，不属于某一次 run；见“Baseline 生命周期”。
- full baseline 是 **lazy** 的：只有第一个候选通过 subset 后才测 954；没有 full
  候选的 run 不会先花一次 full。
- subset 使用 3 个独立 seed，取均值；只有**所有 seed**都差于 baseline 才淘汰。
- invalid run（运行失败/无有效指标/某个 seed 失败）进入 engineer 修复，不占
  `maxEngRounds` 工程轮；只有修复预算耗尽才判 `bad`。
- 数据门槛未满足时 abort（`data_gate_not_met`），不写论文，但仍导出 evidence。
- 论文阶段要求 **3 位 reviewer 全部**达到 `reviewThreshold`；不是平均分过线。
- 所有实验协议、`repo_ref`、adapter 和指标定义都属于目标仓库；RSI 只消费契约。

### coral-rsi 示例

目标仓库：`/Users/liuxiaoyan/workspace/coral-rsi`（容器内 `/repos/coral-rsi`）。

- 指标：WikiText `word_ppl`，方向 `min`。
- 协议：full 954 步，warmup 25，effective batch 256，context 1024；subset 95 步。
- `repo_ref`：`rsi-bench`（已验收的 adapter 分支）。
- 远端：SSH host `8818`，目录 `/home/sl/coral-rsi`。
- adapter 入口：`bench/rsi_coral_train_eval.py --repo . --scope {scope} --out {out}`。

## 安装

### 前置条件

- 宿主机已安装 Docker；RSI 仓库可用。
- 目标仓库 `coral-rsi` 在宿主机存在，且已 checkout/可使用 `rsi-bench`。
- 容器能通过 SSH 访问 `8818`；`container/ssh` 由 `up.sh` 从宿主机生成。
- Pi 的 provider 凭据可用（示例为 `opencode-go`）。

### 1. 配置 `container/.env`

从 `container/.env.example` 复制，或使用 `up.sh creds` / `auth` 生成凭据：

```bash
# 在 RSI 仓库根目录执行；不要依赖固定的宿主机绝对路径
cd "$(git rev-parse --show-toplevel)"

./container/up.sh creds   # 复制 opencode-go key 到 container/.env
./container/up.sh auth    # 复制完整 Pi auth，包含 OAuth provider
```

`container/.env` 的关键项：

```dotenv
OPENCODE_API_KEY=sk-...
PI_PROVIDER=opencode-go
PI_MODEL=deepseek-v4.1-flash
PI_REASONING_LEVEL=high

# 宿主工作区挂到容器 /repos
RSI_EXTERNAL_ROOT=/Users/liuxiaoyan/workspace
# coral-rsi 在宿主机的位置，以及容器内路径
RSI_TARGET_HOST=/Users/liuxiaoyan/workspace/coral-rsi
RSI_TARGET_REPO=/repos/coral-rsi

# 项目全局 baseline；放在挂载的 RSI 仓库内，容器重建后仍保留
RSI_BASELINE_DIR=/workspace/RSI/.rsi-baseline

# superagent 授权；yolo 会自动接受实验
RSI_SUPERAGENT_POLICY=yolo
```

`container/compose.yaml` 已把宿主机 `RSI_TARGET_HOST` 挂载为容器
`/repos/coral-rsi`，并默认设置：

```dotenv
RSI_TARGET_REPO=/repos/coral-rsi
RSI_BASELINE_DIR=/workspace/RSI/.rsi-baseline
```

### 2. 构建并启动容器

```bash
./container/up.sh build
./container/up.sh run
./container/up.sh shell
```

- `build` 只在首次或 Dockerfile 变化时需要。
- 如果容器已存在，但 `compose.yaml` 的 env 发生变化（例如刚加入
  `RSI_BASELINE_DIR`），先重建容器：

```bash
./container/up.sh down
./container/up.sh run
./container/up.sh shell
```

- `shell` 会进入 `pi-agent-rsi` 的 bash；接着执行 `pi`。
- 也可以直接运行 `./container/up.sh pi`。

### 3. 验证容器环境

在宿主机执行：

```bash
./container/up.sh exec bash -lc '
  cd /workspace/RSI &&
  node --version &&
  git -C /repos/coral-rsi rev-parse --abbrev-ref HEAD &&
  ssh 8818 true &&
  echo container-ok
'
```

应看到：

- `node` 可用；
- `/repos/coral-rsi` 的当前分支（示例为 `rsi-bench`）；
- `ssh 8818 true` 成功；
- `container-ok`。

如果 SSH 失败，检查宿主机 `~/.ssh/config`，然后重新生成容器 SSH 配置：

```bash
./container/up.sh ssh
```

## 使用

以下命令默认都在容器内执行。宿主机只负责 `./container/up.sh` 控制容器。

### 1. 进入 Pi

```bash
./container/up.sh shell
pi
```

或：

```bash
./container/up.sh pi
```

进入 Pi 后可以检查入口：

```text
/rsi help
```

### 2. 重建或确认 coral adapter

当前 `rsi-bench` 上的 adapter 以 `git rev-parse rsi-bench` 为准。历史上的
`34e581e` 加入 ablation scope 和 95-step screen；后续提交又补齐了
`bench/rsi_coral_diagnose.py`、`.rsi/adapter/coral.json`、`.rsi/adapter/coral.md`
和 `tests/test_adapter_contract.py`。如果只是从 `main` 恢复当前已验证 adapter：

```bash
cd /repos/coral-rsi

# 保存当前 adapter commit（不要硬编码旧的 34e581e）
ADAPTER=$(git rev-parse rsi-bench)

git fetch --all
git switch main
git switch -C rsi-bench

git checkout "$ADAPTER" -- \
  ADAPTER.md \
  .rsi/adapter \
  bench/rsi_coral_train_eval.py \
  bench/rsi_coral_diagnose.py \
  bench/rsi_job_worker.py \
  scripts/eval_arch_v1_wikitext.py \
  tests/test_adapter_contract.py

git add \
  ADAPTER.md \
  .rsi/adapter \
  bench/rsi_coral_train_eval.py \
  bench/rsi_coral_diagnose.py \
  bench/rsi_job_worker.py \
  scripts/eval_arch_v1_wikitext.py \
  tests/test_adapter_contract.py

git commit -m "feat(adapter): CORAL train/eval, diagnosis, manifest and contract tests"
git log --oneline -2
```

如果要真正重写 adapter（补数据加载、训练、checkpoint、lm-eval 链路），在 Pi 里：

```text
/skill:rsi-adapter examples/coral.json --repo /repos/coral-rsi
```

不要用 `scaffold_adapter.py` 直接覆盖当前已验证 adapter；它只生成带 TODO 的骨架。

### 3. adapter 重建后清除旧 baseline

adapter 代码变化后，旧 baseline 不能继续绑定。当前 baseline 是项目全局的：

```bash
ls -d /workspace/RSI/.rsi-baseline/coral-wikitext-ppl-* 2>/dev/null || true
rm -rf /workspace/RSI/.rsi-baseline/coral-wikitext-ppl-*
```

如果设置了外部 `RSI_BASELINE_DIR`，删除对应目录下的
`coral-wikitext-ppl-*`。

注意：仓库里的
`baseline-coral-wikitext-ppl-025b-manual.json` 指向 commit `aa6a63bf`，该 commit
当前不在 `coral-rsi` 中。不要把它传给 `--baseline`；否则会因 commit 不存在而
被拒绝。让新 run 自己测 baseline。

### 4. adapter smoke

重建后先跑真实小预算 smoke：

```text
/rsi smoke examples/coral.json \
  --repo /repos/coral-rsi \
  --timeout 900 \
  --env RSI_CORAL_TRAIN_STEPS=2 \
  --env RSI_CORAL_TRAIN_BATCH_SIZE=1 \
  --env RSI_CORAL_EVAL_LIMIT=1 \
  --env RSI_CORAL_TIMEOUT=600 \
  --env RSI_CORAL_SEED=2026
```

成功后生成：

```text
runs/adapter-smoke-<id>/artifacts/smoke-summary.json
```

这个 receipt 是 `/rsi iterate` 的 `--adapter-acceptance` 输入；`/rsi run` 不强制
要求 receipt，但建议先 smoke 通过再跑完整 SOP。

### 5. 运行完整 RSI

`examples/coral.json` 的 `repo` 是 `${RSI_TARGET_REPO}`；容器已把它设为
`/repos/coral-rsi`。`/rsi run` 没有 `--repo` 参数。

```text
/rsi run examples/coral.json \
  --runner subprocess \
  --seed 7 \
  --out runs \
  --wait
```

说明：

- `--runner subprocess` 必须显式指定；不能用默认 `simulated`。
- provider/model 继承容器 `PI_PROVIDER` / `PI_MODEL`；也可以在命令中加
  `--provider` / `--model` 覆盖。
- `--wait` 在交互会话中会阻塞到 run 结束；`pi -p` 无头模式必须加。
- 不要加 `--mock`；不要传旧的 `--baseline` 文件。
- 第一次 full baseline 会在候选通过 subset 后 lazy 测量；不会在 run 开始就先
  花一次 954。
- 这个 run 会走 subset → full → data gate → ablation → paper，耗时可长达数小时。

### 6. 状态、检查、停止和恢复

```text
/rsi status
/rsi status <run_id>
/rsi tickets <run_id>
/rsi ticket <run_id> <ticket_id>
/rsi events <run_id>
/rsi inspect <run_id>
/rsi replay <run_id>
/rsi stop <run_id> <ticket_id> [reason]
/rsi resume <run_id>
```

语义：

- `status` 读协议状态，不把完整 `state.json` 灌进上下文。
- `inspect` 汇总一次 run；`replay` 只用 traces 重建决策路径。
- `stop` 是最终操作，停止后的 run 不能再 resume。
- `failed` 但仍未结束的 run 可以 resume；`data_gate_not_met` 的 abort 会保留
  evidence，并在 `final.json` 标记 `aborted`。
- 远端实验的停止会终止远端进程组，不只是断开 SSH。

### 7. 单轮 bounded iteration

如果只授权一次小预算优化，用 `/rsi iterate`，不要用会继续 full/ablation/paper
的 `/rsi run`。它必须带 smoke receipt：

```text
/rsi iterate examples/coral.json \
  --adapter-acceptance runs/adapter-smoke-<id>/artifacts/smoke-summary.json \
  --repo /repos/coral-rsi \
  --out runs/iteration-coral-1 \
  --seed 2026 \
  --coding-max-tokens 32768 \
  --env RSI_CORAL_TRAIN_STEPS=2 \
  --env RSI_CORAL_TRAIN_BATCH_SIZE=1 \
  --env RSI_CORAL_EVAL_LIMIT=1 \
  --env RSI_CORAL_TIMEOUT=600 \
  --env RSI_CORAL_SEED=2026
```

- 默认 `--scope subset`；只测候选并与项目 baseline 比较。
- 只有严格更优才晋升，并把候选 commit 写入项目 baseline。
- `--scope full` 才建立正式 full baseline；不会启动 ablation 或 paper。
- `--baseline-mode paired` 可强制每轮复测 baseline；默认 `reuse`。

### 8. Baseline 生命周期

baseline 是**项目全局**的，所有 run 共享：

```text
/workspace/RSI/.rsi-baseline/<project-key>/
  incumbent-coral-wikitext-ppl-subset.json
  incumbent-coral-wikitext-ppl-full.json
```

- `project-key` = problem id + target repo 路径 hash。
- 初始 baseline 测量后立即写入；full baseline 是 lazy 的，第一个 full 候选时写入。
- `select` 采纳候选时，subset 和 full 两个 scope 一起 promote。
- 下一次 run 直接复用，不再因为换 `--out` 或重建容器而重测。
- 协议、seed、commit、指标或证据哈希不匹配时，会重新测量并覆盖当前项目 baseline。
- 旧 run 目录下的 `runs/incumbent-*.json` 会在首次加载时迁移到项目全局目录。
- adapter 重建后必须清除对应项目 baseline，见第 3 节。

### 9. 远端和 GPU

`examples/coral.json` 的 `remote` 指向：

```jsonc
{
  "host": "8818",
  "dir": "/home/sl/coral-rsi",
  "python": "/home/sl/coral-eval-env-recovery-20261109-1345/.eval-venv/bin/python",
  "gpu_ids": "0"
}
```

- 候选 worktree 会通过 rsync 同步到远端；不需要手动 push adapter。
- SSH/rsync 使用 `container/ssh` 中的宿主机配置。
- 启动新 run 前，检查是否还有旧训练进程：

```bash
ssh 8818 'pgrep -af rsi_coral_train_eval.py || true'
```

如果有旧 PID，先手动终止，再启动新 run。

full 协议固定为 954 步；不要为了省时间传
`RSI_CORAL_TRAIN_STEPS`/`RSI_CORAL_EVAL_LIMIT` 缩短 full。subset 由
`Problem.budget` 注入 95 步，属于正式筛选协议的一部分。

### 10. 产物

每次 run 写入：

```text
runs/<run_id>/
  state.json        完整研究状态
  traces.jsonl      追加式 LLM/阶段/决策记录
  final.json        paper、review、meta-review、integrity、decision_path
  artifacts/        final.tex、实验日志、原始报告
  patches/          候选 diff 与 apply 日志
  worktree/         本次 run 的 git worktree
```

项目全局 baseline 在 `/workspace/RSI/.rsi-baseline/`，不在单个 run 里。

## 进一步阅读

- [`docs/SPEC.md`](docs/SPEC.md)：论文阶段、超参数、数据门槛和协议。
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：代码结构、状态机、终止条件。
- [`docs/PROBLEM.md`](docs/PROBLEM.md)：Problem fixture 契约和 adapter 约定。
- [`docs/REMOTE.md`](docs/REMOTE.md)：rsync/SSH/GPU 执行和远端清理。
- [`docs/SUPERAGENT.md`](docs/SUPERAGENT.md)：run/task ticket、policy、answer/stop。
- `coral-rsi/ADAPTER.md`：coral adapter 的 scopes、环境变量和验收证据。
