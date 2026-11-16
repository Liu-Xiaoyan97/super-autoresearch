# 优化项和风险项

## 已实施的优化

| 编号 | 优化项 | 实现证据 |
|---|---|---|
| O1 | 移除语言服务器客户端、引用检查、诊断、编码工具和容器依赖。 | `src/rsi/runtime/checks.ts` 的 `runCheckJob`，`src/rsi/providers/superagent.ts` 的 `toolsFor`，`container/Dockerfile`。 |
| O2 | Python 默认候选检查使用变更文件语法检查和动态测试。 | `src/rsi/runtime/checks.ts` 的 `BUILTIN.python.checks`。 |
| O3 | 新 adapter 默认检查采用同一配置。 | `skills/rsi-adapter/scripts/scaffold_adapter.py` 的 `languages`。 |
| O4 | 增加模块实施核查。 | `src/rsi/agents/coding.ts` 的 `ImplementationVerifier`。 |
| O5 | 缓存重复的模块核查。 | `ImplementationVerifier.verify` 的 `cachePath`。 |
| O6 | 修复摘要同时包含 stdout、stderr 和退出码。 | `checkRejection` 的 `detail`。 |
| O7 | 候选检查报告路径包含 commit。 | `checkRejection` 的 `checkLabel`。 |
| O8 | 补丁检查执行修改白名单和协议保护。 | `GitWorkspace.writePatch` 的 `mutable` 和 `protectedRules`。 |
| O9 | 从基线 checkout 读取 adapter。 | `GitWorkspace.init` 的 `loadAdapter`。 |
| O10 | 允许协议型空补丁直接返回。 | `askUnifiedDiff` 的 `allowEmpty`。 |
| O11 | 首个 seed 执行失败后停止继续调度。 | `runSeeded` 的失败分支。 |
| O12 | Subset 和 ablation 使用同一数据集列表。 | `GitWorkspace.run` 的 `datasets`。 |
| O13 | 代码变化后重新生成消融计划和结果。 | `Orchestrator.adopt` 和 `ablations`。 |
| O14 | Meta 和最终接收条件验证归因。 | `Orchestrator.metaReview` 和 `exportArtifacts`。 |
| O15 | 持久化 Spec 审计报告。 | `ResearchState.specReports` 和 `Orchestrator.exportIntegrity`。 |
| O16 | 审计参考代码独立保存。 | `ResearchState.auditBaseline`。 |
| O17 | Resume 根据稿件接收状态继续执行。 | `Orchestrator.run` 的 `needsPaper`。 |
| O18 | 稿件绑定候选代码。 | `ResearchState.manuscriptCommit`。 |
| O19 | 工程修复保留 seed 身份。 | `Trace.seed_id`，`ResearchState.record` 和 `goodTraces`。 |
| O20 | 合并路径匹配逻辑。 | `src/rsi/runtime/protections.ts`，`src/rsi/iteration.ts`。 |
| O21 | 远端源码目录默认按 run 隔离。 | `RemoteRunner.run` 的 `worktreeTemplate`。同一 run 复用目录。 |
| O22 | 保留远端路径中 `~/` 的展开。 | `shellQuote`，`tests/remote-runner.test.ts`。 |
| O23 | 源码和 diff 采用完整分块审计。 | `reviewChunks`，`SpecAuditor.audit`，`MethodCodeAuditor.audit`。 |
| O24 | 阻断纯 advisory 检查配置。 | `runChecks` 的 `required.length` 和 `status`。 |
| O25 | 模块上下文优先包含候选变更源码。 | `GitWorkspace.brief` 的 `changed` 和 `codeExt`。 |

## 已处理的风险

| 编号 | 风险 | 当前处理 |
|---|---|---|
| R1 | 候选修改测试后获得通过结果。 | 核心保护测试路径。 |
| R2 | 候选越过 manifest 的修改范围。 | 核心执行 `mutable_paths`。 |
| R3 | 修改源 checkout 的 manifest 放宽规则。 | 核心读取基线 manifest。 |
| R4 | 模块未接入真实入口。 | 模块核查要求路径和符号证据。动态测试仍需入口断言。 |
| R5 | pytest 错误输出没有进入修复提示。 | 修复提示保留 stdout 和 stderr。 |
| R6 | 相同 label 覆盖不同提交的修复报告。 | label 加入 commit。 |
| R7 | 已失败实现重复消耗其余 seed。 | 首次执行失败后结束 seed 调度。 |
| R8 | Meta 复用旧消融结果。 | 消融结果绑定 commit。 |
| R9 | 归因失败后仍接收论文。 | Meta 和最终 gate 检查归因。 |
| R10 | Resume 丢失 Spec 审计。 | 审计报告进入状态。缺少报告时重新审计。 |
| R11 | Baseline 晋升后生成空审计 diff。 | 审计使用独立参考代码。 |
| R12 | 控制组和消融组数据集不同。 | 两者采用 subset 数据集。 |
| R13 | Resume 跳过待修订稿件。 | 恢复逻辑检查接收状态和稿件 commit。 |
| R14 | 工程修复后的 idea ID 导致原 seed 重复入队。 | 调度使用稳定 seed 身份。 |
| R15 | 旧语义的检查缓存被复用。 | `check_version` 更新为 9。模块核查缓存版本更新为 6。 |
| R16 | 控制组部分 seed 失败后仍使用均值归因。 | `incumbentSubset` 检查各 seed 的状态和指标。 |
| R17 | Full 修改代码后继续使用旧 subset 控制组。 | 控制组 commit 必须匹配当前候选。 |
| R18 | 默认远端源码目录被其他 run 的同步删除覆盖。 | 默认路径包含 `{run_id}`。显式共享路径的风险见 U6。 |
| R19 | 远端路径把 `~` 当作字面目录。 | `shellQuote` 保留前导 `~/`。 |
| R20 | 纯 advisory 结果授权候选进入实验。 | 缺少已执行 required 检查时，报告为 `unavailable`。 |
| R21 | 模块核查遗漏非 Python 源码和树尾变更文件。 | 审计读取累计变更源码、入口和基线独立测试。完整分块覆盖见 U17。 |

## 本轮风险处理

用户要求 U2、U6、U7、U8、U19 人工停止跟进。
用户确认 baseline 代码已经提交。
本轮按该范围执行。

| 编号 | 状态 | 处理结果 | 实现证据 |
|---|---|---|---|
| U1 | good | 标准测试记录文件、类和符号。自定义测试缺少执行标识会阻断交付。A3、A4 回归通过。 | `testIdentity`，`runChecks` 的 `executed_tests`，`checkRejection` 的 `missing`。 |
| U2 | unknown | 人工停止跟进。 | 本轮用户指令。 |
| U3 | good | 增加逐次模型耗时和交付阶段耗时。复用相同 commit 的核查和测试证据。合并小文件审计请求。 | `BaseAgent.ask` 的 `duration_s`，`checkRejection` 的 `delivery_timing`，`ImplementationVerifier.verify` 的 `chunks`。 |
| U4 | good | 预检与实验共用远端会话。预检失败阻断实验。首个失败 seed 终止后续调度。 | `AdapterSpec.preflight`，`buildRemoteInvocation` 的 `preflight`，`runSeeded`。 |
| U5 | good | 缓存绑定执行器和已安装依赖指纹。worker 在缓存查询前探测实际环境。 | `checkEnvironment`，`CheckJobRequest.probeOnly`，`GitWorkspace.checkCacheKey` 的 `environment`。 |
| U6 | unknown | 人工停止跟进。 | 本轮用户指令。 |
| U7 | unknown | 人工停止跟进。 | 本轮用户指令。 |
| U8 | unknown | 人工停止跟进。 | 本轮用户指令。 |
| U9 | good | 消融只接收已有组件的 `path:symbol` 证据。删除结构探针补足逻辑。 | `AblationPlanner.plan` 的 `supported`，`AblationPlan.code_refs`。 |
| U10 | good | 恢复协议包含远端设置。旧候选缺少环境证据时退出可复用集合。损坏状态保留原文。 | `ResearchState.fromDict`、`invalidateCandidateEnvironment`、`readStateObject`，B1 至 B3 的修复回归。 |
| U11 | good | 镜像构建通过。独立隔离 worker 启动并执行检查任务。 | `/tmp/rsi-container-build.log`，`/tmp/rsi-container-worker-validation.log`。 |
| U12 | good | 解析 manifest 时移除旧服务命令。保留目标动态测试配置。 | `languageSpecs` 的命令过滤，`tests/checks.test.ts` 的迁移断言。 |
| U13 | good | 默认要求 worker。`auto` 在 worker 缺失时阻断。显式 `off` 选择本地执行。 | `checkWorkerMode`，`GitWorkspace.check` 的 `mode`。 |
| U14 | good | 全部 diff 正文进入分块审计。方法正文的全部陈述接受审计。 | `SpecAuditor.audit` 和 `MethodCodeAuditor.audit` 的 `reviewChunks`。 |
| U15 | good | 模块核查检查实施和测试映射。Spec 审计集中检查任务约束，并缓存源码证据。 | `ImplementationVerifier.verify` 的 prompt，`SpecAuditor.audit` 的 `spec-cache`。 |
| U16 | good | 基线测试和独立通道新增测试提供断言证据。普通实施补丁继续保护测试。A2 回归通过。 | `IndependentTestAuthor`，`GitWorkspace.addTests`、`reviewSources`，`ImplementationVerifier.verify`。 |
| U17 | good | 读取累计变更文件和入口的完整正文。审计分块覆盖全部正文。 | `GitWorkspace.reviewSources`，`ImplementationVerifier.verify` 的 `pieces`。 |
| U18 | good | 默认 Rust 和 Go 只执行测试命令。删除独立构建及重复静态检查。 | `BUILTIN.rust.checks` 和 `BUILTIN.go.checks`。 |
| U19 | unknown | 人工停止跟进。用户确认 baseline 已提交。 | 本轮用户指令。 |

U3 的远端端到端加速数值仍为 `unknown`。
本轮缺少相同目标候选的前后对照计时。
新增耗时记录支持后续实测。
默认 npm 测试的实测结果单独记录。

标准测试框架会输出实际执行标识。
Python 使用 JUnit XML。
Rust 使用测试结果行。
Go 使用详细测试结果行。
测试框架缺少执行标识时，标准检查会阻断候选。
目标自定义检查可以通过 `kind` 声明测试类型。
自定义命令的实现仍由可信 adapter 定义。
实现证据为 `runChecks` 的 `pytest`、`executedTests` 和 `kind`。

容器验证使用独立的无网络 worker。
该 worker 的根文件系统和 RSI 挂载均为只读。
已有主容器存在 `pi`、`ssh` 和 `python3` 进程。
证据为 `docker exec pi-agent-rsi node` 读取 `/proc/*/comm` 的输出。

## 静态检查和动态测试

Python 默认流程移除通用类型检查和风格检查。
默认流程保留变更文件语法检查。
默认流程保留模块实施核查。
默认流程执行目标动态测试。
配置证据为 `BUILTIN.python.checks` 和 `ImplementationVerifier.verify`。

动态测试的覆盖范围为 `unknown`。
缺少每个目标项目的入口、机制和边界断言清单。
因此，删除全部源码检查的依据不足。
语法检查覆盖 pytest 没有导入的变更文件。
模块核查要求提供机制与源码的对应证据。
运行行为由目标测试及真实实验报告验证。
实现证据为 `expand`、`ImplementationAudit` 和 `checkRejection`。

目标 manifest 显式声明的动态检查继续执行。
旧服务命令在解析时迁移。
Rust 默认执行 `cargo test --locked --all-targets`。
Go 默认执行 `go test -v ./...`。
测试命令执行测试所需的编译。
实现证据为 `languageSpecs` 和 `BUILTIN`。

## 原流程记录中的错误

原 STEP 20 把 subset 判定放在测量之前。
原 STEP 27 把 full 判定放在测量之前。
更正后的顺序为检查、测量、判定、修复。
实现证据为 `SubsetCoder.implement`、`FullSetCoder.scale` 和 `IdeaImplementer.evaluate`。

原流程缺少 STEP 47 至 STEP 51。
该编号缺口使 rebuttal 和 meta 的衔接不完整。
完整交付顺序见 `docs/Deterministic_code.md`。

## 测试入口和耗时

`npm test` 执行快速回归。
`npm run test:integration` 执行完整流程用例。
`npm run test:full` 执行全部用例。
入口证据为 `package.json` 的 `scripts`。

快速入口过滤名称带 `[integration]` 的用例。
完整流程仍保留搜索、修复、恢复、归因和接收断言。
共享成功流程合并重复的编码、消融和 baseline 导出检查。
导出检查复用同一次成功流程。
负面用例使用满足该分支的缩小搜索配置。
论文流程位于独立测试文件，并与搜索流程并发执行。
实现证据为 `tests/run-offline.test.ts` 和 `tests/paper-offline.test.ts`。

旧完整非离线回归执行 155 项。
其耗时为 166.294 秒。
旧日志为 `/tmp/rsi-final-core-tests.log`。
该批次包含重复的完整流程执行。
它与新的快速入口采用不同范围。
上一轮快速回归执行 157 项，157 项通过，0 项失败。
耗时为 14.729877916 秒。
日志为 `/tmp/rsi-fast-tests-final.log`。
上一轮完整回归执行 172 项，172 项通过，0 项失败。
耗时为 352.510332292 秒。
日志为 `/tmp/rsi-full-tests-final.log`。
完整回归启动后仍有恢复和缓存修改。
这些修改通过快速回归和最终定向回归验证。

## 验证记录

最终类型检查退出码为 0。
日志为 `/tmp/rsi-typecheck-final.log`。
最终定向回归执行 63 项，63 项通过，0 项失败。
耗时为 13.564119917 秒。
日志为 `/tmp/rsi-final-targeted.log`。

镜像构建退出码为 0。
镜像 ID 为 `e31db013abd7`。
日志为 `/tmp/rsi-container-build.log`。
工具链检查包含 Node、Python、Cargo、Go 和 Pi。
日志为 `/tmp/rsi-container-toolchain.log`。
隔离 worker 返回 `status=ok`，执行 1 项 required 测试。
该报告包含环境指纹。
日志为 `/tmp/rsi-container-worker-validation.log`。
独立验证容器已经删除。
删除命令退出码为 0。
上一轮交付时，运行容器需要重建以加载新镜像和 worker 协议 2。
当时 `docker inspect` 显示主容器和 worker 使用镜像 `7709c87fecbc`。
`docker image inspect pi-agent:local` 显示最新镜像为 `e31db013abd7`。
主容器直接挂载当前 RSI 源码。
当时 worker 的 ready 文件缺少 `protocol` 字段。
新框架要求 `protocol=2`，因此阻断该 worker 的检查请求。
当前任务是否已经受影响为 `unknown`。
缺少任务启动版本和运行日志。

用户授权后，`./container/up.sh run --force-recreate` 退出码为 0。
两个容器于 2026 年 11 月 15 日 23 时 27 分 07 秒启动。
时区为 Asia/Shanghai。
`docker inspect` 显示两个容器使用镜像 `e31db013abd7`。
两个容器均为 `status=running`，`restarts=0`。
主容器日志包含 `deterministic Python/Rust/Go toolchain ready`。
worker 日志包含 `ready`。
主容器协议检查输出 `protocol=2` 和 `ready=true`。
该检查调用 `checkWorkerReady`，退出码为 0。
容器重建会中断原容器进程。

上一轮交付时，远端入口执行结果为 `unknown`。
本轮有界 smoke 的实机报告见后文。

## 记录更正

旧 `NOTES.md` 将 U1、U16 的状态写为 `good`。
后续核查发现执行证据和可信测试补充缺口。
该次核查将状态更正为 `engineer`。
当前实现修复这些缺口，并通过回归验证。
当前状态和源码证据见 A2 至 A4。

本轮 `docs/CONTAINER.md` 曾写“检查模式默认使用 `RSI_CHECK_WORKER=required`”。
当前内容区分运行时默认值和 Compose 默认值。
运行时默认值为 `required`，Compose 默认值为 `auto`。
证据为 `checkWorkerMode` 和 `container/compose.yaml` 的 `RSI_CHECK_WORKER`。

旧 `handoff.md` 记录覆盖 167 项测试，并将容器部署标记为 `unknown`。
当前记录更正为 172 项完整回归及独立容器验证结果。
最终源码另通过 63 项定向回归和 157 项快速回归。

旧 `handoff.md` 原文包含“模型-facing LSP 工具”。
当前内容更正为只读文件工具和模块实施核查。
旧 `docs/Deterministic_code.md` 的默认检查描述包含自动类型和风格检查。
当前 Python 默认检查更正为变更文件语法检查和动态测试。
目标 adapter 的旧语言服务命令在解析时移除。
其他显式命令继续执行。
历史运行产物保留原始检查记录。

上次审核中，完整测试由人工停止。
该次完整测试结果为 `unknown`。
本次结果见“验证记录”。

旧离线测试原文为 `assert.equal(result.final.aborted, false)`。
该断言允许 Meta 归因失败后继续运行。
更正后的断言要求 `aborted=true` 和 `abort_reason=data_gate_not_met`。
修改位置为 `tests/run-offline.test.ts` 的 Meta 归因用例。

新增多文件补丁测试首次执行返回 `patch does not apply`。
原 fixture 使用 `.join("\n")` 再次拼接带换行的文件片段。
更正后的 fixture 使用 `.join("")`。
更正位置为 `tests/workspace-patch.test.ts` 的多语言上下文用例。
更正后定向回归为 50 项通过，0 项失败。

旧记录把纯 advisory 配置的阻断作为完整动态检查门槛。
更正后的门槛要求每种变更语言执行 required 动态测试。
仅执行语法检查的报告为 `unavailable`。
实现证据为 `runChecks` 的 `missingTests`。

旧 `GitWorkspace.check` 在运行检查前缺少候选 checkout。
恢复流程会因此检查错误的源码快照。
更正后的实现先 checkout，再执行检查。
相关回归先恢复 baseline，再运行候选 pytest。
证据为 `tests/checks.test.ts` 的候选断言用例。

旧方法代码判定使用 `Math.max(lower, model_score)`。
更正后的判定使用源码重合与模型支持的共同上限。
方法审计读取方法正文的全部陈述。
接收流程 fixture 显式声明其方法核查结果。
证据为 `MethodCodeAuditor.audit` 和 `tests/paper-offline.test.ts`。

首次镜像构建输出 `archive/tar: sockets not supported`。
构建上下文包含 `.codegraph/daemon.sock`。
本次 agent 停止该构建，并添加 `.dockerignore`。
重试仅发送 Dockerfile，构建退出码为 0。

## 容器重建后的流程核查

本次核查以 `examples/coral.json` 和默认 seed 7 为依据。
本节记录仍需处理的事项。

| 编号 | 状态 | 问题及影响 | 证据 |
|---|---|---|---|
| A1 | good | 旧 manifest 缺少解释器时，优先使用目标已准备的 venv。 | `resolveCheckPython`。`runs/delivery-startup-1794758588335/artifacts/checks/startup/report.json` 返回 `status=ok`，解释器为目标 `.rsi/venv/bin/python`。 |
| A2 | good | 独立请求生成补充测试。专用提交只允许新增测试文件。模块重新核查，动态检查执行新断言。 | `IndependentTestAuthor`，`GitWorkspace.addTests`，`RepoRef.validation`。`tests/checks.test.ts` 覆盖生成、提交、执行和保护。真实训练契约报告见下文。 |
| A3 | good | 比对完整文件、类和测试名。参数化测试只接受同一测试的参数后缀。 | `testIdentity` 和 `checkRejection`。`tests/delivery-flow.test.ts` 验证相邻名称和不同文件无法匹配。 |
| A4 | good | 每项动态测试需要执行标识。自定义命令输出 JSON `executed_tests`。缺少标识会阻断交付。 | `customExecutedTests`，`runChecks`，`checkRejection`。`tests/checks.test.ts` 验证空命令报告无法授权交付。 |
| A5 | good | 启动探测在模型和实验之前检查环境并收集 pytest。worker 协议更新为 3。 | `GitWorkspace.preflight`，`Orchestrator.run` 的 `startup_check`。`tests/delivery-flow.test.ts` 验证启动失败后调用计数为 0。 |
| A6 | unknown | 最新框架的远端训练、修复、消融、写作全流程缺少实机验证。 | 现有完整流程测试调用 `mockRun`。远端回归注入模拟 transport。`handoff.md` 缺少本次版本的真实完整 run 报告。 |

目标 `.rsi/venv/bin/python` 包含 pytest、torch 和 pyarrow。
使用该解释器收集同一测试文件时，退出码为 0。
该命令收集 7 项测试，耗时为 0.94 秒。
这次检查仅收集测试。
本轮另行执行真实动态测试。
原基线的 25 项测试全部通过。
该次 pytest 耗时为 4.00 秒。
报告为 `runs/delivery-tests-1794758978779/artifacts/checks/baseline-dynamic/report.json`。

真实补充测试覆盖前向、梯度、参数更新和 checkpoint 重载。
该测试调用真实模型的保存与加载入口。
该测试要求重载 logits 逐值相等。
原有 25 项测试通过，pytest 耗时为 3.20 秒。
新增 1 项测试通过，pytest 耗时为 1.33 秒。
报告为 `runs/delivery-contract-1794759626471/artifacts/checks/training-contract/report.json`。

远端有界 smoke 返回 `status=ok`。
该次执行 1 个训练步骤。
评测限制为每项任务 1 条记录。
报告为 `runs/adapter-smoke-65492906-a2c6-4dc3-af3b-19ddc8056fae/artifacts/smoke-summary.json`。
完整科研流程结果仍为 `unknown`。
缺少真实候选完成修复、归因和论文交付的报告。

最终快速回归执行 165 项，165 项通过，0 项失败。
耗时为 20.914620208 秒。
日志为 `/tmp/rsi-fast-delivery-final.log`。
完整回归执行 178 项，178 项通过，0 项失败。
耗时为 359.029234208 秒。
日志为 `/tmp/rsi-full-delivery-current.log`。
完整回归启动后新增补充测试流程和原生测试标识回归。
最终快速回归覆盖这些修改。
最终类型检查退出码为 0。
日志为 `/tmp/rsi-typecheck-delivery-final.log`。

验证期间，没有基线测试的 fixture 返回 pytest 退出码 5。
本次 agent 曾通过增加 fixture 基线断言绕过该问题。
当前实现允许启动收集报告空测试集合。
实际交付仍要求补充测试提供执行证据。
生成交付回归使用空基线测试集合，并执行新增断言。
另一轮新增测试收集插件未执行补充文件。
当前实现改用独立 required pytest 命令。
回归确认原有断言和补充断言均执行。

容器探测首次使用相对运行根目录。
`git worktree add` 将该路径解释为目标仓库的相对目录。
后续 checkout 返回 `spawnSync git ENOENT`。
当前 `GitWorkspace` 构造器将运行根目录解析为绝对路径。
错误 worktree 已通过 `git worktree remove --force` 清除。
`tests/workspace-patch.test.ts` 的基线 worktree 回归使用相对路径验证该修复。
该定向回归执行 1 项，1 项通过，0 项失败。
日志为 `/tmp/rsi-relative-root-final.log`。

两个部署容器于 2026 年 11 月 16 日 00 时 34 分 42 秒重新启动。
时区为 Asia/Shanghai。
`./container/up.sh run --force-recreate` 退出码为 0。
`docker inspect` 显示两个容器为 `running`，重启计数为 0。
主容器验证输出 `protocol=3`、`ready=true` 和 `test_task_stage=search`。
该验证调用 `checkWorkerReady` 和 `stageOfTask`，退出码为 0。
镜像仍为 `e31db013abd7`，本轮源码通过挂载加载。

## 再次复查恢复风险

本轮用户要求复查风险、容器和旧 run 的恢复条件。
本轮核查保留研究状态，并在临时目录复现缺陷。

| 编号 | 状态 | 缺陷 | 证据 |
|---|---|---|---|
| B1 | good | 恢复协议增加 `remote`、`diagnose_command` 和 `job_worker`。改变远端上下文长度会拒绝恢复。 | `protocol.fields`，`tests/delivery-flow.test.ts` 的协议变更回归，`/tmp/rsi-bfix-restore.log`。 |
| B2 | good | 候选逐项保存检查环境指纹。恢复重新核对 trace、checkpoint、incumbent 和归因证据。缺少或改变的环境证据退出复用集合。测量缓存绑定候选环境。 | `RepoRef.check_environment`、`invalidateCandidateEnvironment`、`Orchestrator.run`、`measurementCache`，两组恢复回归。 |
| B3 | good | 中断前先读取状态和 final。解析失败时保留原文件。结束写入和中断写入使用原子替换。 | `readStateObject`、`atomicWriteJson`，`tests/restart-safety.test.ts` 的损坏状态、中断和 host restart 回归。 |

旧 U10 状态原文为 `good`。
复查阶段将该状态更正为 `engineer`。
后续修复和回归完成后，当前状态为 `good`。

当前主容器和 worker 均为 `running`，重启计数为 0。
主容器验证返回 `protocol=3` 和 `ready=true`。
容器内 `git rev-parse --short HEAD` 返回 `09f59b6`。
该版本的运行环境无需重建容器。

本轮核查旧 run `coral-wikitext-ppl-s7-3`。
该 run 状态版本按缺省值解析为 1。
`ResearchState.fromDict` 返回成功。
它包含 4 条 trace、8 个 seed、0 个 checkpoint。
它没有 incumbent，也没有环境指纹。
代码引用共 14 项，`git cat-file` 验证全部存在。
保存的远端配置和诊断命令与当前 fixture 相同。
旧 baseline 外部文件缺失。
状态中的 baseline 满足 `baselineIsValid` 的 commit 和有限指标条件。
`runResearch` 已有缺失外部文件时复用状态 baseline 的分支。

独立启动探测返回 `status=ok`。
它收集 25 项测试，pytest 耗时为 0.85 秒。
报告为 `runs/reaudit-startup-1794761497638/artifacts/checks/startup/report.json`。
远端 GPU 计算进程查询退出码为 0，输出为空。
本轮未执行真实 run 恢复。
恢复后的全流程结果为 `unknown`。
缺少恢复任务的模型、检查和实验日志。

本轮快速回归执行 165 项，165 项通过，0 项失败。
耗时为 21.898801084 秒。
日志为 `/tmp/rsi-reaudit-fast.log`。
类型检查退出码为 0。
日志为 `/tmp/rsi-reaudit-typecheck.log`。

## B1 至 B3 修复验证

本轮在内存中恢复旧 run，保留磁盘状态原文。
baseline 提交保持相同。
3 条历史 trace 带有 `invalid=true`，其中包含原有 invalid trace。
缺少环境证据的候选不再作为有效研究结果复用。
远端上下文长度变更被恢复协议拒绝。
证据为 `/tmp/rsi-bfix-restore.log`。

旧 run 恢复会增加候选检查和重新测量。
该迁移由 `invalidateCandidateEnvironment` 执行。
baseline 按用户已授权的可信协议保留。
本轮没有自动启动长期科研任务。

本轮首次快速回归有 1 项 fixture 失败。
该 fixture 原本缺少环境指纹。
当前 fixture 显式提供 `environment_fingerprint=test-env`。
修复位置为 `tests/delivery-flow.test.ts` 的身份比对用例。

最终快速回归执行 171 项，171 项通过，0 项失败。
耗时为 23.663921791 秒。
日志为 `/tmp/rsi-bfix-fast-final.log`。
最终类型检查退出码为 0。
日志为 `/tmp/rsi-bfix-typecheck.log`。
独立复查回归的结果见 `/tmp/rsi-bfix-reaudit.log`。
该定向复查执行 6 项，6 项通过，0 项失败。
耗时为 0.543448625 秒。
完整回归执行 184 项，184 项通过，0 项失败。
耗时为 441.601632458 秒。
日志为 `/tmp/rsi-bfix-full.log`。
完整回归启动后增加 host restart 和正常恢复路径回归。
随后修改候选缓存的环境绑定。
最终快速回归覆盖这些修改。

本轮再次检查恢复主入口、候选环境绑定和损坏文件保护。
正常恢复路径回归确认环境变更会移除有效候选证据。
该测试位于 `tests/delivery-flow.test.ts`。
类型检查和 `git diff --check` 退出码均为 0。
本轮测试未复现 B1 至 B3 的旧行为。
完整真实科研恢复仍为 `unknown`。
缺少长期训练、消融和论文交付的恢复报告。

两个容器于 2026 年 11 月 16 日 01 时 17 分 27 秒重新启动。
时区为 Asia/Shanghai。
`docker inspect` 显示两个容器为 running，重启计数为 0。
旧 run 的内存恢复返回 `worker_ready=true` 和 `state_unchanged=true`。
证据为 `/tmp/rsi-bfix-container.log`。
重新启动后的独立启动探测返回 `status=ok`。
该报告包含实际环境指纹。
报告为 `runs/bfix-startup-1794763280566/artifacts/checks/startup/report.json`。

系统架构与研究流程图采用内置图像生成工具。
图示包括主容器、隔离检查容器、目标 worktree 和远端 GPU 环境。
图示还包括独立测试、bug 修复、证据 gate 和状态恢复。
生成提示词位于 `docs/figures/rsi-system-overview.prompt.txt`。
最终图像位于 `docs/figures/rsi-system-overview.png`。
图像经三轮生成与连接关系核对后保存。

远端只读 SSH 查询退出码为 0。
查询命令为 `nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader`。
查询输出为空。
该结果只说明查询时没有列出的 GPU 计算进程。

## 当前框架复查新增缺陷 C1

C1 当前状态为 `good`。
上轮环境证据修复遗漏同一 seed 的多个历史候选。
修复前，旧 trace 环境失效会删除 seed 的 evaluated 标记。
修复前，同一 seed 的有效新 trace 无法恢复该标记。
最小复现输出 `valid_winner=["new"]` 和 `evaluated_after=false`。
同次复现的 `nextSeeds(1)` 返回 `root`。
该行为使已存在有效结果的 seed 再次进入调度。
实现证据为 `src/rsi/core/state.ts` 的 `invalidateCandidateEnvironment` 和 `nextSeeds`。
本次复现使用内存状态，没有启动实验。
真实重复训练的耗时为 `unknown`。
缺少该分支的实机训练记录。

本轮在环境证据失效处理后，恢复有效 trace 的已评估标记。
该规则同时保留有效的 good 和 bad 判定。
新增回归覆盖 trace 两种顺序、checkpoint 清理、状态恢复和重复核对。
原复现现在输出 `evaluated_after=true` 和 `scheduled_again=[]`。
证据为 `/tmp/rsi-c1-repro.log`。
组合检查执行 512 组，失败数为 0。
证据为 `/tmp/rsi-c1-combinations.log`。
快速回归执行 172 项，172 项通过，0 项失败。
耗时为 25.079780125 秒。
日志为 `/tmp/rsi-c1-fast.log`。
类型检查退出码为 0。
日志为 `/tmp/rsi-c1-typecheck.log`。
完整回归执行 187 项，187 项通过，0 项失败。
耗时为 435.46406575 秒。
日志为 `/tmp/rsi-c1-full.log`。
本轮复查未复现 C1 的旧行为。
完整科研恢复结果仍为 `unknown`，缺少长期 run 的恢复报告。
独立 worktree 验证本次暂存快照。
其快速回归执行 172 项，172 项通过，0 项失败。
耗时为 24.67932375 秒。
日志为 `/tmp/rsi-c1-isolated-fast.log`。
独立类型检查退出码为 0。
日志为 `/tmp/rsi-c1-isolated-typecheck.log`。
本次提交范围为 C1 源码、回归测试和对应记录。
