# 当前交付记录

## 代码流程

实施生成候选 commit。
补丁保护限制修改范围和基线独立测试。
模块核查读取完整变更源码、入口和独立测试。
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
日志为 `/tmp/rsi-typecheck-final.log`。
快速回归执行 157 项，157 项通过，0 项失败。
耗时为 14.729877916 秒。
日志为 `/tmp/rsi-fast-tests-final.log`。
完整回归执行 172 项，172 项通过，0 项失败。
耗时为 352.510332292 秒。
日志为 `/tmp/rsi-full-tests-final.log`。
完整回归启动后仍有恢复和缓存修改。
最终定向回归覆盖这些修改。
定向回归执行 63 项，63 项通过，0 项失败。
耗时为 13.564119917 秒。
日志为 `/tmp/rsi-final-targeted.log`。

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
主容器调用 `checkWorkerReady` 输出 `protocol=2` 和 `ready=true`。
该协议检查退出码为 0。
容器重建会中断原容器进程。

## 剩余验证

远端入口执行结果为 `unknown`。
缺少本次修改后的实机报告。
端到端加速为 `unknown`。
缺少同一候选的对照计时。
主容器直接挂载当前 RSI 源码。
研究任务恢复结果为 `unknown`。
缺少重建后的任务恢复日志。
U2、U6、U7、U8、U19 按用户指令人工停止跟进。

全部优化项和风险项见 `NOTES.md`。
