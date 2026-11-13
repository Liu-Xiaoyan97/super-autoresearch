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

## Superagent 上下游关系

任务名就是 superagent task ticket。`→` 表示必须等待的上游，`∥` 表示同一批
独立任务并行。`diagnose.run` 是目标仓库的真实测量命令；`critic.compare` 和
`critic.selector` 是确定性 gate，不产生模型 ticket。

```text
[problem / repo_ref]
          │
          ▼
[code.baseline]                 diagnose_command path
          │
          ▼
[diagnose.run]                  target measurement, not LLM
          │
          ▼
[limitations.extract]
          │
          ▼
[limitations.verify]
          │
          ▼
[ideas.initial]
          │
          ▼
[ideas.novelty ×N]              same batch: parallel
          │
          ▼
[ideas.expand]
          │
          ▼
[code.baseline]                 no diagnose_command path
          │
          ▼
[code.implement]
          │
          ▼
[code.subset]
          │
          ▼
[critic.subset]  ◄── engineer.subset loop
          │
          ▼
[code.full]
          │
          ▼
[critic.full]    ◄── engineer.full loop
          │
          ▼
[ideas.evolve]                  breadth rounds
          │
          ▼
[critic.selector]               deterministic
          │
          ▼
[critic.compare]                deterministic
          │
          ▼
[ablation.plan]
          │
          ▼
[code.ablation]                 one plan at a time
          │
          ▼
[ablation.critic]
          │
          ▼
[data gate / attribution]
          │
          ▼
[write.draft]
          │
          ▼
[review.peer ×3]                parallel panel
          │
          ▼
[review.rebuttal_plan]          if review fails
          │
          ▼
[code.rebuttal]                 one task at a time
          │
          ▼
[write.enhance]
          │
          ▼
[review.peer ×3]                repeat until pass/budget
          │
          ▼
[review.meta]                   accept → export; refine → engineer.full
          │
          ▼
[integrity.refs ∥ integrity.method_code]
          │
          ▼
[export]

integrity.spec: each good trace ──► evidence, during search
```

### 并行组

| 并行任务 | 上游 | 下游 |
|---|---|---|
| `review.peer` × 3 | `write.draft`、当前 manuscript | 聚合 review → `review.rebuttal_plan` |
| `ideas.novelty`（同批 seed/evolved） | `ideas.initial` / `ideas.expand` | seed pool / 下一轮 search |
| `integrity.refs` ∥ `integrity.method_code` | manuscript、best code、incumbent evidence | final integrity / acceptance |

### 串行链路与上下游

| 串行任务 | 上游 | 下游 |
|---|---|---|
| `code.baseline` | `Problem.repo_ref`、baseline 配置 | `diagnose.run` 或 search |
| `diagnose.run` | reproduced baseline | limitations、seeds |
| `limitations.extract` | diagnosis / baseline / constraints | `limitations.verify` |
| `limitations.verify` | extracted limitations | `ideas.initial` |
| `ideas.initial` | verified limitations | `ideas.novelty` |
| `ideas.expand` | limitations、已有 seed pool | `ideas.novelty`、search |
| `code.implement` | selected seed idea、baseline | `code.subset` |
| `code.subset` | implementation patch、subset budget | `critic.subset` |
| `critic.subset` | subset evidence vs subset baseline | `engineer.subset` 或 `code.full` |
| `engineer.subset` | subset critic feedback | `critic.subset` |
| `code.full` | subset-good candidate、full budget | `critic.full` |
| `critic.full` | full evidence vs full baseline | `engineer.full` 或 selector |
| `engineer.full` | full critic / meta-review feedback | `critic.full` 或 re-adopt |
| `ideas.evolve` | traces from a search round | next round candidates |
| `critic.selector` | all full-set good traces | `critic.compare` / ablations |
| `critic.compare` | candidate evidence、baseline/incumbent | adopt/reject |
| `ablation.plan` | selected incumbent | `code.ablation` |
| `code.ablation` | one ablation plan、subset control | `ablation.critic` |
| `ablation.critic` | all ablation evidence | data gate / paper |
| `write.draft` | incumbent evidence、ablations、data gate | `review.peer` |
| `review.rebuttal_plan` | aggregated peer review | `code.rebuttal` |
| `code.rebuttal` | one rebuttal task | `write.enhance` |
| `write.enhance` | review + rebuttal evidence | next `review.peer` |
| `review.meta` | final aggregate review | accept/export 或 `engineer.full` |
| `integrity.spec` | each good trace/evidence | final integrity |
| `integrity.refs` / `integrity.method_code` | manuscript、best code、evidence | acceptance/export |

### 每个 Superagent 的职责

| Task | 负责什么 |
|---|---|
| `code.baseline` | 用未修改的 `repo_ref` 复现实测 baseline；不会应用模型 patch |
| `diagnose.run` | 执行目标仓库声明的只读诊断命令，产出 measured findings（不是 LLM） |
| `limitations.extract` | 从诊断、问题和约束中提取可执行 limitation |
| `limitations.verify` | 判断 limitation 数量和 axis 是否足够，决定是否进入 seed |
| `ideas.initial` | 生成第一个 seed idea |
| `ideas.novelty` | 评估 idea 的新颖性、机制相关性和引用质量 |
| `ideas.expand` | 从 limitations 和已有 seeds 扩展 seed pool |
| `ideas.evolve` | 根据 traces 进化下一轮候选 idea |
| `code.implement` | 生成实现 instruction，驱动 candidate 的 subset 实现 |
| `code.subset` | 生成 candidate diff 并在真实 subset 预算/多 seed 上测量 |
| `critic.subset` | 判断 subset 是否严格优于 baseline；invalid 进入修复，worse 进入工程循环 |
| `engineer.subset` | 根据 subset critic 反馈修改 candidate，再测量 subset |
| `code.full` | 把 subset 验证过的方案扩展到 full 954 协议 |
| `critic.full` | 判断 full 是否严格优于 full baseline，决定 engineer/adopt |
| `engineer.full` | 根据 full critic 或 meta critique 修改完整方案 |
| `critic.compare` | 确定性 adoption gate：所有指标不回退且至少一个改进（无 LLM） |
| `critic.selector` | 从 full-set good traces 中按多指标加权 delta 选出 incumbent（无 LLM） |
| `ablation.plan` | 规划可执行的 component ablation，不允许超参数 sweep |
| `code.ablation` | 为每个 ablation plan 生成 patch，并在 subset control 上测量 |
| `ablation.critic` | 判断每个组件是否有真实贡献，决定 keep/refine |
| `write.draft` | 根据 incumbent、baseline、ablations 和 evidence 写论文初稿 |
| `review.peer` | 独立 reviewer 评估新颖性、实验有效性、可复现性和归因；3 个并行 |
| `review.rebuttal_plan` | 将 reviewer 问题转成可执行的 supplementary experiments |
| `code.rebuttal` | 实现并运行每个 rebuttal experiment |
| `write.enhance` | 根据 review 和 rebuttal evidence 改进 manuscript |
| `review.meta` | meta-review 决定 accept 或 refine，并给出具体 critique |
| `integrity.spec` | 检查 trace/evidence 是否违反 Problem 的 forbidden/spec 约束 |
| `integrity.refs` | 审计引用、claim 和 reference 是否可验证 |
| `integrity.method_code` | 审计 manuscript 方法描述与 candidate code diff 是否对齐 |

> 并行只针对独立 superagent 调用。`code.subset`、`code.full`、`code.ablation`、
> `code.rebuttal` 和 seed screen 仍串行，因为它们共享 remote GPU、worktree、
> commit 和 checkpoint 资源。

## 实验台账与族谱

每次 run 的 `state.json` / `final.json` 更新后，RSI 自动重建项目根目录下的：

```text
ledger/
  ledger.json          # 机器可读台账
  experiments.jsonl    # 逐实验记录
  ledger.md            # 人类可读表格
  tree.txt             # 缩进树
  graph.md             # Mermaid
  graph.dot            # Graphviz DOT
  lineage.json         # 族谱布局数据
  lineage.png          # 树状族谱（PNG）
  lineage.svg          # 树状族谱（SVG）
```

图谱结构：

```text
project
  └─ model family
       ├─ baseline subset / full
       └─ candidate
            └─ engineer
                 └─ full (dashed edge from subset candidate)
                      └─ ablation / rebuttal
```

- `candidate` 是 initial subset implementation；
- `engineer` 是 candidate 的下一代，记录 repair/core idea；
- candidate/engineer 都会记录核心思路（来自 provenance patch 的 Mechanism/Hypothesis/Critique）；
- initial full-set 节点用**虚线**连接最后一个 subset candidate/engineer 节点；
- `provenance-*.json` 里的实验也会进入台账，因此即使 run 因失败没有写入 `state.traces`，candidate/engineer 仍会保留。

- **同族判定**：比较目标仓库中模型定义文件的 git blob，不比较 commit 或阶段配置。
  `RSI_CORAL_MODEL_FILE` 指向的文件不变时，E/H、LR、batch、steps、优化器等超参数变化都属于同族；
  模型定义文件内容变化才创建新 family。
- 每个 run 的实验单独保留；不会把不同 run 中相同 commit/metric 的记录合并掉。
- 尚未完成测量的 seed 以 `pending` 节点进入族谱。
- `ledger` 每次状态写入后自动刷新，不需要手工导出。
- 默认写到 `<项目根>/ledger/`；可用 `RSI_LEDGER_DIR` 覆盖。
- PNG/SVG 需要 `python3` + matplotlib；容器镜像已包含 `python3-matplotlib`。缺少渲染器时
  JSON/Markdown/DOT 仍然生成。
- `ledger/` 是生成数据，已在 `.gitignore` 中忽略；不会删除 baseline 台账或 baseline 指针。

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
