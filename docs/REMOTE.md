# 远程 GPU 服务器执行（rsync + SSH）

RSI 的代码版本管理始终在**本地 git 仓库**完成；GPU 服务器只接收一个候选
worktree 的快照，然后执行 benchmark。服务器不需要联网，也不需要访问 git remote。

```text
本地目标仓库 (git)
  └── rsi/<run>/<label>-N  候选 commit
        │
        │ GitWorkspace: 本地 worktree (唯一 checkout)
        ▼
  rsync -az --delete  ──────────────►  GPU 服务器 /data/rsi/rsi/<run>/worktree
                                          │
                                          │ ssh: CUDA_VISIBLE_DEVICES=...
                                          │      <experiment_command>
                                          ▼
  ◄──────────── ssh cat out.json ────  /data/rsi/rsi/<run>/out/process-N.json
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
| `dir` | 默认远程基础目录；每次 run 使用 `<dir>/rsi/<run_id>/` |
| `worktree` | 远程项目路径模板；支持 `{run_id}`、`{repo}`。默认 `<dir>/rsi/<run_id>/worktree` |
| `out` | 远程输出目录模板；默认远程 worktree 的兄弟目录 `out/` |
| `python` | 远程 Python；`experiment_command` 中用 `{python}` |
| `setup` | `cd` 之后、命令之前执行的 shell 初始化（conda/module/venv） |
| `ssh_args` | 额外 SSH 参数（端口、跳板机、BatchMode） |
| `rsync_args` | 额外 rsync 参数（如 `--bwlimit`） |
| `gpu_ids` | `"0"`、`"0,1"`、`"2"` → `CUDA_VISIBLE_DEVICES` |
| `env` | 远程环境变量；离线缓存、数据、模型路径 |
| `timeout_s` | 远程命令超时；同时作为本地 SSH 超时 |
| `excludes` | 额外 rsync 排除项 |

默认还会排除：`.git`、`runs`、`patches`、`__pycache__`、`.pytest_cache`、
`node_modules`、`.venv*`、`*.pyc`。

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
服务器只收到当前候选 worktree 的 rsync 快照。

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
- 远程目录只是该 commit 的 worktree 快照，没有 `.git`。
- 远程执行失败/超时不会伪造 commit；`state.json` / `final.json` 的
  `code.commit` 仍是本地 git 的候选身份。
- 远程日志在 `runs/<run_id>/artifacts/experiments/remote-*.json`，包含 host、
  remote worktree、remote out、GPU、展开后的命令、stdout/stderr。

## dfm-ssm word-ppl 流程

1. 在目标仓库的 `rsi-bench` 分支放置 benchmark：
   - `bench/rsi_dfm_train_eval.py`
   - `bench/dfm_lm_eval.py`

   由 `./integrations/dfm_ssm/setup.sh` 自动完成。

2. 配置 `examples/dfm_ssm_external.json` 的 `remote.host`、`remote.python`、
   `gpu_ids`、`env` 中的本地模型/数据路径。

3. 运行：

```text
/rsi run examples/dfm_ssm_external.json --runner subprocess --thinking low
```

4. benchmark 行为：

```text
scripts/finetune_dfm.py  →  本地/远程 checkpoint
bench/dfm_lm_eval.py     →  lm-eval --tasks wikitext
                         →  word_perplexity  →  {"metrics": {"word_ppl": ...}}
```

`word_ppl` 越低越好，`metrics[0].direction = "min"`。每个候选会重新训练
（训练步数按 `scope` 默认：subset 20 / full 100 / ablation 50），然后重新
lm-eval。真实实验请按预算覆盖 `RSI_DFM_TRAIN_STEPS` 或 `--train-steps`。

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
