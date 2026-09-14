# dsh-lint-loop

[![npm version](https://img.shields.io/npm/v/dsh-lint-loop)](https://www.npmjs.com/package/dsh-lint-loop)
[![CI](https://github.com/lemonxiny55/dsh-lint-loop/actions/workflows/ci.yml/badge.svg)](https://github.com/lemonxiny55/dsh-lint-loop/actions/workflows/ci.yml)
[![Discussions](https://img.shields.io/github/discussions/lemonxiny55/dsh-lint-loop)](https://github.com/lemonxiny55/dsh-lint-loop/discussions)

[English](README.md) | 中文

**在用?** 告诉我们哪里顺手、哪里出问题——[点个 Star](https://github.com/lemonxiny55/dsh-lint-loop)、[提问](https://github.com/lemonxiny55/dsh-lint-loop/discussions/categories/q-a)、[求支持新 linter](https://github.com/lemonxiny55/dsh-lint-loop/discussions/categories/ideas),或[提 issue](https://github.com/lemonxiny55/dsh-lint-loop/issues/new/choose)。反馈会直接影响路线图。

零配置 lint 反馈闭环 —— 一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh`)插件,打通 **编辑 → lint → 修复** 的回路:模型编辑文件后,立刻看到 lint 发现(规则、file:line:col、消息、能否自动修),再一个 `lint_fix` 调用即可自动修复。使用仓库里已有的 linter——eslint、biome、ruff、golangci-lint 或 cargo clippy。零配置,不捆绑任何 linter。

## 模型得到什么

| 工具 | 用途 |
|---|---|
| `lint_diagnostics` | 单文件(或所有已见文件)的 lint 发现:规则、`file:line:col`、消息、`fixable` 布尔;支持 severity 过滤与 `max` 截断。参数 `file_path`(别名 `file`)。**编辑完文件立刻调用。** |
| `lint_workspace_errors` | 本会话已 lint 文件的全部 error——"现在什么坏了"总览。 |
| `lint_fix` | **杀手锏** —— 对单文件跑仓库自己的自动修复(`eslint --fix` / `biome check --write` / `ruff check --fix` / `golangci-lint run --fix` / `cargo clippy --fix`),然后复检,返回变更行数摘要(+增/-删)、剩余发现、所用 linter。参数 `file_path`(别名 `file`)。只在工作区根内操作。 |

外加一个可选的**自动注入 system prompt section**(`lint:findings`,order 75——紧跟 `lsp:diagnostics` 之后):模型通过 harness 写/改文件后,插件订阅 `fs/observed` 事件,用自己的串行池 lint 该文件,只注入这次编辑**新增/变化**的发现——**默认只注入 error**(`sectionSeverity` 可调),最多 top 5 行,绝不灌全仓库。过期增量自动失效(`sectionTtlMs`,默认 30s)。渲染的发现带**源码代码帧**(问题行用 `█` 标出,附一行上下文),模型无需回读文件即可修改。而**完成门禁**(见下)会阻止"文件里还有错误却收工"。

## 完成门禁(0.2)

"编辑 → lint → 修复"只有真正改完才算闭环。在 harness 的 `agent/turn-stopping` 接缝——回合关闭**之前**的串行检查点——插件检查本轮编辑过的文件;若仍有 error,就**steer 模型再走一步**(附上精确发现),而不是让它收工:

```
lint: this turn cannot finish cleanly — 2 errors remain in file you edited.
# lint findings (2 errors)
src/a.ts:3:10  error  no-unused-vars  'x' is defined but never used
src/a.ts:7:5   error  eqeqeq          Expected '===' and instead saw '=='.
(fix them (lint_fix repairs what it can), then finish — this nudge is capped per turn)
```

它刻意是**自我限流**的——官方 Claude Code 桥对此留了明确的 TODO,而本门禁内建了保护:

- 每个文件每次收尾只评估**一次**(重新编辑会重新触发,但不会卡在同一批旧发现上死循环);
- 每轮最多强制 **`gateMaxSteers` 次续跑**(默认 `2`),之后放行;
- 只考虑**本轮模型自己碰过的文件**——未触及文件里的历史错误不会阻塞;
- `gate: false` 彻底关闭;`autoInject: false` 时除非显式 `gate: true` 否则也关闭。

门禁不是硬否决,只是有界的一脚——因此永远不会卡死会话。

## 闭环

```
模型编辑文件  ──►  dsh 写入(fs 工具)
                    │
                    ▼ fs/observed 事件
        插件用仓库自己的 linter lint 该文件
                    │
                    ▼ 只推新增/变化的发现(默认 error)
        delta 注入 prompt(或按需调 lint_diagnostics)
                    │
                    ▼
        模型读到 "src/a.ts:12 no-unused-vars …"  ──►  lint_fix ──►  清零
                    │
                    ▼ 回合即将关闭
        门禁:编辑过的文件还有 error? ── steer 再走一步(有上限)
```

## 零配置

插件探测 repo root 已有的配置,按扩展名路由:

| 探测到的配置 | Linter | 文件类型 |
|---|---|---|
| `eslint.config.{js,mjs,cjs,ts}` 或 `.eslintrc.{js,cjs,json,yml}` | eslint | `.ts .tsx .mts .cts .js .jsx .mjs .cjs` |
| `biome.json` / `biome.jsonc` | biome | 同上 JS 系列 |
| `ruff.toml` / `.ruff.toml` / `pyproject.toml` 含 `[tool.ruff]` | ruff | `.py .pyi` |
| `.golangci.yml` / `.golangci.yaml` / `.golangci.toml` / `.golangci.json` | golangci-lint | `.go` |
| `Cargo.toml` | cargo clippy | `.rs` |

- **多配置并存?** JS 系列默认走 eslint;仅当存在 biome 配置且**没有** eslint 配置时才走 biome。可用 `linters` 配置键强制指定。
- **仓库本地安装直接可用**:`npm i -D eslint` 装进 `node_modules/.bin` 的二进制,插件会先于 `PATH` 解析。
- **什么都没配?** 插件保持安静;调用工具会返回初始化提示(`npx eslint --init` / `biome init` / ruff / 一个 `.golangci.yml` / 一个 `Cargo.toml`),而不是报错。
- **配置文件变更**(比如会话中途加了 `biome.json`)会被观察到并自动重新探测。

示例(输入 → 输出):

```
lint_diagnostics { file_path: "src/extract.ts" }
# lint findings (1 error, 1 warning)
src/extract.ts:12:3   error  no-unused-vars  'foo' is defined but never used
  11 | export function extract(input: string) {
  12 |   const foo = parse(input)  █
  13 |   return input
src/store.ts:8:5      warn   semi            missing semicolon  [fixable]
```

`execute` 返回的是 canonical JSON(rule、file、line、col、severity、message、fixable、linter);上面这张紧凑表格 + 代码帧是渲染视图。`file_path` 与 harness 原生 fs 工具一致,`file` 别名同样可用。修复:

```
lint_fix { file_path: "src/store.ts" }
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
| `sectionSeverity` | `error` | 注入 section 报告的严重级别(`error`/`warning`/`info`)——默认把 warning 挡在 prompt 外 |
| `settleMs` | `600` | 最后一次编辑后重新 lint 的静默期(最小 100) |
| `timeoutMs` | `10000` | 单次 linter 进程超时(最小 1000);超时进程被杀掉并明确上报 |
| `gate` | `true` | 完成门禁:编辑过的文件仍有 error 时阻止回合收尾 |
| `gateMaxSteers` | `2` | 每轮最多强制续跑次数,超过则放行(最小 0) |
| `gateSeverity` | `error` | 完成门禁执行的严重级别 |
| `codeFrames` | `true` | 为渲染的发现附源码代码帧 |
| `frameLines` | `1` | 代码帧上下各带几行上下文 |
| `frameLimit` | `5` | 最多为几条发现附代码帧(token 护栏) |

## 支持的 linter

- **eslint**(`--no-warn-ignored -f json`):flat config 与旧版 `.eslintrc` 均可;不认 `--no-warn-ignored` 的老版本(< 8.22)自动去掉该 flag 重试,按仓库记忆。
- **biome**(`check --reporter=json`):兼容 ≥ 2 的 reporter 形态(1-based line/column、CLI 相对路径字符串)与旧版字节偏移 `span` 形态;`format`/`organizeImports` 的 diff **不算** finding。
- **ruff**(`check --output-format=json`):1-based 位置;有 `fix` 即 `fixable: true`;所有违规都是 error(ruff 没有严重级别)。
- **golangci-lint**(`run --output.json.path=stdout`,自动回退到 v1 的 `--out-format=json`):包级作用域——分析文件所在目录,发现按各自文件分发;`Severity` 为空视为 `error`;`SuggestedFixes`(v1.64+/v2)或旧版 `Replacement` 标记 `fixable`。
- **cargo clippy**(`clippy --message-format=json`):crate 级作用域——在最近的 `Cargo.toml` 目录中运行;NDJSON 的 `compiler-message` 行转为发现(`clippy::*` / `E####` 编码),子 span 的建议标记 `fixable`。它会先做 crate 类型检查,冷启动很慢(超时下限 120s;`golangci-lint` 60s)。

`linters.ts` + `parse.ts` 仍是新 linter 的接入缝(命令、参数、JSON 形态、安装提示)。

## 工作原理

- **探测**(`src/detect.ts`):按 repo root 探测配置文件,带缓存;观察事件携带 linter 配置文件名(`biome.json`、`pyproject.toml`、…)时失效重探。`pyproject.toml` 只有真的含 `[tool.ruff]` 才算 ruff。
- **Runner 池**(`src/runner.ts`):每 (root, linter) 一条串行车道——保存风暴只会排队,不会并发开 N 个 linter;每次运行一次性 spawn,stdout/stderr 封顶,`timeoutMs` 到点杀掉(SIGTERM → SIGKILL 宽限)。
- **发现存储**(`src/manager.ts`):每 root 一个 manager,保存每文件最近一次 lint 结果(512 文件软上限);`lint_fix` 修复前后各读一次文件,汇总行级 diff,再复检拿到权威的剩余集合。包级运行的结果会**分发**——发现落到各自上报的文件下,`lint_diagnostics { file }` 仍然只回答该文件。
- **编辑检测**(`src/section.ts`):`fs/observed` 监听只入队文件(同步、绝不抛异常);`settleMs` 防抖刷新后 lint 并与该文件的先前状态做差——只有配置级别的新增/变化发现进入 prompt,最多 top 5。
- **代码帧**(`src/frames.ts`):lint 运行时缓存源码行,为前 `frameLimit` 条渲染的发现附上问题行标记 `█` 的上下文;渲染路径保持同步,缓存冷时(回放)优雅降级为不带帧。
- **完成门禁**(`src/gate.ts`):本轮观察到的文件在 `agent/turn-stopping` 时重新 lint;残留 error 触发有界的 `agent.steer`(每轮 ≤ `gateMaxSteers`),随附发现。
- **工作区解析**:会话 cwd → 向上找最近 `.git`(有界),与 dsh-code-index 一致;仓库外的文件一律拒绝。
- **Token 成本意识**:每个面——工具输出与注入 section——都受 `maxFindings` 约束(section 为 top 5);注入的是单次编辑的 delta,不是全仓库。

## 与 dsh-lsp-diagnostics 的关系

两个插件**互补共存**:`dsh-lsp-diagnostics` 通过语言服务器覆盖编译器/类型错误(section order 70),本插件通过仓库的 linter 覆盖风格/lint 发现(order 75)。这边不启 LSP,那边不捆绑 linter——职责清晰,零重叠。

## 已知限制

- `lint_workspace_errors` 覆盖**本会话** lint 过的文件(首次被 `lint_diagnostics` 检查即入集)——不是全仓库批量扫描。
- Biome 的 JSON reporter 不暴露可修复性——biome 发现的 `fixable` 恒为 `false`,但 `lint_fix` 仍会跑 `biome check --write` 并如实报告改动。
- Ruff 没有严重级别——所有 ruff 发现都以 `error` 呈现。
- 包级 linter(`golangci-lint`、`cargo clippy`)分析的是包/crate 而非单文件:一次运行覆盖该包里所有被改文件,发现归到各自文件,只对传给 `lint_fix` 的那个文件做 diff。`cargo clippy` 先做 crate 类型检查,首次运行可能远超 120s 下限。
- 自动注入由 harness 文件事件触发;用户在带外直接改文件(不经 harness)不会被观察到,直到下次调用工具。
- linter 需已安装(先解析仓库本地 `node_modules/.bin`,再 `PATH`,再 `linterPath`);刻意不捆绑。
- 完成门禁是有界 nudge 而非硬阻断:每轮最多强制 `gateMaxSteers` 次续跑后放行,不会卡死会话。
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

- **问题、安装、用法** → [Discussions › Q&A](https://github.com/lemonxiny55/dsh-lint-loop/discussions/categories/q-a)
- **想法、希望支持的 linter、闭环工作流** → [Discussions › Ideas](https://github.com/lemonxiny55/dsh-lint-loop/discussions/categories/ideas)
- **使用姿势与晒图** → [Discussions › Show and tell](https://github.com/lemonxiny55/dsh-lint-loop/discussions/categories/show-and-tell)
- **可复现的 bug** → [提 issue](https://github.com/lemonxiny55/dsh-lint-loop/issues/new/choose)

如果 `dsh-lint-loop` 帮你省掉了一轮修复,点个 Star 能让更多 dsh 用户发现它。

## 许可

MIT。与 DeepSeek 无隶属关系;构建于 `dsh` 公开插件接口之上。
