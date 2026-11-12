# 远程 GPU 服务器执行（rsync + SSH）

RSI 是 Pi 原生扩展；代码版本管理始终在**本地独立目标 git 仓库**完成。
训练、数据加载、checkpoint、lm-eval、bench adapter、项目 helper 和测试都由
目标仓库拥有，RSI 不携带项目专属 integrations。GPU 服务器只接收候选
worktree 快照并执行 benchmark；不需要联网或访问 git remote。

```text
本地目标仓库 (git)
  └── rsi/<run>/<label>-N  候选 commit
        │
        │ GitWorkspace: 本地 worktree (唯一 checkout)
        ▼
  rsync -az --delete  ──────────────►  GPU 服务器 /data/rsi（复用目标根目录）
                                          │
                                          │ ssh: CUDA_VISIBLE_DEVICES=...
                                          │      <experiment_command>
                                          ▼
  ◄──────────── ssh cat out.json ────  /data/rsi/results/<run>/process-N.json
```

## 在 Problem 中配置

```json
"remote": {
  "host": "gpu-node",                  // 或留空，用 RSI_REMOTE_HOST
  "dir": "/data/rsi",                  // 默认基础目录
  "worktree": "/home/sl/projects/dfm-ssm-{run_id}",  // 可选：本地项目→服务器路径映射
  "out": "/home/sl/projects/dfm-ssm-{run_id}/out",   // 可选：远程输出目录
  "python": "/opt/conda/envs/dfm/bin/python",
  "setup": "source /opt/conda/etc/profile.d/conda.sh && conda activate dfm",
  "ssh_args": ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=30"],
  "rsync_args": [],
  "gpu_ids": "0",                      // → CUDA_VISIBLE_DEVICES
  "env": {
    "HF_HOME": "/data/hf",
    "HF_HUB_OFFLINE": "1",
    "TRANSFORMERS_OFFLINE": "1",
    "RSI_DFM_TRAIN_DATA": "/data/dfm/train.jsonl",
    "RSI_DFM_BASE_MODEL": "/data/models/mamba-130m",
    "RSI_DFM_TOKENIZER": "/data/models/gpt-neox-tokenizer"
  },
  "timeout_s": 14400,
  "excludes": ["checkpoints", "pretrained", "data"]
}
```

| 字段 | 作用 |
|---|---|
| `host` | SSH 目标；留空时读容器环境 `RSI_REMOTE_HOST` |
| `dir` | 远程目标根目录；默认直接复用该目录，不再每次 run 复制一份项目 |
| `worktree` | 可选：远程项目路径模板；支持 `{run_id}`、`{repo}`。默认 `<dir>`（复用目标根目录）；需要 run 级隔离时才配置成含 `{run_id}` 的路径 |
| `out` | 可选：远程输出目录模板；默认 `<dir>/results/{run_id}`，每个 run 独立保留 |
| `python` | 远程 Python；`experiment_command` 中用 `{python}` |
| `setup` | `cd` 之后、命令之前执行的 shell 初始化（conda/module/venv） |
| `ssh_args` | 额外 SSH 参数（端口、跳板机、BatchMode） |
| `rsync_args` | 额外 rsync 参数（如 `--bwlimit`） |
| `gpu_ids` | `"0"`、`"0,1"`、`"2"` → `CUDA_VISIBLE_DEVICES` |
| `env` | 远程环境变量；离线缓存、数据、模型路径 |
| `timeout_s` | 远程命令超时；同时作为本地 SSH 超时 |
| `excludes` | 额外 rsync 排除项 |

终止语义：远程实验在独立 session 中运行并写 PID 文件。本地 abort/timeout 会先
关闭原 SSH，再用一次**不带已中止 signal** 的独立 SSH 读取 PID，并按 `TERM` →
`KILL` 终止整个进程组；不会把 `setsid` 子进程留在 GPU 服务器。`rsi_job_cancel`
仍先写 `cancel` 文件；worker 心跳失效时会直接杀 detached 进程组。若本地进程
被 `SIGKILL` 或机器断电，任何客户端都无法再发信号，需要人工确认远程进程。

默认还会排除：`.git`、`runs`、`results`、`patches`、`__pycache__`、`.pytest_cache`、
`node_modules`、`.venv*`、`*.pyc`。`results` 必须排除，否则复用目标根目录时
`rsync --delete` 会删掉已有 checkpoints 和评测证据。

## 外部项目与路径映射

目标项目可以完全不在本仓库内。推荐在 `container/.env`（gitignored）配置：

```dotenv
RSI_EXTERNAL_ROOT=/Users/liuxiaoyan/workspace
RSI_TARGET_REPO=/repos/mamba
```

compose 把宿主机 `RSI_EXTERNAL_ROOT` 挂载到容器 `/repos`。fixture：

```jsonc
"repo": "/repos/mamba",
"remote": {
  "worktree": "/home/sl/projects/dfm-ssm-{run_id}",
  "out": "/home/sl/projects/dfm-ssm-{run_id}/out"
}
```

本地 git 仓库（宿主 `/Users/.../dfm-ssm`）仍是候选 commit/分支的唯一来源；
服务器只收到当前候选 worktree 的 rsync 快照；默认快照直接覆盖目标根目录，
不再创建 `projects/<run>` 副本。

## 指定服务器 Python 环境

```jsonc
// 方式 A：绝对路径
"python": "/opt/conda/envs/dfm/bin/python"

// 方式 B：先激活环境，再用 {python}
"python": "python",
"setup": "source /opt/conda/etc/profile.d/conda.sh && conda activate dfm"
```

`setup` 在 `cd <remote worktree>` 之后执行；适合 conda activate、module load、
`LD_LIBRARY_PATH` 等。

## 容器内设置 SSH 目标

如果不想把内网主机名写进公开 fixture，用环境变量：

```bash
export RSI_REMOTE_HOST=user@gpu-node
./container/up.sh creds
./container/up.sh down && ./container/up.sh run
```

`creds` 会把 `RSI_REMOTE_HOST` 写进 `container/.env`，compose 再传入容器。
fixture 里保持 `"host": ""` 即可。

## GPU 选择

`gpu_ids` 直接写入远程 `CUDA_VISIBLE_DEVICES`：

```json
"gpu_ids": "0"      // 只用物理 GPU 0
"gpu_ids": "0,1"    // benchmark 内可用两张卡（DDP 由 benchmark 自己实现）
"gpu_ids": "2"      // 只用物理 GPU 2
```

RSI 不负责启动 DDP；`experiment_command` 里的脚本可以根据
`CUDA_VISIBLE_DEVICES`/`torch.cuda.device_count()` 自行决定。

## 服务器离线

服务器无法联网时，所有依赖必须预装/预缓存：

- Python 环境：`torch`、`transformers`、`lm-eval`、目标仓库依赖；
- 模型与 tokenizer 本地路径（如 `/data/models/mamba-130m`）；
- 训练数据本地路径（`RSI_DFM_TRAIN_DATA`）；
- Hugging Face 离线变量（`HF_HUB_OFFLINE=1`、`TRANSFORMERS_OFFLINE=1`）。

RSI 只做 `rsync` + `ssh`，不会在服务器上 `pip install` 或 `git clone`。

## 本地 git 版本管理

- 每个候选仍是本地目标仓库里的 `rsi/<run_id>-<hash>/<label>-N` 分支 + commit。
- 默认远程目录是目标根目录的源码快照；根目录的 `.git` 和 `results/` 被保留，
  不参与 `rsync --delete`。
- 远程执行失败/超时不会伪造 commit；`state.json` / `final.json` 的
  `code.commit` 仍是本地 git 的候选身份。
- 远程日志在 `runs/<run_id>/artifacts/experiments/remote-*.json`，包含 host、
  remote worktree、remote out、GPU、展开后的命令、stdout/stderr。

## Adapter 交付前的真实数据冒烟门禁

在 Pi 中直接生成/补全目标链路：

```text
/skill:rsi-adapter examples/<project>.json --repo /path/to/independent/target
```

skill 直接检查目标代码；不完整的数据、训练、checkpoint 保存/重载及 lm-eval
实现必须在目标仓库补齐。将 adapter、评测 helper、测试和说明提交在独立候选
分支/ref 上，并让待验收 Problem 的 `repo_ref` 指向该候选；此时还不能宣布可用。
不能以本地测试、`--help`、mock 或 rsync dry-run 代替真实远程验收。

在 Pi 内调用原生扩展命令（可重复 `--env KEY=VALUE`）：

```text
/rsi smoke examples/<project>.json --repo /path/to/independent/target --timeout 900 --env RSI_PROJECT_TRAIN_STEPS=1 --env RSI_PROJECT_TRAIN_BATCH_SIZE=1
```

等价工具调用：

```text
rsi_adapter_smoke { problem: "examples/<project>.json", repo: "/path/to/independent/target", timeout_s: 900, out: "runs/fresh-adapter-evidence", env: { RSI_PROJECT_TRAIN_STEPS: "1", RSI_PROJECT_TRAIN_BATCH_SIZE: "1" } }
```

这是 Pi 原生扩展入口，无需 LLM；复用 GitWorkspace 和真实 RemoteRunner，完成
新 worktree → 实际 rsync → SSH subset 实验 → 拉回原始 JSON → 指标键/数值/边界验证。
`remote.worktree` 默认复用 `<dir>`；如果显式配置成 run 级目录，必须自行承担
并发/清理责任。`remote.out` 默认 `<dir>/results/{run_id}`；无论是否配置，
`results` 都不参与源码同步。默认新建 `runs/adapter-smoke-*`；显式
`--out` / 工具 `out` 证据目录必须尚不存在。`--env` / 工具 `env` 对象只覆盖
本次冒烟，不改正式 fixture，也不应含凭据；**不会自动缩短预算**，请明确设置
目标实际支持的训练步数、batch、评测样本/长度等限制。

验收必须覆盖真实训练一步、checkpoint 保存/重载和真实评测；仅加载已有
checkpoint 不代表训练链路通过。记录原始数据来源、训练和评测日志路径，远程
缺失资产也必须返回非零及 failed 报告。证据位于 `artifacts/smoke-summary.json`、
`artifacts/smoke-report.json` 和 `artifacts/experiments/remote-0001.json`。

未通过时状态为 `blocked / remote not verified`，附失败命令和错误；通过才是
`remote-smoke-passed`，并记录实测 commit/ref 后，才交付可用的 `repo_ref`。
小预算结果仅证明链路，不可作为正式 baseline 或论文指标。

### 常见目标 preflight 修复（均在目标仓库完成）

- 确认真实数据的文件/目录格式、shard、列名、非空样本与切分；训练集不可混入
  评测集。离线数据加载必须命中真实本地资产，而不是退回合成数据。
- 检查本地模型/config/tokenizer 路径、词表与 special token 一致性，以及依赖、
  CUDA backend 和实际训练 CLI 是否兼容；不要靠模型目录存在就判定可加载。
- 让导入优先使用同步后的候选源码，避免旧服务器 checkout 或已安装包遮蔽修改；
  修复缺失模块、参数与训练目标时，只改目标代码。
- 验证真实更新过参数的 checkpoint 连同必要配置可保存，评测在新进程中从该
  产物重建/重载模型；只评测基座或已有 checkpoint 不算通过。
- 在目标 lm-eval helper 中对齐 task、离线缓存、tokenization、logits/likelihood
  接口与指标键；缺数据、重载失败或非有限指标必须失败，不能填常数或 proxy。
- 为训练与评测分别明确微型预算、超时、输出目录和 GPU 空闲容量；记录数据
  来源、展开命令、训练日志、checkpoint 和原始评测结果路径。项目回归测试也
  保留在目标仓库，不把 evaluator 或修复代码复制进 RSI。

## 示例 fixture 与正式研究

`examples/dfm_ssm_external.json` 等仍是示例配置；其中的 bench 命令必须存在于
各自目标 ref。以 word-ppl 为例，目标自有 adapter 执行真实训练 → 保存/重载
checkpoint → lm-eval wikitext `word_perplexity` → `{"metrics":{"word_ppl":...}}`。
`word_ppl` 越低越好，训练预算和评测协议由目标文档与 Problem 固定。

完成远程冒烟后，才启动完整 SOP：

```text
/rsi run examples/dfm_ssm_external.json --runner subprocess --thinking low
```

## 排错

| 现象 | 原因 / 修复 |
|---|---|
| `Permission denied (publickey)` | 本地到服务器的 SSH key 未配置；先 `ssh <host>` 验证 |
| `rsync: command not found` | 本地/服务器未安装 rsync |
| `remote.host is empty` | 填写 `remote.host` 或设置 `RSI_REMOTE_HOST` |
| `remote command exited with status ...` | 查看 `runs/<run_id>/artifacts/experiments/remote-*.json` 的 stderr |
| CUDA OOM | 调整 `gpu_ids`、benchmark batch size、训练/评测 `max_length` |
| 服务器找不到模型/数据 | 检查 `remote.env` 中的离线路径和 `HF_*_OFFLINE` |
| 超时 | 增大 `remote.timeout_s`；训练/评测自身也要有超时保护 |

## 安全

`remote.env` 会出现在远程命令行和本地日志里。不要把 token 放进 `env`；
SSH 使用 key/agent，benchmark 需要的凭据放在服务器的环境或文件中。
