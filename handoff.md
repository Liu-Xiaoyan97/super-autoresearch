# 当前交付记录

## 代码流程

实施生成候选 commit。
补丁保护限制修改范围和基线独立测试。
模块核查读取完整变更源码、入口和独立测试。
缺少测试断言时，独立测试请求生成补充文件。
专用提交通道只允许新增测试。
普通实施和修复继续保护测试。
动态检查验证实际执行的测试标识。
检查失败进入 bug 修复循环。
修复后的 commit 重新接受核查和动态测试。
远端预检失败会阻断实验入口。
恢复时重新绑定候选 worktree，并校验实际环境。
实现证据见 `NOTES.md` 的 O1 至 O25 和 U1 至 U19。

语言服务客户端、工具、测试和容器依赖已经移除。
旧 adapter 的语言服务命令在解析时移除。
Python 保留变更文件语法检查和动态测试。
Rust 默认执行 `cargo test --locked --all-targets`。
Go 默认执行 `go test -v ./...`。
实现证据为 `languageSpecs` 和 `BUILTIN`。

## 测试入口

`npm test` 执行快速回归。
`npm run test:integration` 执行完整流程用例。
`npm run test:full` 执行全部用例。
快速入口跳过名称带 `[integration]` 的完整流程用例。
入口证据为 `package.json` 的 `scripts`。

## 测试记录

`npm run typecheck` 通过。
日志为 `/tmp/rsi-typecheck-delivery-final.log`。
快速回归执行 165 项，165 项通过，0 项失败。
耗时为 20.914620208 秒。
日志为 `/tmp/rsi-fast-delivery-final.log`。
完整回归执行 178 项，178 项通过，0 项失败。
耗时为 359.029234208 秒。
日志为 `/tmp/rsi-full-delivery-current.log`。
完整回归启动后新增补充测试流程和原生测试标识回归。
最终快速回归覆盖这些修改。

## 容器验证

镜像构建退出码为 0。
镜像 ID 为 `e31db013abd7`。
日志为 `/tmp/rsi-container-build.log`。
独立隔离 worker 执行 1 项 required 测试，返回 `status=ok`。
该报告包含环境指纹。
日志为 `/tmp/rsi-container-worker-validation.log`。
验证容器已经删除。
证据为 `docker rm -f rsi-delivery-validation-20261115` 的退出码 0。
用户授权后，两个部署容器重建完成。
命令为 `./container/up.sh run --force-recreate`，退出码为 0。
启动时间为 2026 年 11 月 15 日 23 时 27 分 07 秒。
时区为 Asia/Shanghai。
`docker inspect` 显示两个容器使用镜像 `e31db013abd7`。
两个容器均为 `status=running`，`restarts=0`。
主容器日志确认 Python、Rust、Go 工具链就绪。
上一轮协议检查输出 `protocol=2` 和 `ready=true`。
本轮两个容器于 2026 年 11 月 16 日 00 时 34 分 42 秒重新启动。
时区为 Asia/Shanghai。
主容器调用 `checkWorkerReady` 输出 `protocol=3` 和 `ready=true`。
`stageOfTask("code.tests")` 返回 `search`。
该验证退出码为 0。
容器重建会中断原容器进程。

本轮启动探测选择目标 `.rsi/venv/bin/python`。
报告状态为 `ok`。
证据为 `runs/delivery-startup-1794758588335/artifacts/checks/startup/report.json`。
原基线的 25 项动态测试通过，pytest 耗时为 4.00 秒。
证据为 `runs/delivery-tests-1794758978779/artifacts/checks/baseline-dynamic/report.json`。
另一次验证执行原有 25 项测试和新增 1 项训练契约测试。
两组测试分别耗时 3.20 秒和 1.33 秒，全部通过。
新增测试覆盖梯度、参数更新和 checkpoint 重载。
证据为 `runs/delivery-contract-1794759626471/artifacts/checks/training-contract/report.json`。
远端有界 smoke 执行 1 个训练步骤，并限制每项任务评测 1 条记录。
该报告返回 `status=ok`。
证据为 `runs/adapter-smoke-65492906-a2c6-4dc3-af3b-19ddc8056fae/artifacts/smoke-summary.json`。

## 剩余验证

本轮实现修复 A1 至 A5。
问题证据、实现入口和回归结果见 `NOTES.md`。
再次复查发现 B1 至 B3。
本轮修复 B1 至 B3。
恢复协议包含远端配置、诊断命令和 job worker。
恢复会逐项验证候选环境。
缺少环境证据的历史候选保留为 invalid 记录，并退出证据复用。
测量缓存绑定候选检查环境。
中断处理保留损坏文件，正常写入使用原子替换。
U10 的当前状态为 `good`。
修复证据见 `NOTES.md` 的 B1 至 B3 修复验证。
本轮最终快速回归执行 171 项，171 项通过，0 项失败。
耗时为 23.663921791 秒。
日志为 `/tmp/rsi-bfix-fast-final.log`。
完整回归执行 184 项，184 项通过，0 项失败。
耗时为 441.601632458 秒。
完整回归后的缓存绑定和恢复路径修改由最终快速回归覆盖。
日志为 `/tmp/rsi-bfix-full.log`。
最终类型检查退出码为 0。
实际环境启动探测返回 `status=ok`。
证据为 `runs/bfix-startup-1794763280566/artifacts/checks/startup/report.json`。
两个容器于 2026 年 11 月 16 日 01 时 17 分 27 秒重新启动。
时区为 Asia/Shanghai。
worker 验证返回 `ready=true`。

当前两个容器运行中，worker 协议为 3，ready 为 true。
本次核查无需重建容器。
旧 run `coral-wikitext-ppl-s7-3` 可以解析，14 项代码引用均存在。
其保存的远端配置和诊断命令与当前 fixture 相同。
独立启动探测返回 `status=ok`，收集 25 项测试。
证据为 `runs/reaudit-startup-1794761497638/artifacts/checks/startup/report.json`。
真实恢复后的全流程结果为 `unknown`。
缺少恢复任务的实际执行日志。

真实候选的完整科研流程结果为 `unknown`。
缺少真实修复、归因和论文交付的完整报告。
端到端加速为 `unknown`。
缺少同一候选的对照计时。
主容器直接挂载当前 RSI 源码。
研究任务恢复结果为 `unknown`。
缺少重建后的任务恢复日志。
U2、U6、U7、U8、U19 按用户指令人工停止跟进。

全部优化项和风险项见 `NOTES.md`。

系统架构与流程概览见 `docs/figures/rsi-system-overview.png`。
提示词见 `docs/figures/rsi-system-overview.prompt.txt`。
