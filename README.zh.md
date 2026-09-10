# dsh-lint-loop

[![npm version](https://img.shields.io/npm/v/dsh-lint-loop)](https://www.npmjs.com/package/dsh-lint-loop)
[![CI](https://github.com/lemonxiny55/dsh-lint-loop/actions/workflows/ci.yml/badge.svg)](https://github.com/lemonxiny55/dsh-lint-loop/actions/workflows/ci.yml)

[English](README.md) | 中文

零配置 lint 反馈闭环 —— 一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh`)插件,打通 **编辑 → lint → 修复** 的回路:模型编辑文件后,立刻看到 lint 发现(规则、file:line:col、消息、能否自动修),再一个 `lint_fix` 调用即可自动修复。使用仓库里已有的 linter——eslint、biome 或 ruff。零配置,不捆绑任何 linter。

## 模型得到什么

| 工具 | 用途 |
|---|---|
| `lint_diagnostics` | 单文件(或所有已见文件)的 lint 发现:规则、`file:line:col`、消息、`fixable` 布尔;支持 severity 过滤与 `max` 截断。**编辑完文件立刻调用。** |
| `lint_workspace_errors` | 本会话已 lint 文件的全部 error——"现在什么坏了"总览。 |
| `lint_fix` | **杀手锏** —— 对单文件跑仓库自己的自动修复(`eslint --fix` / `biome check --write` / `ruff check --fix`),然后复检,返回变更行数摘要(+增/-删)、剩余发现、所用 linter。只在工作区根内操作。 |

外加一个可选的**自动注入 system prompt section**(`lint:findings`,order 75——紧跟 `lsp:diagnostics` 之后):模型通过 harness 写/改文件后,插件订阅 `fs/observed` 事件,用自己的串行池 lint 该文件,只注入这次编辑**新增/变化**的发现——最多 top 5 行加计数,绝不灌全仓库。过期增量自动失效(`sectionTtlMs`,默认 30s)。设 `autoInject: false` 可关闭,只留工具。

## 闭环

```
模型编辑文件  ──►  dsh 写入(fs 工具)
                    │
                    ▼ fs/observed 事件
        插件用仓库自己的 linter lint 该文件
                    │
                    ▼ 只推新增/变化的发现
        delta 注入 prompt(或按需调 lint_diagnostics)
                    │
                    ▼
        模型读到 "src/a.ts:12 no-unused-vars …"  ──►  lint_fix ──►  清零
```

## 零配置

插件探测 repo root 已有的配置,按扩展名路由:

| 探测到的配置 | Linter | 文件类型 |
|---|---|---|
| `eslint.config.{js,mjs,cjs,ts}` 或 `.eslintrc.{js,cjs,json,yml}` | eslint | `.ts .tsx .mts .cts .js .jsx .mjs .cjs` |
| `biome.json` / `biome.jsonc` | biome | 同上 JS 系列 |
| `ruff.toml` / `.ruff.toml` / `pyproject.toml` 含 `[tool.ruff]` | ruff | `.py .pyi` |

- **多配置并存?** JS 系列默认走 eslint;仅当存在 biome 配置且**没有** eslint 配置时才走 biome。可用 `linters` 配置键强制指定。
- **仓库本地安装直接可用**:`npm i -D eslint` 装进 `node_modules/.bin` 的二进制,插件会先于 `PATH` 解析。
- **什么都没配?** 插件保持安静;调用工具会返回初始化提示(`npx eslint --init` / `biome init` / ruff),而不是报错。
- **配置文件变更**(比如会话中途加了 `biome.json`)会被观察到并自动重新探测。

示例(输入 → 输出):

```
lint_diagnostics { file: "src/extract.ts" }
# lint findings (1 error, 1 warning)
src/extract.ts:12:3   error  no-unused-vars  'foo' is defined but never used
src/store.ts:8:5      warn   semi            missing semicolon  [fixable]
```

`execute` 返回的是 canonical JSON(rule、file、line、col、severity、message、fixable、linter);上面这张紧凑表格是渲染视图。修复:

```
lint_fix { file: "src/store.ts" }
# lint_fix (eslint) — src/store.ts
fixed: yes (+0/-1 lines)
remaining: none — file is clean
```

## 安装

需要 `dsh`(npx、npm 或源码安装均可)与 Node ≥ 22。linter 本身**不捆绑**——插件用仓库里已有的。

```sh
# 从 npm(预构建)
npx @deepseek-ai/dsh plugin --profile web add dsh-lint-loop

# 或从本仓库 checkout 目录
npx @deepseek-ai/dsh plugin --profile web add ./dsh-lint-loop
```

重启 Web UI(`npx @deepseek-ai/dsh web`)——启动日志确认每个工具:

```
[dsh-lint-loop] plugin loaded
[dsh-lint-loop] registered tool: lint_diagnostics
...
```

linter 缺失?工具会给出确切安装命令:`linter "eslint" is not installed or failed to run. Install it with: npm i -D eslint`。

## 使用

在工作区会话里对 agent 说:

- "改一下 `src/extract.ts`,然后用 lint_diagnostics 检查。" —— section 可能已经把发现推过来了。
- "把 src/store.ts 里能自动修的 lint 问题都修掉。"(`lint_fix`)
- "现在有哪些 lint 错误?"(`lint_workspace_errors`)

## 配置

通过 profile patch 里插件行的 `config` 传入(缺省用默认值):

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml —— 裸行按 id 覆盖。
- id: lint-loop
  config:
    maxFindings: 30
    linters: [eslint, ruff]   # 强制指定;否则自动探测
```

| 键 | 默认 | 含义 |
|---|---|---|
| `autoInject` | `true` | 注册自动注入的发现 section(及 `fs/observed` 监听) |
| `maxFindings` | `50` | 工具输出与注入 section 的发现硬上限(token 成本护栏) |
| `linters` | `[]`(自动) | 强制可用的 linter 集合(`eslint` / `biome` / `ruff`);未知键告警 |
| `linterPath` | `{}` | 按 linter 的二进制覆盖(`{eslint: …, biome: …, ruff: …}`);`.js/.mjs/.cjs` 结尾的路径用当前 Node 直跑 |
| `sectionTtlMs` | `30000` | 注入 delta 的保鲜时长(最小 1000) |
| `timeoutMs` | `10000` | 单次 linter 进程超时(最小 1000);超时进程被杀掉并明确上报 |

## 支持的 linter

- **eslint**(`--no-warn-ignored -f json`):flat config 与旧版 `.eslintrc` 均可;不认 `--no-warn-ignored` 的老版本(< 8.22)自动去掉该 flag 重试,按仓库记忆。
- **biome**(`check --reporter=json`):兼容 ≥ 2 的 reporter 形态(1-based line/column、CLI 相对路径字符串)与旧版字节偏移 `span` 形态;`format`/`organizeImports` 的 diff **不算** finding。
- **ruff**(`check --output-format=json`):1-based 位置;有 `fix` 即 `fixable: true`;所有违规都是 error(ruff 没有严重级别)。

Rust(`clippy`)、Go(`golangci-lint`)等刻意延后——`linters.ts` + `parse.ts` 就是新 linter 的接入缝(命令、参数、JSON 形态、安装提示)。

## 工作原理

- **探测**(`src/detect.ts`):按 repo root 探测配置文件,带缓存;观察事件携带 linter 配置文件名(`biome.json`、`pyproject.toml`、…)时失效重探。`pyproject.toml` 只有真的含 `[tool.ruff]` 才算 ruff。
- **Runner 池**(`src/runner.ts`):每 (root, linter) 一条串行车道——保存风暴只会排队,不会并发开 N 个 linter;每次运行一次性 spawn,stdout/stderr 封顶,`timeoutMs` 到点杀掉(SIGTERM → SIGKILL 宽限)。
- **发现存储**(`src/manager.ts`):每 root 一个 manager,保存每文件最近一次 lint 结果(512 文件软上限);`lint_fix` 修复前后各读一次文件,汇总行级 diff,再复检拿到权威的剩余集合。
- **编辑检测**(`src/section.ts`):`fs/observed` 监听只入队文件(同步、绝不抛异常);防抖刷新后 lint 并与该文件的先前状态做差——只有新增/变化的发现进入 prompt,最多 top 5。
- **工作区解析**:会话 cwd → 向上找最近 `.git`(有界),与 dsh-code-index 一致;仓库外的文件一律拒绝。
- **Token 成本意识**:每个面——工具输出与注入 section——都受 `maxFindings` 约束(section 为 top 5);注入的是单次编辑的 delta,不是全仓库。

## 与 dsh-lsp-diagnostics 的关系

两个插件**互补共存**:`dsh-lsp-diagnostics` 通过语言服务器覆盖编译器/类型错误(section order 70),本插件通过仓库的 linter 覆盖风格/lint 发现(order 75)。这边不启 LSP,那边不捆绑 linter——职责清晰,零重叠。

## 已知限制

- `lint_workspace_errors` 覆盖**本会话** lint 过的文件(首次被 `lint_diagnostics` 检查即入集)——不是全仓库批量扫描。
- Biome 的 JSON reporter 不暴露可修复性——biome 发现的 `fixable` 恒为 `false`,但 `lint_fix` 仍会跑 `biome check --write` 并如实报告改动。
- Ruff 没有严重级别——所有 ruff 发现都以 `error` 呈现。
- 自动注入由 harness 文件事件触发;用户在带外直接改文件(不经 harness)不会被观察到,直到下次调用工具。
- linter 需已安装(先解析仓库本地 `node_modules/.bin`,再 `PATH`,再 `linterPath`);刻意不捆绑。
- 开发者预览版 harness:上游 API 随时可能破坏性变更。

## 开发

```sh
pnpm install
pnpm test        # vitest —— 对标记驱动的 fake linter 覆盖探测/路由/解析器/工具/修复/生命周期
pnpm typecheck
pnpm build       # tsup → dist/index.js(ESM,外部依赖)

# 在真实仓库上探测真实 linter(任何装了 eslint/biome/ruff 的 checkout)
node scripts/probe-linter.mjs /path/to/repo src/someFile.ts
```

测试跑在 `tests/helpers/fakeLinter.mjs` 上——一个标记驱动的 fake(`// lint: <severity> <rule> <message>`),按真实 linter 的 JSON 形态输出(eslint 数组、biome 1-based start/end 或字节偏移 span 的 diagnostics、ruff 数组),并通过剥离 `[fixable]` 标记注释模拟自动修复——CI 无需真实 linter。真实 eslint 10 / biome 2.5 / ruff 0.16 的输出形态已通过 `scripts/probe-linter.mjs` 捕获并做了回归测试。

## 反馈

发现 bug,或想接下一个 linter?请[提 issue](https://github.com/lemonxiny55/dsh-lint-loop/issues)。

## 许可

MIT。与 DeepSeek 无隶属关系;构建于 `dsh` 公开插件接口之上。
