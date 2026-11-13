# RSI — ScientistTwo on Pi

RSI 是 ScientistTwo 的 Pi 扩展实现：一个前台 agent 接单，后台按
`limitations → seeds → subset → full → paper` 推进研究。所有研究命令都在容器内的
Pi 会话中执行；目标项目的训练、checkpoint、评测和指标代码属于目标仓库。

## 项目简介

- **代码循环**：实测 baseline → subset 筛选 → full 954 → data gate → ablation。
- **论文循环**：draft → 3 位独立 reviewer → rebuttal → meta-review。
- **测量原则**：候选只有严格优于实测 baseline 才会被采纳；比较基线使用实测
  baseline，`reported_metrics` 是报告值。
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

# 项目全局 baseline；放在 runs/ 外，run 清理不会删除它
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
```

### 3. 启动路径

在宿主机验证容器：

```bash
./container/up.sh exec bash -lc '
  ls -la /repos/coral-rsi &&
  git -C /repos/coral-rsi status --short --branch &&
  ssh 8818 true
'
```

固定从 `/workspace/RSI` 启动 Pi：

```bash
docker exec -it \
  -e RSI_SUPERAGENT_POLICY=yolo \
  -w /workspace/RSI \
  pi-agent-rsi pi -c
```

进入后：

```text
/rsi help
```

### Pi session 存在项目里

容器里的 `container/pi-home/settings.json` 已设置：

```json
"sessionDir": ".rsi/pi-sessions"
```

这是相对路径，按当前工作目录解析；容器内就是：

```text
/workspace/RSI/.rsi/pi-sessions
```

它同时映射回宿主机仓库根目录下的：

```text
<repo>/.rsi/pi-sessions
```

容器重建、换 `docker exec` 都继续同一批 session。

启动命令固定为上面的 `/workspace/RSI` + `pi -c` 路径。旧容器 session 已迁移到
`.rsi/pi-sessions/`；这些文件已在 `.gitignore` 中忽略。

## 使用：coral-rsi

目标仓库在容器内是 `/repos/coral-rsi`，远端是 `8818:/home/sl/coral-rsi`。

### 1. 重建 adapter

Adapter 的修改范围是 `/repos/coral-rsi`；`/workspace/RSI` 承载 RSI 本身。

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
真实训练 → 保存 checkpoint → 新进程重载 → 官方 lm-eval → word_ppl + lambada_openai acc
```

支持 scope：

```text
subset | full | ablation | rebuttal
```

Full/rebuttal 使用完整训练预算和评测样本。

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
→ 官方 lm-eval 同时运行 wikitext 与 lambada_openai
→ 每个 task 1 个测试样本
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
metrics: word_ppl + acc
```

这只是 adapter 可用性证据，不是 baseline，也不是科学结果。
adapter skill 的验收边界是 smoke；subset/full 由独立的 `/rsi run` 执行。

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

> 交互式 Pi 会话先返回 run id，完成后通知。`pi -p`、脚本或无头自动执行附加
> `--wait`。

说明：

- `/rsi run` 没有 `--repo`；容器已设置 `RSI_TARGET_REPO=/repos/coral-rsi`。
- provider/model 继承容器配置。
- 完整流程会做 subset 3 seeds × 95、full 954、data gate、ablation、paper；每个阶段都评测 `word_ppl` 和 lambada_openai `acc`。
- full 运行使用 954 步协议；`RSI_CORAL_TRAIN_STEPS` 只用于 smoke/iteration。
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

`stop` 是最终的；failed、aborted、dropped 或进程中断留下的 open run 可以 resume：

```text
/rsi resume <run_id>
```

`/reload`、切换 session、退出 Pi 或人工中断 live run 时，RSI 会：

- 写出 `state.json` 和 `final.json`，标记 `aborted=true`、`abort_reason`；
- 结束 superagent 的 run ticket 和所有 open task ticket；
- 关闭 worker 和运行中的任务；
- 清除 TUI widget。

之后用 `/rsi resume <run_id>` 从状态创建新的 attempt。Pi 进程重启时，
`session_start` 会把上一个进程留下的 open run 恢复成 aborted 状态并写出 state/final，
同样可以 resume。

### TUI 运行状态

运行中的 run 显示在编辑器下方的 widget（`belowEditor`），每个 run 两行：

```text
coral-wikitext-ppl-s7-r1-r1-r2-r1 · run-1olswx6
§3.5 drafting and peer review · §3.5 drafting and peer review · Super Agents: review.peer ×3
```

- 第一行：run id · 当前 run ticket；
- 第二行：当前阶段(完成数/任务数) · 最近一次**属于该阶段**的 progress · 正在运行的
  RSI Super Agent task；多个 task 会显示为 `review.peer ×3` 这样的计数；没有运行中的
  task 时省略该字段；
- 每秒刷新一次；
- 同一阶段内独立的 superagent 并行执行，存在上下游依赖的步骤保持串行；GPU
  实验仍按资源和 worktree 约束串行；
- 多个 run 各占两行，中间空一行；
- 需要人回答时显示 `NEEDS PERSON`；
- run 完成、失败或停止后自动清除，不残留旧状态；
- `/reload` 或切换 session 会中断 live run，widget 清除；resume 后重新显示；
- 底部 footer status 只保留其他扩展的信息。

baseline 进度会区分来源：

```text
§3.2 baseline ready (reused)                    # subset + full 都复用，不训练
§3.2 baseline ready (subset; full baseline lazy) # subset 复用，full 等候选进入 full 时再测
§3.2 measuring the baseline                     # 真正重新测量 baseline
```

`/rsi status` 里的 `progress:` 是最近一次阶段消息；真正的阶段状态以 stage rows 和
`decision_path` 为准。阶段切换现在会立即上报，不再被 1.5 秒节流吞掉；进入 idea
search 时也会显示 `§3.2 searching ideas`，不会停留在 baseline 文案。

## 常见失败

### `limits` 阶段反复 `multiple-claims` / `identifier-rewritten`

RSI 在 lint 前会规范化限制文本：

```text
分号分隔的 measured evidence → 拆成独立句子
word ppl / word-ppl 等变体 → 恢复成 canonical word_ppl
lambada_openai accuracy → 使用 canonical acc
```

因此 adapter 诊断 findings 里的分号不会再把限制提取拖进“拆句还是保留指标名”的死循环。

`limits` 的充分性门槛是：

```text
至少 minLimitations 条限制
且至少覆盖 3 个不同 axis
```

少量 axis 缺失不会阻塞；一轮没有新增限制时停止，不再固定跑满 16 轮。每轮最多补
`minLimitations - existing` 条，模型一次返回几十条也不会全部进入限制集。进入 seed
阶段前还会把历史限制裁剪到最多 8 条（保留 severity 最高的）；resume 时不会把 59
条旧限制继续灌进每个 idea/novelty prompt。

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

### `no_eligible_seeds`

两种搜索策略都用 `nSeed` 生成 seed pool；`depth` 只限制“一个 measured defect”，
不限制“一个 idea”。如果所有 seed 的 novelty 都低于 `minNovelty`，RSI 会记录：

```text
seeds.weak:<count>
```

并保留 domain/guidance 合格的最高排名 seed，继续进入 subset/full 实测，而不是
因为没有一条 novelty >= 0.35 就直接结束。只有完全没有可用 hypothesis 时才
`no_eligible_seeds`。

Novelty 检查的引用必须针对 idea 的机制；CCNet、数据去重之类的通用数据论文
不属于 kernel decay 的有效依据。引用不相关会降低评分，但不会单独把整条 run
归零。

### `code.*` worker reports no file-reading tool

`code.*`、`engineer.*`、`ablation.*`、`rebuttal.*` 的 Pi worker 现在获得只读工具：

```text
read, grep, find, ls
```

worker 的 cwd 指向目标仓库。它只获得 `read/grep/find/ls`；候选改动通过
unified diff → git commit 的受控 patch 流程。

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
- `results/` 不参与源码 rsync；`--delete` 仅作用于源码目录，`results/` 保留。
- 项目 baseline：`/workspace/RSI/.rsi-baseline/<project-key>/`。
- 初始 baseline 测量后立即持久化；full baseline 在第一个 full 候选时 lazy 测量。
- adapter 重建后必须清旧 baseline。
- 1-step smoke 的 checkpoint 约 1.27 GB；验收后清理 checkpoint 文件，保留报告、日志和 `results/`。

## 相关文档

- [`docs/SPEC.md`](docs/SPEC.md)：研究流程、数据门槛和超参数。
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：代码结构和状态机。
- [`docs/PROBLEM.md`](docs/PROBLEM.md)：Problem 与 adapter 契约。
- [`docs/REMOTE.md`](docs/REMOTE.md)：远端 rsync/SSH/GPU 执行。
- [`docs/SUPERAGENT.md`](docs/SUPERAGENT.md)：run/task ticket 和 policy。
- [`AGENTS.md`](AGENTS.md)：main agent 与受限执行者的边界。
