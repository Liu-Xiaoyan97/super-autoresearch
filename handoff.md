# 确定性代码层 — 交接文档

状态：实现交接。确定性核心已经加入：
`src/rsi/runtime/checks.ts`、`src/rsi/runtime/lsp.ts`、`GitWorkspace.check`、
coder 检查门，以及内嵌的 Python/Rust/Go 容器工具链。
本文档记录设计理由和独立评审决策。

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
| `src/rsi/runtime/workspace.ts` | `GitWorkspace.writePatch`、`run`、worktree、provenance 守卫 |
| `src/rsi/agents/coding.ts` | subset/full/ablation/rebuttal coders、`unappliedEvidence` |
| `src/rsi/agents/engineering.ts` | subset/full engineer |
| `src/rsi/agents/critics.ts` | subset/full critics；确定性门 |
| `src/rsi/core/orchestrator.ts` | 代码循环、科学循环、journal、adoption |
| `src/rsi/core/state.ts` | checkpoint、invalid evidence 恢复 |
| `src/rsi/providers/superagent.ts` | PiWorker 只读工具白名单 |
| `src/rsi/iteration.ts` | 目标 adapter/受保护路径执行路径 |
| `container/Dockerfile` | 当前容器工具链 |
| `docs/Deterministic_code.md` | 详细目标契约 |

当前实现限制：

- `src/rsi/runtime/checks.ts` 提供 target/builtin CheckSpec 执行；
- `GitWorkspace.check` 检测变更文件语言，并运行 required/advisory 检查；
- 所有 coder/engineer scope 把失败的 required 检查拒绝为 failed evidence；
- `src/rsi/runtime/lsp.ts` 提供可选只读诊断；
- `container/Dockerfile` 内嵌 pyright、pyright-langserver、ruff、pytest、
  rustc/cargo/rust-analyzer 和 Go/gopls；
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
      "lsp": {"command":["pyright-langserver","--stdio"],"root":"."},
      "toolchain": {"image":"rsi-toolchain-python:local","workdir":"/workspace/repo"}
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
  parser?: "text" | "json" | "sarif";
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
    initializationOptions?: Record<string, unknown>;
  };
  testSelection?: Array<{ globs: string[]; command: string[] }>;
  toolchain?: { image?: string; workdir?: string; env?: Record<string, string> };
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
}
```

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
src/rsi/runtime/adapter.ts
src/rsi/runtime/language.ts
tests/language.test.ts
```

要求：

- 加载 `.rsi/adapter.json` 和 `.rsi/adapter/*.json`；
- 存在多个清单时，依据 `problem`/`source_fixture` 选择；
- 校验 schema 和必需字段；
- 从变更文件和清单检测语言；
- 支持多语言项目；
- adapter 缺失 → `unavailable`，不得静默通过；
- 不做绝对路径假设。

### 6.2 CheckRunner

交付物：

```text
src/rsi/runtime/checks.ts
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
- 按 commit + 变更文件 + 命令 + env + toolchain 缓存。

### 6.3 ImplementationGate

交付物：

```text
src/rsi/runtime/gate.ts
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
optional diagnostics integration in GitWorkspace.check
```

要求：

- stdio JSON-RPC 客户端；
- initialize/shutdown/diagnostics/definition/references/hover/symbols；
- 每个 worktree + 语言一个服务器；
- 惰性启动；
- 超时和输出上限；
- abort 清理；
- 只读。不得直接编辑文件；
- Python 使用 `pyright-langserver`，Rust 使用 `rust-analyzer`，Go 使用 `gopls`；
- LSP 不可用时记录。required/advisory 由 adapter 决定。

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

The embedded tools are available in the main `pi-agent:local` image. Checks and
LSP currently run from that container, with `HOME`/`TMPDIR` redirected to the
check artifact directory and API/SSH environment variables not inherited.
This is **not a complete filesystem or network sandbox**: the target process can
still read mounts visible to the main container and can attempt network access.

The secret-free isolated worker is the recommended hardening step but is not
implemented in this change. Do not claim filesystem/network isolation until that
worker exists.

### 6.7 失败语义

- required 检查失败 → `failed evidence` → `invalid` → 修复；
- advisory 失败 → 记录并继续；
- required 不可用 → failed evidence（fail closed）；advisory 不可用 → 明确记录并继续；
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
- LSP 不可用/超时记录（fake server fixture is an optional follow-up）；
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
| GPU 之前先编译/测试 | h6 + 计划的 `ImplementationGate`；避免把 subset/full 预算花在坏代码上 |
| 检查由目标仓库拥有 | 目标仓库拥有其构建系统。RSI 不得硬编码 Python 或包名 |
| LSP 只读 | 防止绕过 `writePatch`/git commit/provenance。`PiWorker` 当前只允许 read/grep/find/ls |
| 容器开箱可用 | 用户要求。工具必须在执行镜像中，不得启动后手工安装 |
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

### 评审者的待定问题

- `CheckReport` 对 resume 和审计是否足够，还是应按 `TraceCheckpoint` 存储？
- 科学运行时缺少 adapter 应 fail-open 还是 fail-closed？
  当前实现：不支持的文件变更和 required 工具不可用为 fail closed。
  仅协议 patch（无文件变更）不做代码检查。
- required 检查应在主容器运行，还是在无密钥的隔离 worker 运行？
- 多语言 Python/Rust/Go 项目如何选择公共构建命令？
- Rust/Go 的最小安全且有意义 smoke 是什么？
- 目标清单发现如何从多个 `.rsi/adapter/*.json` 中选择？
- LSP 诊断是否可以对一种语言 required，对另一种 advisory？

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

---

## 10. 当前状态

- 确定性代码**尚未**实现。
- 当前 provenance 守卫已实现并推送。
- 本交接必须由独立 Super Agent 在最终实现之前评审。
- 最终变更必须同时更新 `docs/Deterministic_code.md`、本交接、代码、测试
  以及容器 `bootstrap.sh`/`Dockerfile`。
