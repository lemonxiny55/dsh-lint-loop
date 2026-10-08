# dsh-lint-loop — v0.6.0 Quality Loop

**DeepSeek Harness 的变更感知质量闭环。**

> **Fix what the agent broke. Ignore what was already broken. Prove the change is clean.**
>
> 修复 Agent 本轮引入的问题，忽略历史债务，并明确证明本轮变更验证了什么。

普通 lint wrapper 告诉 Agent 仓库哪里有问题；Quality Loop 在首次编辑前捕获基线，编辑后提供 lint delta 与安全修复，准备完成任务时再验证类型和受影响测试。旧 lint/typecheck/test 失败不会被要求顺带清理。每次完成验证生成结构化 Quality Receipt；缺少证据、超时或不支持的检查不会显示 clean。

**v0.6.0 — Quality Loop**。完整参数与限制见 [English README](README.md)。

```sh
dsh plugin --profile web add dsh-lint-loop@0.6.0
```

使用项目已安装的 linter、TypeScript 与测试工具；插件不捆绑这些依赖。

## 两条通道

- **Fast Lane**：现有编辑 → lint delta → 提示反馈；`lint_repair` 最多两轮，修复仅限本轮新增/改变的 lint 问题。
- **Completion Lane**：awaited `agent/turn-stopping` checkpoint 或 `quality_verify`，验证 lint delta、每个 Node package 的 typecheck 与 impacted tests。第一次编辑前进行一次有预算的类型/测试基线扫描，之后保留原始基线。最多两次强制继续，复验保留整轮文件集合。

历史错误被忽略不等于仓库没有错误。只有完整且可比的检查没有新增问题，才能得到 `clean`；无法证明的部分显示 `incomplete`，默认 gate 不会因证据缺失而要求清理历史代码。

## Before / after

```text
编辑前：旧 lint warning、旧 TS2322、旧 migration test 失败
Agent 修改 parser.ts：引入可修复 lint 错误、返回类型错误、parser test 失败

普通 wrapper：旧 lint + 新 lint 混在一起，lint 通过便可能交付
Quality Loop：安全修复新 lint → 检测新类型/测试失败 → 有上限地要求修复
修复后：历史债务仍保留，Receipt 显示本轮 clean 和真实测试范围
```

## 模式

| 模式 | 完成验证 | 总扫描预算 |
|---|---|---|
| `fast` | lint；明确跳过类型/测试，完整质量 verdict 为 incomplete | 60s |
| `balanced`（默认） | lint delta、package typecheck、受影响测试与保守降级 | 60s |
| `strict` | lint delta、package typecheck、仓库 package 测试套件 | 120s |

```yaml
- id: lint-loop
  config:
    mode: balanced
```

原有配置兼容；高级字段覆盖 preset。新增 `completionChecks`、`qualityTimeoutMs`、`qualityMaxFiles`（2000）、`qualityMaxChecks`（32）。Node 22/24 与现有 DSH 0.1/0.2 peer 范围保留。

## 工具与 UI

新增 `quality_verify`（只读完整验证）和 `quality_receipt`（读取最后回执）；保留 `lint_status`、`lint_repair`、`lint_diagnostics`、`lint_workspace_errors`、`lint_fix`。

`quality_verify` / `quality_receipt` 通过普通 DSH 工具结果展示结构化回执。纯 Host 展示适配保留 running / clean / regression / failed、文件数量和三个检查状态。**桌面/Web Quality Bar 延后**：已审计的 DSH 0.2 桌面客户端不消费 Host `presentCall` / `presentResult`，专用界面需要客户端集成。v0.6 不加入客户端 bundle 或 UI hack。自动 gate 保存结果，调用 `quality_receipt` 可读取。

[UI 审计与后续截图说明](docs/quality-bar-demo.md) · [实际桌面回执](docs/release-evidence/v0.6.0/desktop/rc/122-quality_receipt.json)

正常完成、模型报错或取消任务都会清理本轮基线和修复预算，取消未完成检查，保留最后一份回执。下一轮重新捕获基线，避免限流中断后混入上一轮记录。补分号不会把同一个类型错误重复计入修复数量。

## Impacted tests 与安全

第一版支持本地 Vitest 与 Jest JSON reporter。跟踪传递的相对 import/re-export、`.js` → `.ts` 和直接修改的测试。不能证明测试关系时跑 package；动态依赖、workspace alias、配置/fixture/setup 或自定义发现规则变化时扩大到仓库 packages。预算不足仍显示 incomplete。node:test、自定义命令链、非 Node 框架和 TypeScript project-reference build 暂不自动证明。

Typecheck 用文件 + TS code + message 多重集比较，忽略行号漂移；测试用 suite + fullName + failure signature 比较，旧失败症状改变也算新 regression。Receipt 包含实际命令、执行测试、基线、债务、自动/Agent 修复、轮次与耗时。

eslint/biome/ruff 的文件修复跳过历史可修复债务，验证失败或产生新 lint 时回滚。自动 Go/Rust package/crate fixer 因可能修改邻居/manifest/lockfile 而跳过；诊断和显式独立 fixer API 保留。已有 baseline 的 `lint_fix` 也遵守 regression-only；无 baseline 的独立调用保持旧的显式清理用法。

## 边界与限制

仅归因成功 DSH edit/write 与兼容 fs-intent；shell/custom-tool 编辑、删除与并发外部修改不保证完整归因。Flaky tests 可能形成 regression；检查本身可能有副作用。没有 LLM review、需求管理、安全扫描、coverage/CI 平台，也不强依赖其他插件。

`dsh-doublecheck` 管交付纪律和需求；`dsh-test-runner` 管通用测试执行；`dsh-review-loop` 管人的增量 diff review；本插件证明 **本轮 Agent 变更没有引入新的质量问题**。

[架构审计](docs/quality-loop-design.md) · [候选版本验证记录](docs/release-evidence/v0.6.0/verification.md)

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

[MIT License](LICENSE)
