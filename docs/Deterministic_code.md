# Deterministic code checks

本文定义 RSI 的 **确定性代码检查层（Deterministic code layer）**：候选 patch 在进入
subset/full GPU 实验之前，必须通过哪些可执行检查，以及新增目标语言时如何接入。

当前实现已经包含 `writePatch` provenance guard、语言检测、`CheckRunner`、
`GitWorkspace.check`、coder 集成、只读 LSP 客户端、模型-facing LSP 工具和
secret-free check worker。
目标 adapter 可以声明 required/advisory checks；required check 不可用或失败会阻断实验。
容器镜像已经内置 Python/Rust/Go 的检查工具和语言服务器；`pi-agent:local`
已在本地重建并用一次性容器验证过工具存在。

当前目标语言只有：

- **Python**：AI / ML、训练、评测、数据处理
- **Rust**：区块链执行层、密码学、性能组件
- **Go**：区块链节点、P2P、RPC、索引器

当前不接入：

- TypeScript / JavaScript
- C / C++
- Java / Kotlin
- C# / .NET
- 其他语言

语言层必须保持可扩展；新增语言只增加 adapter/provider，不修改 RSI core 的
orchestrator、scientific critics 或 experiment runner。

---

## 1. 目标与非目标

### 目标

```text
writePatch
  ↓
provenance / apply / no-op / parent-commit guard
  ↓
language detection
  ↓
target-declared checks
  ↓
compile / typecheck / lint / tests / smoke
  ↓
LSP diagnostics
  ↓
only then: subset/full/ablation/rebuttal GPU experiment
```

要求：

- required check 失败时，不启动 GPU 实验；
- 不消耗 experiment budget；
- required check 失败是 implementation failure，不是 scientific refutation；
- check 结果可持久化、可恢复、可审计；
- core 不写死 Python；
- 支持 polyglot 目标仓库；
- LSP 只读，不能绕过 `writePatch` / git commit / provenance；
- check 不通过不能进入 `evaluated_ids`、refutation 或 candidate journal。

### 非目标

- 不做完整 IDE；
- 不让 LSP 直接编辑文件；
- 不把编译器通过当成科学结论；
- 不为不支持的语言安装工具链；
- 不在 GPU runner 上运行 LSP；
- 不把所有语言工具放进一个巨大镜像。

---

## 2. 现有边界

当前相关代码：

| 位置 | 责任 |
|---|---|
| `Problem` / `experiment_command` | 目标实验命令，语言无关 |
| `GitWorkspace.writePatch` | patch apply、commit、no-op/provenance guard |
| `SubsetCoder` / `SubsetEngineer` | 生成、修复候选代码 |
| `FullSetCoder` / `FullSetEngineer` | full protocol |
| `AblationCoder` / `RebuttalCoder` | ablation/rebuttal |
| `Workspace.brief` | 目标源码上下文 |
| `READ_ONLY_TOOLS` | coding worker 的只读工具 |
| `modelRoutes` | agent 模型路由 |

本文新增的不是“另一种 model prompt”，而是 **实验前的确定性 gate**。

---

## 3. 总体架构

```text
.rsi/adapter.json
  ├─ protected_paths
  ├─ languages
  │    ├─ python: checks, lsp, test selection
  │    ├─ rust:   checks, lsp, test selection
  │    └─ go:     checks, lsp, test selection
  └─ toolchains

GitWorkspace.writePatch
  ↓
ImplementationGate
  ├─ changed files from git diff --name-only
  ├─ LanguageRegistry.detect()
  ├─ CheckRunner.run()
  ├─ LspManager.diagnostics()
  └─ CheckReport
  ↓
code.<scope> / engineer.<scope>
  ├─ pass → runSeeded / run
  └─ fail → failed evidence → invalid → repair
```

`ImplementationGate` 位于 **patch 之后、实验之前**。它不替代
`ScientificAbort`、`SubsetCritic.valid()` 或 `FullSetCritic`。

---

## 4. 数据契约

以下接口是目标设计；实现时应放在 `src/rsi/runtime/` 的独立模块中，避免把语言
逻辑塞进 orchestrator。

### 4.1 LanguageSpec

```ts
export interface LanguageSpec {
  id: string;
  extensions: string[];
  manifests?: string[];

  checks: CheckSpec[];

  lsp?: {
    command: string[];
    root?: string;
    env?: Record<string, string>;
    severity?: "required" | "advisory";
    referenceSeverity?: "required" | "advisory";
    initializationOptions?: Record<string, unknown>;
  };
}
```

`testSelection` 和按语言 `toolchain.image` 是未来扩展，不在当前 core 接口中。
当前 worker 使用同一镜像；目标需要不同工具时，把命令写进 adapter checks，或在
目标仓库自己的 CI/devcontainer 中执行。

### 4.2 CheckSpec

```ts
export type CheckSeverity = "required" | "advisory";

export interface CheckSpec {
  id: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutS: number;
  severity: CheckSeverity;

  /** 只有这些路径变化才运行；空表示由 language detection 决定。 */
  paths?: string[];
}
```

### 4.3 CheckReport

```ts
export interface CheckResult {
  id: string;
  command: string[];
  status: "ok" | "failed" | "timeout" | "unavailable";
  severity: CheckSeverity;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_s: number;
}

export interface CheckReport {
  commit: string;
  parent: string | null;
  languages: string[];
  changed_files: string[];
  status: "ok" | "failed" | "unavailable";
  checks: CheckResult[];
  report_path?: string;
}
```

### 4.4 Adapter 位置

推荐放在目标仓库：

```text
<Problem.repo>/.rsi/adapter.json
```

不得把目标路径写入 RSI 源码，也不得使用固定绝对路径。`Problem.repo` 是唯一
目标身份。

如果没有 adapter：

```text
内置 Python/Rust/Go provider 生效
```

多个清单不能按 `problem` 或 `source_fixture` 唯一匹配时：

```text
adapter = null
```

这不等于“所有检查通过”。目标专属 smoke/tests 缺失时必须由 adapter 显式声明；
不能静默认为通过，也不能自动猜测目标身份。

---

## 5. LanguagePlan

### 5.1 Python

```json
{
  "extensions": [".py"],
  "manifests": ["pyproject.toml", "requirements.txt", "setup.py"],
  "checks": [
    {
      "id": "compile",
      "command": ["python3", "-m", "compileall", "-q", "."],
      "timeoutS": 60,
      "severity": "required"
    },
    {
      "id": "typecheck",
      "command": ["pyright", "--outputjson"],
      "timeoutS": 120,
      "severity": "required"
    },
    {
      "id": "lint",
      "command": ["ruff", "check", "."],
      "timeoutS": 60,
      "severity": "advisory"
    },
    {
      "id": "tests",
      "command": ["pytest", "-q", "-x"],
      "timeoutS": 300,
      "severity": "required"
    }
  ],
  "lsp": {
    "command": ["pyright-langserver", "--stdio"],
    "root": "."
  }
}
```

Python AI 目标还应有 target-owned smoke：

```json
{
  "id": "smoke",
  "command": ["python3", "-c", "import target_package"],
  "timeoutS": 60,
  "severity": "required"
}
```

或使用任务自己的极小运行：

```text
--help
--dry-run
EVAL_LIMIT=1
1 training step
```

smoke 必须来自目标 adapter，不能由 RSI 假定包名。

### 5.2 Rust

```json
{
  "extensions": [".rs"],
  "manifests": ["Cargo.toml", "rust-toolchain.toml"],
  "checks": [
    {
      "id": "check",
      "command": ["cargo", "check", "--locked", "--all-targets"],
      "timeoutS": 600,
      "severity": "required"
    },
    {
      "id": "fmt",
      "command": ["cargo", "fmt", "--check"],
      "timeoutS": 60,
      "severity": "advisory"
    },
    {
      "id": "clippy",
      "command": ["cargo", "clippy", "--locked", "--all-targets", "--", "-D", "warnings"],
      "timeoutS": 600,
      "severity": "advisory"
    },
    {
      "id": "tests",
      "command": ["cargo", "test", "--locked"],
      "timeoutS": 900,
      "severity": "required"
    }
  ],
  "lsp": {
    "command": ["rust-analyzer"],
    "root": "."
  }
}
```

Rust 目标可以使用 vendored dependencies 或 target 提供的 offline 环境；不能默认
允许 check 阶段下载 crates。

### 5.3 Go

```json
{
  "extensions": [".go"],
  "manifests": ["go.mod", "go.sum"],
  "checks": [
    {
      "id": "build",
      "command": ["go", "build", "./..."],
      "timeoutS": 300,
      "severity": "required"
    },
    {
      "id": "vet",
      "command": ["go", "vet", "./..."],
      "timeoutS": 300,
      "severity": "required"
    },
    {
      "id": "staticcheck",
      "command": ["staticcheck", "./..."],
      "timeoutS": 300,
      "severity": "advisory"
    },
    {
      "id": "tests",
      "command": ["go", "test", "./..."],
      "timeoutS": 600,
      "severity": "required"
    }
  ],
  "lsp": {
    "command": ["gopls"],
    "root": "."
  }
}
```

Go check 默认使用：

```text
GOFLAGS=-mod=readonly
GOPROXY=off
```

依赖必须来自目标仓库的 module cache 或目标声明的离线环境。

---

## 6. 检查选择

### 6.1 changed files

```text
git diff --name-only <parent> <commit>
```

只对 changed files 相关语言运行检查。

### 6.2 语言检测

按顺序：

1. 扩展名；
2. adapter manifests；
3. 目标仓库根目录的已知 manifest；
4. `Makefile` / `justfile` / `Taskfile` 中的 target-owned check（若 adapter 声明）；
5. 未知文件 → `unsupported`，不猜语言。

### 6.3 Polyglot

Python + Rust + Go 可能同时出现：

- Python 训练层 + Rust 扩展；
- Go 节点 + Rust 执行层；
- PyO3 / cgo / FFI 桥接。

规则：

- changed files 涉及几种语言，就运行几种 provider；
- 每种语言独立 required/advisory；
- 跨语言构建必须由 target 提供统一命令（例如 `make check`）；
- 不把“某个 provider 通过”当成整个 polyglot 通过；
- `unsupported` 文件不阻塞，但必须记录。

---

## 7. ImplementationGate 语义

### 7.1 成功

```text
所有 required checks ok
+ LSP 没有 required error
→ gate ok
→ 允许 runSeeded / run
```

### 7.2 Required failure

```text
required check failed / timeout
→ failed evidence
→ SubsetCritic/FullSetCritic invalid
→ repair loop
→ 不 charge experiment
→ 不写 candidates.jsonl
→ 不进入 evaluated_ids / refutation
```

### 7.3 Advisory failure

```text
advisory failed
→ CheckReport 记录 warning
→ 继续实验
```

### 7.4 Unavailable

```text
工具或 adapter 不可用
→ required check：status=failed，阻断实验
→ advisory check：记录 unavailable 后继续
→ 不允许把 required unavailable 静默当成通过
```

### 7.5 Baseline / protocol-only

- baseline 的空 patch 不要求代码检查；
- full/rebuttal 的协议-only 实验可以不做 diff check，但仍应跑 adapter 声明的 smoke；
- baseline 的 command 本身仍要通过目标实验环境；
- check failure 永远不能变成 scientific `bad`。

---

## 8. Check cache

key：

```text
check semantics version
+ commit + parent
+ changed files
+ LanguageSpec/checks（命令、env、timeout、severity、paths）
+ LSP spec（diagnostics/references severity）
+ RSI_PYTHON
```

规则：

- `ok` 和确定性的 `failed` 结果可复用；
- `unavailable` / `timeout` 不复用；
- failed 结果不能复用为成功；
- cache 必须记录来源 commit；
- 不跨 commit 复用；
- 不跨 specs/LSP/`RSI_PYTHON` 复用。

缓存位置：

```text
runs/<run_id>/artifacts/checks/
  cache/<hash>.json
  <label>/
    report.json
    <check-id>.log
    lsp-<language>.log
```

---

## 9. LSP 层

### 9.1 支持

| 语言 | LSP |
|---|---|
| Python | `pyright-langserver` / `ruff server` |
| Rust | `rust-analyzer` |
| Go | `gopls` |

### 9.2 当前实现形态

检查顺序是：

```text
1. LSP references（干净候选 commit）
2. CheckRunner（编译/类型/测试/smoke）
3. LSP diagnostics（CheckRunner 之后）
```

LSP references 先运行，使用 `textDocument/documentSymbol` 找到与 diff 新增行相交的符号，
再用 `textDocument/references` 检查引用。`referenceSeverity` 默认 advisory；设为
required 时，未引用符号会在 CheckRunner 之前阻断候选。

CheckRunner 可能生成 build 文件、venv、module cache 或测试产物；LSP diagnostics
因此放在 CheckRunner 之后，避免把“生成文件尚未存在”误报为诊断失败。

`GitWorkspace.check` 在 adapter 声明 `languages.<lang>.lsp` 时启动语言服务器，
打开 changed files，收集 diagnostics，然后停止 server。LSP 默认 advisory。

同一 LSP 客户端也作为只读模型工具暴露给 `code.*`、`engineer.*`、`ablation.*`、
`rebuttal.*` 的 Pi worker：

```text
lsp_diagnostics
lsp_definition
lsp_references
lsp_hover
lsp_document_symbols
lsp_workspace_symbols
```

工具绑定到 worker 的目标仓库目录。每个路径先解析并检查不能逃逸目录（包括
symlink）。工具只发送 initialize、didOpen 和读取请求；不发送 rename、format、
applyEdit 或 executeCommand。代码改动仍必须通过 unified diff → `writePatch` →
git commit。

### 9.3 约束

- 每个 worktree、每种语言最多一个 server；
- lazy start；
- 只请求 changed files；
- timeout；
- 输出截断；
- abort 时终止 server；
- 只读；
- 不支持直接写入；
- 后续 `rename/format` 只能返回 WorkspaceEdit，再转 unified diff，不能绕过 `writePatch`。

### 9.4 不可用

LSP 默认 advisory。目标 adapter 可把 `lsp.severity` 设为 `required`；此时
LSP 不可用、超时或 error diagnostic 都会阻断实验。

`CheckRunner` 对 required check 的 `unavailable` 也按失败处理，不允许静默通过。

---

## 10. Toolchain 与安全

当前部署选择是 **一个可直接使用的 `pi-agent-rsi` 镜像**：Python、Rust、Go 的
检查工具和语言服务器都嵌入镜像，避免用户进入容器后再手工安装。

同时提供 secret-free 执行方式：把同一镜像作为 CPU-only、无 secrets 的 check/LSP
worker，或按语言拆分 toolchain 镜像。主容器默认使用 `auto`：worker ready 时使用
worker，否则回退主容器。目标代码检查不应获得 API key、SSH 或无关宿主机目录。

也可以直接使用目标仓库自己的 CI/devcontainer：

```text
make check
just check
nix develop
```

约束：

- CPU-only；
- 无 GPU；
- 无网络；
- 检查工作区只挂载候选 worktree；
- 不把 RSI 源码作为可写输入；
- 检查环境不暴露 API key、SSH 或无关 secrets；
- timeout；
- 资源限制；
- check 产物不写回目标仓库；
- 版本固定；
- 不自动下载语言工具。

### 10.1 Secret-free check worker

`container/compose.yaml` 增加 `check-worker` 服务：

- 与主容器使用同一镜像，但没有 `OPENCODE_API_KEY`；
- `network_mode: "none"`；
- 不挂载 `~/.ssh` 或 `container/pi-home`；
- RSI 源码只读；只有 `runs/` 可写；
- 以 `cap_drop: ALL` 和 `no-new-privileges` 运行；
- 启动 `src/rsi/runtime/check-worker.ts`。

主进程通过 `runs/.check-worker/` 的 request/result 文件通信。工作目录包含：

```text
ready.json
pending/<id>.json
running/<id>.json
results/<id>.json
cancel/<id>.json
```

`RSI_CHECK_WORKER` 取值：

```text
off       # 默认；在主容器内执行
auto      # worker ready 时使用 worker；否则回退本地
required  # worker 不 ready 时 fail closed
```

compose 主容器默认使用 `auto`。worker 缺失、超时或结果无效时，required check
返回 `unavailable`，不会静默通过。worker 只接受 `runs/<run_id>/` 下的 run root
和 candidate worktree；越界请求返回错误。

主容器仍保留本地执行路径，便于宿主机测试和没有 worker 的部署。worker 的
filesystem 边界是“只读 RSI + 只写 runs”，不是嵌套 VM。

检查/LSP 环境只继承 `PATH`、`HOME`、`TMPDIR`、locale 和工具链配置：
`RUSTUP_HOME`、`CARGO_HOME`、`RUSTUP_TOOLCHAIN`、`GOTOOLCHAIN`、`GOPATH`、
`GOBIN`、`GOCACHE`、`GOMODCACHE`。`HOME`/`TMPDIR` 重定向到 check 隔离目录；
API key 和 SSH 变量不继承。

---

## 11. 新增语言接入说明

新增语言（例如未来加入 C++）只允许增加 provider/adapter，不允许在 orchestrator 里
加入语言分支。

### Step 1：声明语言

在目标仓库 `.rsi/adapter.json` 增加：

```json
{
  "id": "cpp",
  "extensions": [".cc", ".cpp", ".h", ".hpp"],
  "manifests": ["CMakeLists.txt", "compile_commands.json"],
  "checks": [],
  "lsp": {
    "command": ["clangd"],
    "root": "."
  }
}
```

### Step 2：声明 required checks

至少提供：

- syntax / compile；
- type check（若语言有）；
- target-owned smoke；
- 核心测试命令。

示例：

```json
{
  "id": "build",
  "command": ["cmake", "--build", "build", "--parallel"],
  "timeoutS": 600,
  "severity": "required"
}
```

命令必须来自目标仓库，不使用 RSI 猜的路径。

### Step 3：声明 test selection

```json
{
  "testSelection": [
    {
      "globs": ["src/core/**"],
      "command": ["ctest", "--test-dir", "build", "-R", "core"]
    }
  ]
}
```

没有 mapping 时 fallback 到 target 的统一 check 命令，不 fallback 到其他语言命令。

### Step 4：声明 LSP

只读 server，固定版本：

```json
{
  "lsp": {
    "command": ["clangd", "--background-index"],
    "root": "."
  }
}
```

LSP 不是 required gate 的默认项；由 adapter 决定 required/advisory。

### Step 5：工具链

当前 core 不在同一 job 中切换 per-language 镜像。新增语言时：

- 使用 worker 镜像已有命令；或
- 在 adapter `checks` 中调用目标自带的构建脚本；或
- 在目标仓库自己的 CI/devcontainer 中运行该检查，并把结果作为 advisory。

如果未来加入 `toolchain.image`，它必须保持：

- CPU-only；
- 无 GPU；
- 无 secrets；
- 固定版本。

### Step 6：添加 fixtures

必须增加：

- 正确 patch；
- 编译错误 patch；
- 测试失败 patch；
- timeout；
- LSP 不可用；
- polyglot 检测；
- required/advisory 区分。

### Step 7：验证

```text
language detection
required failure → 0 runner calls / 0 experiment charge
advisory failure → continue
check cache
protected paths
LSP read-only
resume
polyglot
target-specific smoke
```

### Step 8：文档

更新：

- `.rsi/adapter.json` schema 文档；
- target adapter 说明；
- LSP server 安装说明；
- toolchain image 版本；
- 示例 checks。

### Step 9：不修改 core

如果现有接口无法表达新语言：

- 扩展 `CheckSpec` / `LanguageSpec`；
- 扩展 schema；
- 不新增 `if (language === ...)`；
- 不绕过 `ImplementationGate`；
- 不把语言特定逻辑写进 `Orchestrator`。

---

## 12. 失败与恢复

- check fail 不丢 patch；保留 `.diff`、`.apply.log`、check logs；
- check fail 不消耗 experiment budget；
- check report 按 check semantics version + commit + changed files + specs + LSP +
  `RSI_PYTHON` 的哈希持久化到 `artifacts/checks/cache/`；resume 可命中并复制到当前 label；
- `unavailable`/`timeout` 不写入 cache，避免把基础设施故障当成候选属性；
- timeout 记录为 `timeout`，不当作科学失败；
- adapter 或工具缺失记录 `unavailable`；
- 不把 check failure 写进 scientific refutation；
- 不把 check failure 当成 candidate journal 行。

---

## 13. 验收清单

### Python

- [ ] compileall / pyright / ruff / pytest
- [ ] 目标 import smoke
- [ ] `EVAL_LIMIT=1` 或等价 smoke
- [ ] pyright-langserver

### Rust

- [ ] cargo check
- [ ] cargo test
- [ ] clippy / fmt advisory
- [ ] rust-analyzer
- [ ] offline/vendored dependencies

### Go

- [ ] go build
- [ ] go vet
- [ ] go test
- [ ] staticcheck advisory
- [ ] gopls
- [ ] module cache / no network

### Gate

- [x] required failure → 0 runner calls
- [x] required failure → 0 experiment charge
- [x] failed evidence 不进入 `evaluated_ids`
- [x] failed evidence 不进入 refutation
- [x] failed evidence 不进入 `candidates.jsonl`
- [x] advisory failure 可继续
- [x] unavailable 显式记录
- [x] patch / no-op / parent-commit guard 仍生效
- [x] baseline 空 patch 不误判
- [x] full/rebuttal protocol-only 可运行 smoke
- [x] resume 命中 check cache

### Worker / LSP

- [x] secret-free check worker 无凭据、无网络、RSI 源码只读
- [x] worker 缺失/超时/越界 → required unavailable
- [x] 模型-facing LSP 只读工具
- [x] LSP 路径逃逸拒绝
- [x] adapter 多清单歧义 → fail closed

### 多语言

- [ ] 只改 adapter 即可新增语言
- [ ] Python/Rust/Go polyglot 检测
- [ ] unsupported 文件记录但不猜语言
- [ ] 不硬编码绝对路径
- [ ] 不在 core 中加入语言分支

---

## 14. 当前支持列表

| 语言 | 状态 | 必需检查 | LSP |
|---|---|---|---|
| Python | target supported | compileall, pyright, pytest, smoke | pyright-langserver |
| Rust | target supported | cargo check, cargo test | rust-analyzer |
| Go | target supported | go build, go vet, go test | gopls |
| TypeScript / JavaScript | not supported | — | — |
| C / C++ | not supported | — | — |
| Java / Kotlin | not supported | — | — |
| C# / .NET | not supported | — | — |

当前目标支持 Python、Rust、Go 的 provider；未实现前不得把 provider 标记为通过。
其他语言不安装工具链，不写 provider，不出现在默认配置中。

---

## 15. 相关文件

- `docs/ARCHITECTURE.md`
- `docs/PROBLEM.md`
- `docs/SPEC.md`
- `src/rsi/runtime/workspace.ts`
- `src/rsi/agents/coding.ts`
- `src/rsi/agents/engineering.ts`
- `src/rsi/providers/superagent.ts`
- 目标仓库 `.rsi/adapter.json`
