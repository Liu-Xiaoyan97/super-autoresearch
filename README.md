# RSI — ScientistTwo on Pi

RSI 是 ScientistTwo 的 Pi 扩展实现：一个前台 agent 接单，后台按
`limitations → seeds → subset → full → paper` 推进研究。所有研究命令都在容器内的
Pi 会话中执行；目标项目的训练、checkpoint、评测和指标代码属于目标仓库。

## 项目简介

- **代码循环**：实测 baseline → subset 筛选 → full 954 → data gate → ablation。
- **论文循环**：draft → 3 位独立 reviewer → rebuttal → meta-review。
- **测量原则**：候选只有严格优于实测 baseline 才会被采纳；`reported_metrics`
  不能作为比较基线。
- **baseline**：项目全局，不绑定单次 run；full baseline lazy 测量。
- **subset**：3 个 seed × 95 步（Coral），用于判断 candidate 是否值得进入 full。
- **目标项目独立**：RSI 不导入目标项目代码；adapter、训练、评测和测试都在目标仓库。
- **adapter 验收与研究运行分离**：adapter skill 只验证“能训练、能存 checkpoint、
  能重载、能评测”；subset/full/paper 属于独立的 RSI 研究运行。

## 安装（仅容器）

### 1. 配置 `container/.env`

```dotenv
OPENCODE_API_KEY=sk-...
PI_PROVIDER=opencode-go
PI_MODEL=deepseek-v4.1-flash

RSI_EXTERNAL_ROOT=/Users/liuxiaoyan/workspace
RSI_TARGET_HOST=/Users/liuxiaoyan/workspace/coral-rsi
RSI_TARGET_REPO=/repos/coral-rsi

# 项目全局 baseline；放在 runs/ 外，避免被 run 清理删除
RSI_BASELINE_DIR=/workspace/RSI/.rsi-baseline

RSI_SUPERAGENT_POLICY=yolo
```

凭据可以用：

```bash
cd "$(git rev-parse --show-toplevel)"
./container/up.sh creds
./container/up.sh auth
```

### 2. 构建并启动

```bash
./container/up.sh build
./container/up.sh run
./container/up.sh shell
```

容器已存在但挂载或 env 改变时，先重建：

```bash
./container/up.sh down
./container/up.sh build
./container/up.sh run
```

### 3. 验证

在宿主机：

```bash
./container/up.sh exec bash -lc '
  ls -la /repos/coral-rsi &&
  git -C /repos/coral-rsi status --short --branch &&
  ssh 8818 true
'
```

进入 Pi：

```bash
./container/up.sh shell
pi
```

```text
/rsi help
```

## 使用：coral-rsi

目标仓库在容器内是 `/repos/coral-rsi`，远端是 `8818:/home/sl/coral-rsi`。

> Pi 的研究命令按 `/workspace/RSI` 作为 cwd 编写。如果你是在 `/repos/coral-rsi`
> 里启动 Pi，请使用下面的绝对路径；否则 `examples/coral.json` 会被解析成
> `/repos/coral-rsi/examples/coral.json` 并报 `problem file not found`。

### 1. 重建 adapter

Adapter 只能修改 `/repos/coral-rsi`，不能修改 `/workspace/RSI`。

```bash
cd /repos/coral-rsi

# 可选：备份旧 adapter
git branch backup/rsi-bench-$(date +%Y%m%d-%H%M%S) rsi-bench 2>/dev/null || true

git switch main
git branch -D rsi-bench 2>/dev/null || true
git switch -c rsi-bench
```

在 Pi 中重建：

```text
/skill:rsi-adapter /workspace/RSI/examples/coral.json --repo /repos/coral-rsi
```

Adapter 需要实现：

```text
真实训练 → 保存 checkpoint → 新进程重载 → 官方 lm-eval → word_ppl
```

支持 scope：

```text
subset | full | ablation | rebuttal
```

Full/rebuttal 不允许缩短训练预算或评测样本。

### 2. 1-step adapter smoke

adapter 验收只做到 smoke，不做 subset/full 研究运行。

```text
/rsi smoke /workspace/RSI/examples/coral.json \
  --repo /repos/coral-rsi \
  --out /workspace/RSI/runs/adapter-smoke-<fresh-id> \
  --timeout 900 \
  --env RSI_CORAL_TRAIN_STEPS=1 \
  --env RSI_CORAL_TRAIN_BATCH_SIZE=1 \
  --env RSI_CORAL_EVAL_LIMIT=1 \
  --env RSI_CORAL_TIMEOUT=600 \
  --env RSI_CORAL_SEED=2026
```

这次会执行：

```text
1 个 optimizer step
→ checkpoint-1
→ 新进程重载
→ 一次 lm-eval
→ 1 个测试样本
```

`--out` 必须是尚未存在的新目录；把 `<fresh-id>` 换成自己的标识。

检查：

```text
/workspace/RSI/runs/adapter-smoke-<id>/artifacts/smoke-summary.json
/workspace/RSI/runs/adapter-smoke-<id>/artifacts/smoke-report.json
```

必须看到：

```text
status: ok
training_skipped: false
executed_train_steps: 1
checkpoint_step: 1
run_kind: smoke
```

这只是 adapter 可用性证据，不是 baseline，也不是科学结果。
adapter 验收到这里结束；不要在这个 skill 里继续跑 subset/full。

### 3. 清 baseline

adapter 代码变了，旧项目 baseline 失效：

```bash
rm -rf /workspace/RSI/.rsi-baseline/coral-wikitext-ppl-*
```

### 4. 运行完整 RSI

```text
/rsi run /workspace/RSI/examples/coral.json \
  --runner subprocess \
  --seed 7 \
  --out /workspace/RSI/runs
```

> 交互式 Pi 会话不需要 `--wait`：命令先返回 run id，完成后会通知。
> `pi -p`、脚本或无头自动执行必须加 `--wait`，否则进程退出后无法继续等待
> 后台 run。

说明：

- `/rsi run` 没有 `--repo`；容器已设置 `RSI_TARGET_REPO=/repos/coral-rsi`。
- provider/model 继承容器配置。
- 完整流程会做 subset 3 seeds × 95、full 954、data gate、ablation、paper。
- 不要在 full 运行中传 `RSI_CORAL_TRAIN_STEPS=1`；full 协议不能被缩短。
- 远端源码直接复用 `/home/sl/coral-rsi`，不再创建 `projects/<run>` 源码副本。
- 产物在 `/home/sl/coral-rsi/results/coral-<run_id>/`。

### 5. 可选：单轮 iteration

如果只授权一轮小预算优化，使用 smoke receipt：

```text
/rsi iterate /workspace/RSI/examples/coral.json \
  --adapter-acceptance /workspace/RSI/runs/adapter-smoke-<id>/artifacts/smoke-summary.json \
  --repo /repos/coral-rsi \
  --out /workspace/RSI/runs/iteration-coral-1 \
  --seed 2026 \
  --env RSI_CORAL_TRAIN_STEPS=2 \
  --env RSI_CORAL_TRAIN_BATCH_SIZE=1 \
  --env RSI_CORAL_EVAL_LIMIT=1 \
  --env RSI_CORAL_TIMEOUT=600 \
  --env RSI_CORAL_SEED=2026
```

单轮 iteration 不会启动 full、ablation 或 paper。

### 6. 查看状态

```text
/rsi status
/rsi status <run_id>
/rsi inspect <run_id>
/rsi replay <run_id>
/rsi stop <run_id> <ticket_id>
/rsi resume <run_id>
```

`stop` 是最终的；失败的 open ticket 可以 resume。

## 常见失败

### `limits` 阶段反复 `multiple-claims` / `identifier-rewritten`

RSI 在 lint 前会规范化限制文本：

```text
分号分隔的 measured evidence → 拆成独立句子
word ppl / word-ppl 等变体 → 恢复成 canonical word_ppl
```

因此 adapter 诊断 findings 里的分号不会再把限制提取拖进“拆句还是保留指标名”的死循环。

`limits` 的充分性门槛是：

```text
至少 minLimitations 条限制
且至少覆盖 3 个不同 axis
```

少量 axis 缺失不会阻塞；一轮没有新增限制时停止，不再固定跑满 16 轮。

如果仍然失败，run 会：

```text
aborted=true
abort_reason=style_violation
```

并仍然写出 `final.json`，保留 baseline 和 diagnosis，之后可以：

```text
/rsi resume <run_id>
```

写作输出不稳定时，可以在完整 run 加：

```text
--thinking high
```

这只影响模型思考强度，不改变实验预算。

### `diagnose.failed`

远端 `diagnose_command` 的 `{repo}` 现在使用远端同步后的 worktree，不是本地 checkout。失败时本地会写：

```text
runs/<run_id>/artifacts/experiments/diagnosis-<id>.log
```

包含远端 stdout/stderr。baseline 已复用时，resume 不会重新训练 baseline。

### 没有 `final.json`

只有未处理的异常才会缺少 `final.json`。style violation 现在会被 orchestrator 捕获，标记为 aborted 并导出 final；baseline/diagnosis 保留，可 resume。

## 远端和 baseline

- 远端源码目录：`/home/sl/coral-rsi`（复用，不复制到 `projects/`）。
- 远端输出目录：`/home/sl/coral-rsi/results/coral-<run_id>`。
- `results/` 不参与源码 rsync，不能被 `--delete` 删除。
- 项目 baseline：`/workspace/RSI/.rsi-baseline/<project-key>/`。
- 初始 baseline 测量后立即持久化；full baseline 在第一个 full 候选时 lazy 测量。
- adapter 重建后必须清旧 baseline。
- 1-step smoke 的 checkpoint 约 1.27 GB；验收后可以删除 checkpoint，保留报告和日志。不要删除整个 `results/`。

## 相关文档

- [`docs/SPEC.md`](docs/SPEC.md)：研究流程、数据门槛和超参数。
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：代码结构和状态机。
- [`docs/PROBLEM.md`](docs/PROBLEM.md)：Problem 与 adapter 契约。
- [`docs/REMOTE.md`](docs/REMOTE.md)：远端 rsync/SSH/GPU 执行。
- [`docs/SUPERAGENT.md`](docs/SUPERAGENT.md)：run/task ticket 和 policy。
- [`AGENTS.md`](AGENTS.md)：main agent 与受限执行者的边界。
