# 代码交付流程

## 执行顺序

实施者生成 unified diff。
`GitWorkspace.writePatch` 应用补丁并创建候选 commit。
路径检查验证候选的修改范围。
`ImplementationVerifier` 核查模块实现和入口连接。
目标 adapter 声明的检查命令执行动态测试。
required 检查通过后，runner 执行 subset 实验。
critic 使用测量证据判定候选。
修复者修改代码后，流程重新核查候选。

旧 STEP 12 至 STEP 22 对应以下执行链。

```text
选择 idea
  → 实施 diff
  → 应用补丁并固定 commit
  → 修改范围检查
  → 模块实施核查
  → 变更文件语法检查
  → 目标动态测试
  → subset 测量
  → critic 判定
      → engineer → 修复补丁 → 重新执行检查和测量
      → good → full 实施、检查、测量和判定
      → bad → 记录 trace 并继续搜索
```

检查失败会产生 failed evidence。
critic 将执行失败送入修复流程。
修复预算耗尽会标记 `invalid`。
运行失败不会提供科学否证证据。
实现证据为 `checkRejection` 和 `IdeaImplementer.evaluate`。

后续流程依次执行以下阶段。

```text
Spec 审计和 trace 记录
  → 演化、重新播种和 data gate
  → incumbent 选择和严格比较
  → 消融及 attribution gate
  → 初稿和同行评审
  → rebuttal 任务、补充实验和稿件修订
  → meta 评审及有界代码修复
  → 重新归因和重写
  → 引用及方法代码审计
  → 最终 gate 和导出
```

代码修复改变 commit 后，旧消融结果失效。
稿件接收条件绑定当前候选 commit。
实现证据为 `Orchestrator.adopt` 和 `Orchestrator.exportArtifacts`。

源码入口包括以下文件。

- `src/rsi/agents/coding.ts` 的 `checkRejection`。
- `src/rsi/agents/engineering.ts` 的 `refine`。
- `src/rsi/runtime/workspace.ts` 的 `writePatch` 和 `check`。

## 修改范围

adapter manifest 来自基线 checkout。
候选无法通过修改源 checkout 的 manifest 放宽规则。
`protected_paths` 声明受保护路径。
`mutable_paths` 声明允许修改的路径。
路径支持目录和 glob。
声明空白名单会阻断候选。

核心保护测试、数据、tokenizer、评测和协议目录。
核心保护实验入口和诊断入口。
重命名检查同时覆盖旧路径和新路径。
模拟 runner 使用独立的合成提交协议。

实现入口位于 `src/rsi/runtime/workspace.ts` 的 `writePatch`。
路径匹配函数位于 `src/rsi/runtime/protections.ts`。

## 模块实施核查

`code.verify` 使用独立任务核查候选源码。
核查报告包含 `decision`、`modules`、`tests` 和 `findings`。
`modules` 记录文件、符号和对应要求。
缺少模块证据会得到 `engineer`。
存在实施问题会得到 `engineer`。
报告保存候选 commit 和实验 scope。

模块缓存绑定 commit、机制和假设。
Spec 缓存另行绑定任务约束和 diff。
Subset 和 full 共享相同实现的核查结果。
Ablation 和 rebuttal 的缓存另行绑定干预补丁。
缓存位于 `artifacts/checks/implementation-cache/`。
实现入口位于 `ImplementationVerifier.verify`。

实施提示使用源码摘要。
交付核查读取累计变更源码和真实入口。
核查读取基线独立测试。
核查分块覆盖全部正文。
报告记录独立断言的路径和符号。
pytest、Rust 和 Go 检查记录实际执行的测试标识。
当前执行标识比对仍使用前缀匹配。
自定义命令缺少执行标识时跳过该比对。
这两个缺口的复现见 `NOTES.md` 的 A3 和 A4。
实现证据为 `GitWorkspace.reviewSources` 和 `ImplementationVerifier.verify`。

模型核查仍需要动态测试提供运行证据。
模型判断的正确率为 `unknown`。
缺少标注样本和人工核对结果。

## 动态检查

Python 默认检查包含以下命令。

```text
python -m py_compile <变更的 Python 文件>
python -m pytest -q -x
```

语法检查跳过已删除的文件。
目标项目可以在 `languages.python.checks` 中声明额外命令。
类型和风格检查由目标项目按需声明。
现有 adapter 的旧语言服务命令在解析时移除。
其他显式检查继续执行。
只有 advisory 检查时，报告为 `unavailable`。
缺少可执行的 required 检查会阻断候选。
实现证据为 `runChecks` 的 `required` 和 `status`。

Rust 执行 `cargo test --locked --all-targets`。
Go 执行 `go test -v ./...`。
测试命令完成测试所需的编译。
配置入口位于 `src/rsi/runtime/checks.ts` 的 `BUILTIN`。

测试覆盖范围由目标项目负责。
训练任务需要验证前向、梯度、参数更新和 checkpoint 重载。
缓存路径和边界输入需要独立断言。
真实入口需要加载候选模块。
目标 adapter 负责真实训练和评测。

Python 默认类型检查和风格检查已经移除。
语法检查和模块核查继续执行。
pytest 没有导入的文件仍需要语法证据。
模块核查提供机制、接口与源码对应证据。
动态测试提供实际执行证据。
检查配置和核查报告共同定义交付范围。

## 检查 worker

`check-worker` 执行目标声明的检查。
worker 使用 runs 下的请求和结果目录。
候选 worktree 位于运行目录。
容器配置通过挂载和网络设置隔离 worker。

`RSI_CHECK_WORKER` 支持以下值。

- `off` 使用当前进程执行检查。
- `auto` 在 worker 可用时使用 worker。缺失时阻断候选。
- `required` 在 worker 缺失时阻断候选。

检查报告位于 `artifacts/checks/<label>/report.json`。
报告包含 commit、检查命令、状态、退出码和耗时。
报告保存 stdout 和 stderr。
报告保存环境指纹和标准测试的执行标识。
缓存查询前重新探测实际执行器和已安装依赖。
required 检查失败后停止剩余检查。

## Bug 修复

检查失败后，`checkRejection` 创建 failed evidence。
修复摘要优先包含 required 检查。
摘要分别保留 stdout 和 stderr 的尾部。
完整输出保存在检查报告。
候选报告路径包含 commit。
取消信号和预算错误向上传播。

首个 seed 执行失败后，调度器停止后续 seed。
失败证据进入实现修复循环。
修复提交重新执行模块核查和目标检查。

## 科学证据

Subset 和 ablation 使用相同的 subset 数据集。
两者使用相同的短预算和 seeds。
Full 修改代码后，控制组重新测量。
代码变化会使旧消融计划和结果失效。
Meta 修复执行 Spec 审计和重新归因。
归因失败会阻断写作。
最终接收条件再次检查归因。

`audit_baseline` 保存审计参考代码。
`spec_reports` 保存审计结果和候选 commit。
`ablation_commit` 绑定消融结果。
`manuscript_commit` 绑定稿件。
`seed_id` 保存工程修复前的搜索身份。

状态字段位于 `src/rsi/core/state.ts`。
接收条件位于 `Orchestrator.exportArtifacts`。

## 验证边界

本地测试提供本地运行证据。
远端环境需要真实入口报告。
远端源码目录默认包含 run ID。
显式共享目录仍需要调用方提供隔离。
实现证据为 `RemoteRunner.run` 的 `worktreeTemplate`。
`AdapterSpec.preflight` 在同一远端实验会话执行。
预检失败会阻断实验入口。
未配置时，Python 候选默认执行变更文件语法预检。
目标可以声明设备或真实入口预检。
端到端加速需要同一候选的对照计时。
优化项和风险项见 `NOTES.md`。
