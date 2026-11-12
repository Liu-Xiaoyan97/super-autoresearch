# AGENTS.md — RSI agent boundaries

## 0. 定义

**当前项目（RSI）** 指当前 git 仓库的根目录：

```bash
RSI_ROOT="$(git rev-parse --show-toplevel)"
```

不要在代码、文档、prompt、测试或配置中把 RSI 绑定到某个固定的绝对路径。

角色分为两类：

| 角色 | 能否修改 RSI |
|---|---|
| **main agent**（人直接对话的顶层 coding agent） | **可以**，但只应完成人的明确请求 |
| skill、MCP、extension runtime、subagent、superagent / SOP worker | **不可以** |

“main agent”是当前会话的顶层执行者。skill、MCP server、Pi extension 的运行时、
subagent、RSI superagent 及其 SOP worker 都属于受限执行者。

## 1. 铁律

```text
main agent 可以修改当前项目。
skill / MCP / extension runtime / subagent / superagent 不得修改当前项目。
任何执行者都不得把当前项目绑定到固定的绝对路径。
```

### 1.1 main agent

main agent 可以直接修改 RSI：

- 源码、测试、配置、prompt、schema、extension、skill、container、docs；
- 但必须基于人的明确请求，并在当前仓库根目录内操作；
- 修改后应运行相关类型检查和测试。

main agent **不得通过** skill、MCP、subagent、superagent 或 extension runtime
代为修改 RSI。需要改 RSI 时，由 main agent 自己完成；受限执行者只能做只读检查。

### 1.2 受限执行者

以下执行者只能读取 RSI、执行只读命令，不能写入当前项目：

- skill（包括 `rsi-adapter`、`rsi-research` 等）；
- MCP server / MCP tool；
- Pi extension 的运行时；
- subagent / 后台会话；
- RSI superagent、run driver、SOP task worker；
- coding / ablation / rebuttal / paper / review agent。

它们不得创建、修改、删除、重命名或格式化 RSI 中的：

```text
src/
extensions/
prompts/
skills/
tests/
container/
examples/
docs/
package.json
tsconfig.json
AGENTS.md
```

也不得执行会改变 RSI 代码的 git 操作，例如 `git apply`、`git commit`、
`git checkout -- .`、`git reset`。

## 2. 受限执行者可以写哪里

受限执行者只能写以下位置：

### 2.1 目标项目

```text
Problem.repo
```

所有候选实现必须是目标仓库中的 branch + commit，通过受控 patch 流程产生。
目标项目的 adapter、训练/评测代码、测试和文档属于目标仓库。

`Problem.repo` 解析后不能等于 RSI 仓库根目录；如果相等，必须 fail closed。

### 2.2 运行产物

```text
runs/<run_id>/state.json
runs/<run_id>/traces.jsonl
runs/<run_id>/final.json
runs/<run_id>/artifacts/
runs/<run_id>/patches/
runs/<run_id>/worktree/
```

这些是运行数据，不是 RSI 源码。

### 2.3 项目全局 baseline

```text
.rsi-baseline/
```

该目录位于 RSI 仓库根目录，是 baseline 数据，不是源码；不要放进 `runs/`，避免被 run 清理误删。

baseline 只能通过 RSI 提供的流程写入；不得手工伪造或绕过协议校验。

### 2.4 远端实验输出

```text
Problem.remote.dir
```

由 runner 同步和清理；不得在远端修改 RSI 源码。

## 3. 绝对路径规则

RSI 当前项目**不得与固定绝对路径绑定**。

- 不把 `/Users/...`、`/home/...`、`/workspace/...` 等 RSI 根路径写进代码、
  配置、prompt、测试或文档作为项目身份。
- 需要项目根目录时，使用：

```bash
RSI_ROOT="$(git rev-parse --show-toplevel)"
```

- 需要文件路径时，使用相对仓库根的路径，或从
  `import.meta.dirname` / `process.cwd()` / `RSI_ROOT` 推导。
- 目标仓库路径来自 `Problem.repo`，是外部项目路径；不要把 RSI 根目录写死在
  `Problem` 或 adapter 里。
- 容器内的 `/workspace/RSI`、`/repos/...` 只是运行时挂载路径，不是项目身份；
  代码不能依赖这些固定字符串来定位仓库。

## 4. RSI 运行时的边界

- `Problem.repo` 是唯一允许产生研究代码改动的仓库。
- 目标 worktree 是唯一可写的 checkout。
- RSI 源码、prompt、schema、测试、配置、extension、skill、container 对 run agent
  只读。
- main agent 修改 RSI 时，也不得把目标项目的 adapter、评测 helper、项目测试或
  数据复制进 RSI 源码树。

## 5. 冲突处理

优先级从高到低：

1. 本文件的角色边界和绝对路径规则；
2. 人类维护者的明确请求；
3. `Problem` / adapter 契约；
4. 当前任务的 prompt。

如果受限执行者收到“修改 RSI”的指令，必须：

```text
报告 blocked；
说明需要改哪个当前项目文件；
建议由 main agent 直接处理；
不得自行修改，也不得通过其他受限执行者绕过。
```

如果 main agent 发现需要修改 RSI，应直接编辑当前项目，而不是交给 subagent、
skill、MCP 或 superagent。

## 6. AGENTS.md 自身

`AGENTS.md` 属于当前项目文件。只有 main agent 可以在人的明确请求下更新它；
skill、MCP、extension runtime、subagent、superagent 均不得修改它。
