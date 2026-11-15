# 确定性代码层 — 交接文档

状态：实现完成。确定性核心、模型-facing LSP 工具和 secret-free check worker
已经加入：`src/rsi/runtime/checks.ts`、`src/rsi/runtime/lsp.ts`、
`src/rsi/runtime/lsp-tools.ts`、`src/rsi/runtime/check-worker.ts`、
`GitWorkspace.check`、coder 检查门，以及内嵌的 Python/Rust/Go 容器工具链。
本文档记录设计理由、独立评审决策和验证证据。

## Progress snapshot — 2026-11-15 16:00 CST

已完成：

- `src/rsi/runtime/checks.ts`：adapter/builtin Python/Rust/Go CheckSpec；
- `GitWorkspace.check`：changed-file 检测、required/advisory、check report、
  cache、protected paths、RSI root 拒绝、check 后恢复干净候选树；
- 六个 coder/engineer 路径的 pre-experiment gate；
- `checkFailedEvidence` 保留失败候选 `RepoRef`、诊断和 `check_report`；
- required `unavailable` fail closed；advisory 可记录后继续；
- samples-only parent proxy、parentless evidence、缺失 per-seed metrics 拦截；
- dirty tracked worktree 不参与测量；
- bounded iteration 转发 check，并消费 coder 返回的 failed evidence；
- `src/rsi/runtime/lsp.ts`：只读 LSP diagnostics 与 definition/references/
  hover/documentSymbols/workspaceSymbols 客户端；
- `src/rsi/runtime/lsp-audit.ts`：LSP references 先行；用 diff 新增行定位
  changed symbols，再查 references；默认 advisory，可设 required；
- `src/rsi/runtime/lsp-tools.ts`：六个模型-facing 只读 LSP 工具；只对
  `code.*`/`engineer.*`/`ablation.*`/`rebuttal.*` 暴露；路径逃逸拒绝；
- `src/rsi/runtime/check-worker.ts` 与 `check-client.ts`：secret-free check
  worker，文件邮箱、ready 检测、超时/取消、越界拒绝；
- `container/compose.yaml`：`check-worker` 服务；无 provider key、无 SSH、
  `network_mode: none`、RSI 源码只读、只有 `runs/` 可写；主容器默认
  `RSI_CHECK_WORKER=auto`；
- adapter 多清单按 `problem`/`source_fixture` 唯一匹配；歧义 fail closed；
- `container/Dockerfile` 内嵌 pyright/ruff/pytest/Rust/Go/gopls，镜像已重建；
- 运行中的 `pi-agent-rsi` 与 `pi-agent-rsi-check-worker` 已切换到新镜像；
- `handoff.md`、`docs/Deterministic_code.md`、`docs/CONTAINER.md`、README 入口。

最新验证：

```text
npx tsc --noEmit 通过
完整套件：141 pass（0 fail）
新增/修改测试：24 pass（adapter, worker, checks, LSP, Pi worker）
容器内定向测试：LSP/worker/adapter 通过
```

容器验证：

```text
pyright 1.1.414
ruff 0.17.3
pytest 9.2.0
rustc 1.99.0
rust-analyzer 1.99.0
go 1.27.2
gopls v0.24.0

check-worker ready; mailbox /workspace/RSI/runs/.check-worker
worker: no OPENCODE_API_KEY, /root/.ssh absent
worker: /workspace/RSI/src/rsi/types.ts read-only, /workspace/RSI/runs writable

worker probe: python compile + pyright-langserver ok
worker probe: cargo check --offline ok
worker probe: go build ok
LSP probe: pyright / rust-analyzer / gopls diagnostics ok

check env preserves RUSTUP_HOME, CARGO_HOME, RUSTUP_TOOLCHAIN,
GOTOOLCHAIN, GOPATH, GOBIN, GOCACHE, GOMODCACHE after HOME isolation.
```

尚未完成 / 风险：

- Worker 的边界是“无凭据、无网络、RSI 源码只读、只有 `runs/` 可写”；
  它不是嵌套 VM。目标 check 命令仍可修改 `runs/` 内的运行数据；隔离目标
  是凭据和网络，不是恶意 target 代码的完整性证明。
- Worker 通过文件邮箱通信；worker 崩溃时 `ready.json` 可能残留。主进程会
  等待到 job timeout，然后 required check 返回 `unavailable`，不会静默通过。
- LSP 工具只绑定 worker 的 target 目录，不绑定 candidate commit；候选改动
  仍必须通过 patch/commit 流程。

仓库：RSI（`git rev-parse --show-toplevel`）。
目标仓库身份：`Problem.repo`。不得使用固定绝对路径。
当前范围：**Python、Rust、Go**。TypeScript/JavaScript、C/C++、Java/Kotlin、
C#/.NET 目前明确不在范围内。

---

## 1. 为什么需要这次变更

### 1.1 观察到的失败

候选 h6 实际没有被评测。观察到的链条是：

```text
git apply 失败
  → writePatch 返回父提交，而不是抛错
  → SubsetCoder 测量了父（baseline）提交
  → 结果被标记为 h6 候选
  → SubsetCritic 看到一次看起来有效的执行，返回 "bad"
  → ResearchState.record() 把 h6 加入 evaluated_ids
  → nextSeeds() 永久跳过 h6
```

因此 h6 的实现失败被转换成了科学否证。这是出处（provenance）失败。
这不是模型质量失败。

### 1.2 已经落地的即时修复

以下提交是问题与窄修复的证据：

- `a7530cf` — 不能应用的 patch 永不被测量。
  `GitWorkspace.writePatch()` 现在拒绝失败的 `git apply`。
  subset 路径把拒绝转换成 failed evidence，而不是 baseline 测量。
- `7df3ca8` — 能应用但不改动任何内容的 diff 被拒绝。
  no-op 检查捕获“`git apply` 成功但树变化为空”的情况。
- `ca2ba8d` — 实现失败是 unknown，永远不是测量结果。
  它加入集中的 provenance/effective-diff 检查、所有 coder scope 的
  failed-evidence 路径、invalid trace 处理和 journal 过滤。
- `4f3e61d` — invalid 判定不进入候选 journal。
- `c772b42` — 覆盖 invalid incumbent 恢复清理与修复 trace 的测试。
- `da2d3c3` — 拒绝 null-result/parentless 证据，并保证模拟尝试唯一。
- `tests/provenance.test.ts` 和 `tests/workspace-patch.test.ts` 是这些性质的
  回归证据。

### 1.3 为什么确定性门是下一层

已有修复证明候选是真实 git 变更。它们不证明变更后的代码能构建、能通过类型检查、
能通过目标声明的测试、或能执行目标的 smoke 命令。

需要确定性门，原因如下：

1. **它在 GPU 时间之前捕获实现错误。** 编译错误和类型错误在本地检测成本低。
2. **它给修复循环可操作的诊断。** 模型应修复类型错误，不应修复伪造的科学失败。
3. **它把 `invalid` 与 `bad` 分开。** 实现失败是 unknown，不是对研究想法的否证。
4. **它让代码路径的可审计性显式化。** 每个检查都有命令、超时、退出码、
   stdout/stderr 和产物路径。
5. **它与语言无关。** Python、Rust、Go 使用同一个门。语言差异放在目标 adapter 中。

### 1.4 为什么科学流程不被删除

确定性层最多证明：

```text
真实候选提交
+ 构建/类型/测试/smoke 证据
```

它**不**证明：

- 候选实现了假设；
- 目标在 GPU 上成功执行；
- 指标有限且完整；
- 候选优于复现的 baseline；
- 改进能通过完整协议与多种子；
- 组件归因或论文结论有效。

因此以下阶段仍然必要：

- baseline 复现；
- subset 与 full 测量；
- `SubsetCritic` / `FullSetCritic`；
- engineer 修复循环；
- `auditTrace` 规范审计；
- selector/adoption；
- ablation 与 rebuttal；
- review、meta-review 与 integrity audit。

唯一有意简化的部分是重复的实现管道（patch/check/failure 处理）。
科学门不被简化。

---

## 2. 范围与非目标

### 支持的目标语言

| 语言 | 用途 | 必需工具 |
|---|---|---|
| Python | AI/ML、训练、评测 | `python3`、`pyright`、`ruff`、`pytest`、`pyright-langserver` |
| Rust | 区块链执行、密码学、性能 | `cargo`、`rustc`、`clippy`、`rust-analyzer` |
| Go | 区块链节点、P2P、RPC、索引器 | `go`、`gopls`、`staticcheck` |

### 不在范围内

- TypeScript/JavaScript、C/C++、Java/Kotlin、C#/.NET；
- 完整 IDE 或直接 LSP 编辑；
- 用 LSP 替代测试或科学评测；
- GPU 服务器上的远端 LSP；
- 在基础镜像中安装所有语言。

接口保持开放：新增语言必须是 adapter/provider 变更。
不得在 orchestrator 中出现 `if (language === ...)`。

---

## 3. 目标状态

```text
Problem + target adapter
        │
        ▼
LanguagePlan
  ├─ Python provider
  ├─ Rust provider
  └─ Go provider
        │
        ▼
GitWorkspace.writePatch
        │
        ▼
ImplementationGate
  ├─ changed files
  ├─ language detection
  ├─ CheckRunner
  ├─ LspManager
  └─ CheckReport
        │
        ├─ required fail → failed evidence → invalid → repair
        └─ pass → subset/full/ablation/rebuttal GPU experiment
```

本次变更后的规范流水线：

```text
patch
→ provenance / apply / no-op / effective diff
→ language detection
→ required checks
→ advisory checks
→ target smoke
→ LSP diagnostics
→ runtime experiment
→ runtime evidence validation
→ scientific critics
```

### 3.1 保证

**G1 — 真实候选实现**

只有当以下条件全部成立时，系统才能保证候选代码变更是真实的：

- `git apply` 成功；
- 树发生变化；
- 提交不等于父提交；
- effective diff 非空；
- 变更路径符合目标 adapter；
- 被测量的是该候选提交。

系统不能保证候选在语义上实现了假设。这需要规范/方法代码审计和领域测试。

**G2 — 运行可用性**

系统能提供证据：候选能构建、能通过声明检查、能执行目标 smoke。
系统不能证明普遍可用性或科学有效性。运行时实验证据仍然强制。

---

## 4. 当前代码边界

可追踪的当前文件：

| 文件 | 角色 |
|---|---|
| `src/rsi/runtime/workspace.ts` | `GitWorkspace.writePatch`、`run`、worktree、provenance 守卫、check 路由 |
| `src/rsi/runtime/checks.ts` | CheckSpec、语言检测、`runChecks`、`runCheckJob` |
| `src/rsi/runtime/lsp.ts` | 只读 LSP 客户端：diagnostics/definition/references/hover/symbols |
| `src/rsi/runtime/lsp-tools.ts` | 模型-facing 只读 LSP 工具 |
| `src/rsi/runtime/check-protocol.ts` | worker request/result 契约 |
| `src/rsi/runtime/check-client.ts` | worker 模式、ready 检测、请求/等待/取消 |
| `src/rsi/runtime/check-worker.ts` | secret-free worker 进程 |
| `src/rsi/agents/coding.ts` | subset/full/ablation/rebuttal coders、`unappliedEvidence` |
| `src/rsi/agents/engineering.ts` | subset/full engineer |
| `src/rsi/agents/critics.ts` | subset/full critics；确定性门 |
| `src/rsi/core/orchestrator.ts` | 代码循环、科学循环、journal、adoption |
| `src/rsi/core/state.ts` | checkpoint、invalid evidence 恢复 |
| `src/rsi/providers/superagent.ts` | PiWorker 只读工具白名单、LSP 工具注入 |
| `src/rsi/iteration.ts` | 目标 adapter/受保护路径执行路径 |
| `container/Dockerfile` | 当前容器工具链 |
| `container/compose.yaml` | 主容器 + secret-free check worker |
| `docs/Deterministic_code.md` | 详细目标契约 |

当前实现限制：

- `src/rsi/runtime/checks.ts` 提供 target/builtin CheckSpec 执行；
- `GitWorkspace.check` 检测变更文件语言，并运行 required/advisory 检查；
- 所有 coder/engineer scope 把失败的 required 检查拒绝为 failed evidence；
- `src/rsi/runtime/lsp.ts` 提供只读诊断和读取查询；
- `lsp-tools.ts` 把同一客户端暴露为代码 worker 工具；路径逃逸拒绝；
- `container/Dockerfile` 内嵌 pyright、pyright-langserver、ruff、pytest、
  rustc/cargo/rust-analyzer 和 Go/gopls；
- `container/compose.yaml` 的 `check-worker` 无凭据、无网络，RSI 源码只读；
- 目标 `.rsi/adapter/*.json` 仍是目标专属 check/LSP 配置的来源。

LSP 诊断路径是可选的。当前只在选中的目标 adapter 声明 `lsp` 块时运行。
它不是通用的模型工具，也不写文件。

---

## 5. 数据契约

### 5.1 Adapter

目标仓库持有的清单文件，例如 `.rsi/adapter/<problem>.json`：

```jsonc
{
  "schema": 1,
  "problem": "coral-wikitext-ppl",
  "source_fixture": "examples/coral.json",
  "protected_paths": [],
  "mutable_paths": [],
  "languages": {
    "python": {
      "extensions": [".py"],
      "manifests": ["pyproject.toml", "requirements.txt"],
      "checks": [
        {"id":"compile","command":["python3","-m","compileall","-q","."],"timeoutS":60,"severity":"required"},
        {"id":"typecheck","command":["pyright","--outputjson"],"timeoutS":120,"severity":"required"},
        {"id":"lint","command":["ruff","check","."],"timeoutS":60,"severity":"advisory"},
        {"id":"tests","command":["pytest","-q","-x"],"timeoutS":300,"severity":"required"}
      ],
      "lsp": {"command":["pyright-langserver","--stdio"],"root":"."}
    }
  }
}
```

清单发现必须处理现有的目标布局 `.rsi/adapter/*.json` 和通用
`.rsi/adapter.json`。选择必须依据 `problem`/`source_fixture`。
不得依据固定文件名选择。

### 5.2 核心接口

```ts
export type CheckSeverity = "required" | "advisory";

export interface CheckSpec {
  id: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutS: number;
  severity: CheckSeverity;
  paths?: string[];
}

export interface LanguageSpec {
  id: string;
  extensions: string[];
  manifests?: string[];
  checks: CheckSpec[];
  lsp?: {
    command: string[];
    root?: string;
    env?: Record<string, string>;
    severity?: CheckSeverity;
    referenceSeverity?: CheckSeverity;
    initializationOptions?: Record<string, unknown>;
  };
}

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

`parser`、`testSelection` 和 per-language `toolchain.image` 是未来扩展，不在当前
core 接口中。

### 5.3 Workspace 扩展

```ts
interface Workspace {
  check(repo: RepoRef, label: string): Promise<CheckReport>;
}
```

`check()` 必须在候选 worktree（`repo.path`）中运行。不得在 RSI 源码中运行。

---

## 6. 实现工作项

以下是工作项，不是阶段路线图。

### 6.1 Adapter 解析

交付物：

```text
src/rsi/runtime/checks.ts  (loadAdapter/languageSpecs/detectLanguages)
tests/adapter.test.ts
```

要求：

- 加载 `.rsi/adapter.json` 和 `.rsi/adapter/*.json`；
- 存在多个清单时，依据 `problem` 唯一匹配；
- 没有唯一 `problem` 时，依据 `source_fixture` 唯一匹配；
- 仍不唯一 → `null`（fail closed），不选第一个；
- 只有一个无身份声明的通用清单时使用它；
- 从变更文件和清单检测语言；
- 支持多语言项目；
- 内置 Python/Rust/Go provider 作为 adapter 缺失时的默认；
- 不做绝对路径假设。

### 6.2 CheckRunner

交付物：

```text
src/rsi/runtime/checks.ts
src/rsi/runtime/check-client.ts
src/rsi/runtime/check-worker.ts
```

要求：

- 先运行 required 检查，再运行 advisory 检查；
- 工作目录为 `repo.path`；
- 超时；
- 捕获 stdout/stderr/退出码；
- 写 `artifacts/checks/<label>/report.json` 和每个检查的日志；
- 不使用 GPU；
- 默认不使用网络；
- 不访问 worktree 之外的目标路径；
- 按 commit + 变更文件 + specs + LSP + `RSI_PYTHON` 缓存；
- `auto`/`required` 模式把同一 job 交给 secret-free worker；
- worker 缺失/超时/越界 → required `unavailable`。

### 6.3 ImplementationGate

交付物：

```text
src/rsi/runtime/checks.ts  (runCheckJob)
src/rsi/runtime/workspace.ts  (GitWorkspace.check)
```

要求：

- 检测语言；
- 选择检查；
- 运行检查；
- 可选运行 LSP 诊断；
- 返回 `CheckReport`；
- required 失败时返回带类型的 invalid 结果；
- 遇到 unavailable 时记录，不得伪造通过；
- 对显式空 baseline/仅协议 patch 跳过代码检查。适用时仍运行声明的 smoke。

### 6.4 Coder 集成

交付物：

```text
src/rsi/agents/coding.ts
src/rsi/agents/engineering.ts
```

要求：

- 在 `writePatch` 之后、在 `runSeeded`/`run` 之前调用门；
- required 失败返回带诊断的 failed evidence；
- 不计实验费用；
- 六个 coder/engineer scope 使用同一个 helper；
- 保持 `unappliedEvidence` 语义；
- 不改变科学 critic 判定。

### 6.5 LSP

交付物：

```text
src/rsi/runtime/lsp.ts
src/rsi/runtime/lsp-audit.ts
src/rsi/runtime/lsp-tools.ts
tests/lsp.test.ts
tests/lsp-audit.test.ts
```

要求：

- 顺序：LSP references（干净候选）→ CheckRunner → LSP diagnostics；
- references 用 documentSymbol + diff 新增行定位 changed symbols；
- references 默认 advisory；`referenceSeverity` 可设 required；
- stdio JSON-RPC 客户端；
- initialize/shutdown/diagnostics/definition/references/hover/symbols；
- 每个 worktree + 语言一个服务器；
- 惰性启动；
- 超时和输出上限；
- abort 清理；
- 只读。不得直接编辑文件；
- Python 使用 `pyright-langserver`，Rust 使用 `rust-analyzer`，Go 使用 `gopls`；
- LSP 不可用时记录。required/advisory 由 adapter 决定；
- 六个读取工具只对 coder/engineer scope 暴露；
- 路径逃逸（含 symlink）拒绝；
- 不发送 rename/format/applyEdit/executeCommand。

### 6.6 容器开箱可用

最终容器必须无需手工安装即可提供三种语言服务器：

```text
python3
pyright-langserver
ruff
pytest
rustc / cargo / rust-analyzer
go / gopls
```

`staticcheck` is optional and is not required for the base image.

要求：

- 固定版本；
- 仅 CPU 检查；
- LSP/检查工具不需要 GPU；
- 镜像中不含密钥；
- `bootstrap.sh` 校验二进制；
- `Dockerfile` 安装工具链。不依赖宿主机二进制；
- 保持主容器在当前 Docker/Kiri 设置中可用；
- 记录构建参数与 registry/proxy 用法。

### 6.6.1 Current execution boundary

The embedded tools are available in both `pi-agent:local` services. The default
container path is the secret-free worker:

- `container/compose.yaml` starts `check-worker` with no `OPENCODE_API_KEY`, no
  SSH mount, `network_mode: "none"`, `cap_drop: ALL` and
  `no-new-privileges`;
- `/workspace/RSI` is read-only; only `/workspace/RSI/runs` is writable;
- the worker runs `src/rsi/runtime/check-worker.ts`;
- the main process submits jobs through `runs/.check-worker/` and waits for a
  report;
- `RSI_CHECK_WORKER=auto|required|off` selects worker, fail-closed worker, or
  local execution.

The main container still keeps a local execution path. That path has
`HOME`/`TMPDIR` redirected to the check artifact directory and does not inherit
API/SSH environment variables, but it is not a filesystem or network sandbox.

The worker boundary is not a nested VM. Target check commands can write inside
`runs/`; the worker prevents credential and network access, not arbitrary
tampering by malicious target code.

### 6.7 失败语义

- required 检查失败 → `failed evidence` → `invalid` → 修复；
- advisory 失败 → 记录并继续；
- required 不可用 → failed evidence（fail closed）；advisory 不可用 → 明确记录并继续；
- worker 缺失/超时/越界 → required `unavailable`；
- 失败的检查永不进入 `evaluated_ids`、否证、候选 journal；
- 运行时失败仍为 `SubsetCritic`/`FullSetCritic` invalid；
- 任何确定性检查不得覆盖 AI 输出或科学算术。

### 6.8 测试

新增：

- adapter 选择/schema；
- 变更文件语言检测；
- 多语言检测；
- required 失败 → 0 runner 调用 / 0 实验计费；
- advisory 失败 → 继续；
- 超时；
- unavailable；
- 缓存；
- LSP diagnostics、definition、references、hover、documentSymbols、
  workspaceSymbols；
- LSP 路径逃逸拒绝；
- LSP 不可用/超时记录；
- worker required 成功/失败、越界拒绝、缺失 fail closed；
- baseline 空 patch；
- full/rebuttal 仅协议 patch；
- h6 回归仍然通过；
- resume/sanitization。

最终命令：

```text
npx tsc --noEmit
node --test tests/*.test.ts
```

---

## 7. 为什么这个设计可追踪

| 要求 | 证据 / 理由 |
|---|---|
| 永不把父提交当候选测量 | h6 事故；`a7530cf`、`7df3ca8`；`tests/workspace-patch.test.ts`；`writePatch` 约第 1128–1222 行 |
| 实现失败是 unknown | `ca2ba8d`；`unappliedEvidence`；`tests/provenance.test.ts`；`trace.invalid` 处理 |
| 不污染候选 journal | `4f3e61d`；`journalCandidates` 过滤 invalid verdict/trace/sample |
| 恢复不得信任旧代理 | `c772b42`；`ResearchState.fromDict` 检查最终证据并清除依赖产物 |
| GPU 之前先编译/测试 | h6 + `ImplementationGate`；避免把 subset/full 预算花在坏代码上 |
| 检查由目标仓库拥有 | 目标仓库拥有其构建系统。RSI 不得硬编码 Python 或包名 |
| LSP 只读 | 防止绕过 `writePatch`/git commit/provenance。诊断和读取工具都只发读取请求；路径逃逸拒绝 |
| 容器开箱可用 | 用户要求。工具必须在执行镜像中，不得启动后手工安装 |
| 检查无凭据、无网络 | `check-worker` 无 API key/SSH，`network_mode: none`，RSI 源码只读 |
| 科学阶段保留 | 确定性检查证明代码有效性，不证明指标改进、完整协议、归因或结论 |

---

## 8. 决策与待定问题

### 决策

1. 先实现确定性检查，再实现 LSP。
2. required 最小检查：编译/类型/构建、声明测试、目标 smoke。
3. LSP 诊断默认为可选/advisory，除非 adapter 标为 required。
4. 不使用 LSP 直接编辑。
5. 不删除 subset/full 测量或科学 critic。
6. 保留六条 coder 路径，但集中 patch/gate/failed-evidence 管道。
7. 容器内嵌 Python/Rust/Go 语言服务器。
8. Required check 的 `unavailable` fail closed；advisory 记录后继续。
9. check 失败保留失败候选和报告路径，不复用“patch 未应用”的构造函数。
10. 移除语言无关的 whitespace-only 判定；精确树无变化仍然拒绝。
11. 增加 protected paths、RSI root 拒绝、per-seed metrics 完整性。
12. samples-only parent proxy 也受同一 provenance 规则约束。
13. dirty tracked worktree 不测量。
14. bounded iteration 消费 coder failed evidence。
15. LSP 顺序：references 先、CheckRunner 后、diagnostics 最后；默认 advisory，
    required 由每个语言的 `lsp.referenceSeverity` / `lsp.severity` 决定。
16. 模型-facing LSP 工具只读，绑定 worker 目标目录，路径逃逸拒绝。
17. 确定性检查交给 secret-free `check-worker`；compose 主容器默认 `auto`，
    代码缺省 `off`，`required` fail closed。
18. adapter 多清单按 `problem` 唯一匹配，再按 `source_fixture` 唯一匹配；
    仍不唯一则 fail closed。
19. check report 写入 `artifacts/checks/<label>/report.json`，同时按
    commit + changed files + specs + LSP + `RSI_PYTHON` 的哈希持久化到
    `artifacts/checks/cache/`，resume 可复用。

### 已解决的评审问题

- `CheckReport` 对 resume/audit 足够：evidence 保存 `check_report` 路径；
  cache 文件覆盖全部输入，readCachedCheck 会复制到当前 label 并更新路径。
- 缺少 adapter：内置 Python/Rust/Go provider 继续可用；多个清单无法唯一匹配
  时 fail closed（`null`）。
- required 检查运行位置：compose 默认 `auto` 使用 secret-free worker；代码缺省
  `off`；主容器本地执行是显式回退。
- 多语言公共构建命令：由 adapter 的每语言 `checks` 表达；core 不猜。
- Rust/Go smoke：由目标 adapter 声明；builtin 只提供 check/test 基线。
- 清单发现：`problem` → `source_fixture` → 唯一通用清单；否则 fail closed。
- LSP required/advisory：按语言独立配置 `lsp.severity`。

---

## 9. 验收标准

1. required 检查失败导致 0 次 runner 调用和 0 次实验计费。
2. 产生的证据是 invalid，不是科学 bad/否证。
3. `candidates.jsonl` 不含失败检查行。
4. 真实候选满足 commit != parent 且 effective diff 非空。
5. Python、Rust、Go 各自有声明的检查计划和 LSP 计划。
6. 新增语言只需要 adapter/provider 变更，不需要 orchestrator 条件分支。
7. LSP 不能直接编辑 worktree。
8. 容器为 Python/Rust/Go 提供可用的语言服务器。
9. 现有 Python 测试和 h6 回归保持通过。
10. 目标实验仍拥有真实的 train/eval/checkpoint 证据。
11. secret-free worker 无 provider key、无 SSH、无网络，RSI 源码只读。
12. worker 缺失/超时/越界时 required check 为 `unavailable`。
13. 模型-facing LSP 工具只读，路径逃逸拒绝。
14. resume 从持久化 check report cache 复用结果。

---

## 10. 当前状态

- 确定性代码、模型-facing LSP 工具和 secret-free check worker **已实现**。
- 运行中的主容器和 worker 已切换到新镜像。
- 当前变更已通过类型检查和定向测试；完整套件结果记录在上方快照。
- 仍需在真实目标仓库上执行一次 Python/Rust/Go adapter smoke，以确认
  目标声明命令与依赖环境；这属于目标仓库验证，不是 RSI 代码缺失。
- 最终变更同时更新了 `docs/Deterministic_code.md`、`docs/CONTAINER.md`、
  README、本交接、代码、测试和 `container/compose.yaml`。
