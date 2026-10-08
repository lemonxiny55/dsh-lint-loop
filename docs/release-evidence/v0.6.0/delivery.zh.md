# v0.6.0 — Quality Loop 交付报告

此报告保留发布前候选版本的验收状态。后续正式发布和远程 CI 结果见
[v0.6.0 Release](https://github.com/lemonxiny55/dsh-lint-loop/releases/tag/v0.6.0)。

2026-10-08。状态：**RELEASE CANDIDATE READY**。停止在本地候选版本，没有提交、推送、npm publish 或 GitHub Release。

1. **实现完成情况**：Fast Lane 保留编辑后的 lint delta 和安全修复；Completion Lane 在完成检查点验证 lint delta、typecheck 和 impacted tests。历史问题只记录，不强制清理。默认最多两次自动修复轮和两次强制续轮，超限仍记录 regression。

2. **架构变化**：保留已测试的 lint manager / baseline / repair 底座，新增 quality-plan、quality-checks、quality、quality-view。分别负责发现与选择、进程证据、基线与回执、可选 Host 展示。Gate 保留整个任务轮的改动范围；durable turn/end 覆盖正常结束、错误和取消，取消并隔离未完成检查，保留最终回执。

3. **工具、配置、UI**：新增 quality_verify、quality_receipt，保留原五个 lint 工具。新增 fast / balanced / strict，默认 balanced，高级配置可以覆盖。桌面/Web Quality Bar 明确延后：实际 DSH 客户端不消费 Host presentCall/presentResult；保留纯 Host 适配与普通结构化工具输出，不引入客户端 bundle 或脆弱 hack，不提供冒充实机的截图/GIF。

4. **Impacted Tests**：可靠适配常见本地 Vitest/Jest 脚本，跟踪相对 import/re-export 的反向传递依赖、直接变化的测试和 .js→.ts 解析；monorepo 按 package cwd 执行。无可靠边缘时回退 package suite，不明确的依赖、配置等回退 repository package suites。缺失工具、自定义脚本、超出预算等保持 incomplete。首次编辑前的基线可能运行完整 package suites，后续完成验证只运行确定影响的测试。ImpactProvider 是未来 code-index 集成点，无强依赖。

5. **Regression-aware 语义**：lint 使用既有源码感知 matcher；类型问题按文件、TS code、信息和源码上下文进行 multiset 比较，忽略行号移动、空白与末尾分号；测试比较文件、完整测试名和失败签名。原失败测试出现新症状也算新增问题。删除/跳过测试、缺失基线、超时和无法解析的输出都不能证明修复。安全修复不扩展文件范围，不修改历史 fixable debt；Go/Rust 包级自动修复在无法保证邻居安全时跳过。

6. **实际 Quality Receipt**：完整桌面验收记录 changedFiles 仅 src/a.js，选择 tests/a.test.js，新增问题 0、历史债务 3、autoFixed 1、agentFixed 2、repairRounds 1。当前检查均 complete，最终 lint/typecheck/tests 与 finalVerdict 均 clean，最后一次验证耗时 965ms。完整字段、执行命令、baseline 和当前证据见 [真实回执](desktop/rc/122-quality_receipt.json)。

```json
{
  "schemaVersion": 1,
  "mode": "balanced",
  "changedFiles": ["src/a.js"],
  "lint": "clean",
  "typecheck": "clean",
  "tests": "clean",
  "repairRounds": 1,
  "elapsedMs": 965,
  "finalVerdict": "clean"
}
```

上面为真实回执的字段摘录。clean 表示已执行范围内没有新增 regression，不表示整个仓库没有旧问题。

7. **完整测试结果**：162/162，14 个测试文件；完整运行无跳过/禁用。覆盖历史债务、新 regression、安全 autofix/rollback、selection/fallback、类型问题、预算、取消/超时、monorepo、回执、presets、dispose/remount 与 Windows shell/path。真实 TypeScript/Vitest 集成通过。修复前的定向测试会失败，修复后完整套件通过。实机自动 gate 在未主动调用 quality_verify 时检测新测试失败，触发一次续轮，Agent 修复后正常结束；[最终 checkpoint 回执](desktop/gate/95-quality_receipt.json)保留旧债务 3、agentFixed 1、continuationRounds 1。

8. **Node 22 / 24**：22.23.3 和 24.19.0 均通过 frozen install、typecheck、完整 tests、build，ESM 125.60 KB；两条 DSH tools 运行时 smoke 及隔离 0.2 声明检查也通过。实机 Electron 44.0.0 内嵌 Node 24.18.1 验收通过。临时 Node 22 已删除，系统 Node 24 未改动。[完整验证与日志](verification.md)。

9. **文档与增长**：README 首屏和 before/after demo 强调 “Fix what the agent broke. Ignore what was already broken. Prove the change is clean.”；中文 README、CHANGELOG、架构审计和 UI 延后说明已更新。GitHub repository description 和 11 个 topics 已保存并回读，有实际截图。根 lockfile、PR #3 修复的 DSH peer 兼容范围均保持。

10. **已知限制**：静态选择不是完整语言索引；shell/custom edits、删除和外部并发写入没有完整归因。基线套件可能有副作用，flaky tests 可能表现为 regression。node:test、自定义/chained scripts、TypeScript project reference builds 和缺失工具不冒充已验证。实际 Jest 集成未运行，adapter/report/参数有测试；Linux 本地未运行，CI 已配置 Windows/Linux×22/24。专用 Quality Bar 与素材延期。此前自定义 fixture wrapper 的输出差异未声称得到完全解释；正式安装包的实机路径已验证。没有修复系统 ACL 或更改 Windows 权限。

11. **同类定位差异**：dsh-lint-loop 证明本轮改动没有引入 lint/type/test 回归；dsh-doublecheck 侧重需求与交付纪律/审查；dsh-test-runner 侧重一般测试执行与失败总结；dsh-review-loop 侧重人工增量 diff 审阅和检查点。本插件不做 LLM review、需求管理、security/coverage 平台或 CI，也不要求安装其他插件。

12. **RC 判定**：核心质量闭环和实机工具、自动 gate 验收通过，达到 RELEASE CANDIDATE READY。UI 延后遵守原始需求允许的范围收缩。最终 dry-run 包检查通过，没有发布；修改保留在当前工作区供审阅。

**补充 GUI 验收**：随后用 Computer Use 在真实 DSH 窗口点击新建会话、输入任务并发送，Agent 完成 read/edit/quality_verify/quality_receipt，正常结束。三项检查 complete/clean，新增问题 0、历史债务 3，仅选择 tests/a.test.js；两个工具回执一致，验证耗时 1007ms。已展开普通工具输出，点击“查看”进入原生轨迹事件详情，在“结果”页展开 selection。真实截图保留本地，回执与完成证据见 [GUI 验收](desktop/gui/README.md)。专用 Quality Bar 仍延期；本次未覆盖全新安装、禁用/启用流程。隔离 fixture 的测试空行已在证据保存后恢复，未作为 Agent 修复计数。
