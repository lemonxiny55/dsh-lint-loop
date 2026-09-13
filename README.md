# dsh-lint-loop

[![npm version](https://img.shields.io/npm/v/dsh-lint-loop)](https://www.npmjs.com/package/dsh-lint-loop)
[![CI](https://github.com/lemonxiny55/dsh-lint-loop/actions/workflows/ci.yml/badge.svg)](https://github.com/lemonxiny55/dsh-lint-loop/actions/workflows/ci.yml)
[![Discussions](https://img.shields.io/github/discussions/lemonxiny55/dsh-lint-loop)](https://github.com/lemonxiny55/dsh-lint-loop/discussions)

English | [中文](README.zh.md)

**Using it?** Tell us what works and what breaks — [star the repo](https://github.com/lemonxiny55/dsh-lint-loop), [open a discussion](https://github.com/lemonxiny55/dsh-lint-loop/discussions), or [file an issue](https://github.com/lemonxiny55/dsh-lint-loop/issues/new/choose). Feedback directly shapes the roadmap.

Zero-config lint feedback loop — a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin that closes the **edit → lint → fix** loop: the model edits a file, immediately sees the lint findings (rule, file:line:col, message, fixable), and can auto-repair them with one `lint_fix` call. Uses whatever the repo already has — eslint, biome, or ruff. No setup, no bundled linters.

## What the model gets

| Tool | Purpose |
|---|---|
| `lint_diagnostics` | Lint findings for one file (or all files the linters have seen), with rule, `file:line:col`, message, and a `fixable` flag; severity filter and `max` cap. Takes `file_path` (alias `file`). **Call right after editing a file.** |
| `lint_workspace_errors` | All errors across files linted this session — the "what is broken right now" view. |
| `lint_fix` | **The killer feature** — runs the repo's own auto-fixer (`eslint --fix` / `biome check --write` / `ruff check --fix`) on ONE file, re-lints, and returns what changed (+added/-removed lines), remaining findings, and the linter used. Takes `file_path` (alias `file`). Workspace-root files only. |

Plus an optional **auto-injected system prompt section** (`lint:findings`, order 75 — right after `lsp:diagnostics`): after the model writes/edits a file through the harness, the plugin subscribes to the `fs/observed` event, lints the file through its serial pool, and injects only the **new/changed findings introduced by that edit** — **errors only by default** (set `sectionSeverity` for more), top 5 lines, never the whole workspace. Stale deltas expire (`sectionTtlMs`, default 30s). Rendered findings carry a **source code frame** (the offending line marked `█`, plus a line of context) so the model fixes without re-reading the file. And the **completion gate** (below) stops the turn from closing while edited files still have errors.

## The completion gate (0.2)

Edit → lint → fix is only closed if the model actually fixes what it broke. On the harness `agent/turn-stopping` seam — a serial checkpoint *before* the turn closes — the plugin checks the files edited during this turn. If any still carry errors, it **steers the agent for another step** with the exact findings, instead of letting it finish:

```
lint: this turn cannot finish cleanly — 2 errors remain in file you edited.
# lint findings (2 errors)
src/a.ts:3:10  error  no-unused-vars  'x' is defined but never used
src/a.ts:7:5   error  eqeqeq          Expected '===' and instead saw '=='.
(fix them (lint_fix repairs what it can), then finish — this nudge is capped per turn)
```

It is deliberately **self-limiting** — the first-party Claude Code bridge has an explicit TODO for a loop guard, and this gate has one built in:

- each file is evaluated **once per stopping** (re-editing re-arms it, finishing does not loop on a stale set);
- each turn forces at most **`gateMaxSteers` continuations** (default `2`), then admits the turn;
- only files **the model itself touched this turn** are considered — pre-existing errors in untouched files never block;
- `gate: false` disables it entirely; `autoInject: false` also disables it unless `gate: true` is set explicitly.

Nothing about the gate is a hard veto — it is a bounded nudge, so it can never wedge a session.

## The loop

```
model edits file  ──►  dsh writes it (fs tool)
                        │
                        ▼ fs/observed event
        plugin lints the file with the repo's own linter
                        │
                        ▼ new/changed findings only (errors by default)
        delta injected into the prompt (or lint_diagnostics on demand)
                        │
                        ▼
        model reads "src/a.ts:12 no-unused-vars …"  ──►  lint_fix ──►  clean
                        │
                        ▼ turn about to close
        gate: errors still in edited files? ── steer one more step (capped)
```

## Zero configuration

The plugin probes the repo root for what is already there and routes by extension:

| Config found | Linter | Files |
|---|---|---|
| `eslint.config.{js,mjs,cjs,ts}` or `.eslintrc.{js,cjs,json,yml}` | eslint | `.ts .tsx .mts .cts .js .jsx .mjs .cjs` |
| `biome.json` / `biome.jsonc` | biome | same JS family |
| `ruff.toml` / `.ruff.toml` / `pyproject.toml` with `[tool.ruff]` | ruff | `.py .pyi` |

- **Multiple configs coexist?** JS-family files go to eslint by default; biome only when a biome config exists WITHOUT an eslint config. Force the set with the `linters` config key.
- **Repo-local installs work**: `npm i -D eslint` puts the binary in `node_modules/.bin` — the plugin resolves it before `PATH`.
- **Nothing configured?** The plugin stays quiet; calling a tool returns the init hint (`npx eslint --init` / `biome init` / ruff) instead of an error.
- **Config file changes** (adding `biome.json` mid-session, say) are observed and re-probed automatically.

Example (input → output):

```
lint_diagnostics { file_path: "src/extract.ts" }
# lint findings (1 error, 1 warning)
src/extract.ts:12:3   error  no-unused-vars  'foo' is defined but never used
  11 | export function extract(input: string) {
  12 |   const foo = parse(input)  █
  13 |   return input
src/store.ts:8:5      warn   semi            missing semicolon  [fixable]
```

The canonical JSON (rule, file, line, col, severity, message, fixable, linter) is what `execute` returns; the compact table + code frame above is the rendered view. `file_path` matches the harness's native fs tools; the `file` alias works too. And the fix:

```
lint_fix { file_path: "src/store.ts" }
# lint_fix (eslint) — src/store.ts
fixed: yes (+0/-1 lines)
remaining: none — file is clean
```

## Install

Requires `dsh` (any install path — npx, npm, or source) and Node ≥ 22. The linters themselves are NOT bundled — the plugin uses whatever the repo already has.

```sh
# from npm (prebuilt)
npx @deepseek-ai/dsh plugin --profile web add dsh-lint-loop

# or from a directory containing this checkout
npx @deepseek-ai/dsh plugin --profile web add ./dsh-lint-loop
```

Restart the Web UI (`npx @deepseek-ai/dsh web`) — startup logs confirm each tool:

```
[dsh-lint-loop] plugin loaded
[dsh-lint-loop] registered tool: lint_diagnostics
...
```

Missing a linter entirely? The tools say so, with the exact install command: `linter "eslint" is not installed or failed to run. Install it with: npm i -D eslint`.

## Using it

In a workspace session, ask the agent:

- "Edit `src/extract.ts`, then check it with lint_diagnostics." — the section may already have shown the findings.
- "Fix all the auto-fixable lint problems in src/store.ts." (`lint_fix`)
- "What lint errors exist right now?" (`lint_workspace_errors`)

## Configuration

Options are passed as the plugin row's `config` in the profile patch (or defaults are used if absent):

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml — a bare row overrides by id.
- id: lint-loop
  config:
    maxFindings: 30
    linters: [eslint, ruff]   # force; otherwise auto-detect
```

| Key | Default | Meaning |
|---|---|---|
| `autoInject` | `true` | Register the auto-injected findings section (and the `fs/observed` listener) |
| `maxFindings` | `50` | Hard cap on findings surfaced by tools and the injected section (token-cost guard) |
| `linters` | `[]` (auto) | Force which linters are usable (`eslint` / `biome` / `ruff`); unknown keys are warned |
| `linterPath` | `{}` | Per-linter binary override (`{eslint: …, biome: …, ruff: …}`); a path ending in `.js/.mjs/.cjs` runs under the current Node |
| `sectionTtlMs` | `30000` | How long an injected delta stays current (min 1000) |
| `sectionSeverity` | `error` | Severity the injected section reports (`error` / `warning` / `info`) — warnings stay out of the prompt by default |
| `settleMs` | `600` | Quiet period after the last edit before the section re-lints (min 100) |
| `timeoutMs` | `10000` | Per-run linter process timeout (min 1000); a timed-out run is killed and reported |
| `gate` | `true` | Completion gate: block turn-stopping while edited files still carry errors |
| `gateMaxSteers` | `2` | Max forced continuations per turn before the gate admits the turn (min 0) |
| `gateSeverity` | `error` | Severity the completion gate enforces |
| `codeFrames` | `true` | Attach a source code frame to rendered findings |
| `frameLines` | `1` | Lines of context above/below a framed finding |
| `frameLimit` | `5` | Max findings that get a code frame (token guard) |

## Supported linters

- **eslint** (`--no-warn-ignored -f json`): flat config and legacy `.eslintrc`; versions that reject `--no-warn-ignored` (< 8.22) fall back automatically, remembered per repo.
- **biome** (`check --reporter=json`): both the ≥ 2 reporter shape (1-based line/column, CLI-relative string path) and the legacy byte-offset `span` shape; `format`/`organizeImports` diffs are NOT findings.
- **ruff** (`check --output-format=json`): 1-based positions; `fix` present → `fixable: true`; every violation is an error (ruff has no severities).

Rust (`clippy`), Go (`golangci-lint`), and friends are deliberately deferred — `linters.ts` + `parse.ts` are the seams where further linters plug in (command, args, JSON shape, install hint).

## How it works

- **Detection** (`src/detect.ts`): config-file probe per repo root, cached, invalidated when an observed event carries a linter config basename (`biome.json`, `pyproject.toml`, …). `pyproject.toml` counts as ruff only when it really contains `[tool.ruff]`.
- **Runner pool** (`src/runner.ts`): one serial lane per (root, linter) — a save storm queues instead of stampeding; each run is a one-shot spawn with capped stdout/stderr, killed at `timeoutMs` (SIGTERM → SIGKILL grace).
- **Findings store** (`src/manager.ts`): per-root manager keeps the last lint result per file (512-file soft cap); `lint_fix` reads the file before and after the fix run, summarizes the line diff, and re-lints for the authoritative remaining set.
- **Edit detection** (`src/section.ts`): the `fs/observed` listener only queues the file (sync, never throws); a debounced (`settleMs`) refresh lints and diffs against the per-file previous state — only new/changed findings of the configured severity reach the prompt, capped to the top 5.
- **Code frames** (`src/frames.ts`): source lines are cached during a lint run and attached to the first `frameLimit` rendered findings, with the offending line marked `█`; the render path stays synchronous and degrades to no frame when the cache is cold (replay).
- **Completion gate** (`src/gate.ts`): files observed during the turn are re-linted at `agent/turn-stopping`; remaining errors trigger a bounded `agent.steer` (≤ `gateMaxSteers` per turn) that carries the findings.
- **Workspace resolution**: session cwd → walk up to the nearest `.git` (bounded), same as dsh-code-index. Files outside a repo are refused.
- **Token-cost awareness**: every surface — tool output and injected section — is capped by `maxFindings` (section: top 5); the injected view is a per-edit delta, not the workspace.

## Relationship to dsh-lsp-diagnostics

The two plugins are **complementary and coexist**: `dsh-lsp-diagnostics` covers compiler/type errors via language servers (section order 70), this plugin covers style/lint findings via the repo's linters (order 75). No LSP is booted here and no linter is bundled there — clean separation, no overlap.

## Known limitations

- `lint_workspace_errors` covers files linted **this session** (a file joins the set the first time `lint_diagnostics` checks it) — not a whole-repo batch scan.
- Biome's JSON reporter does not expose fixability — `fixable` is `false` for biome findings, but `lint_fix` still runs `biome check --write` and reports what actually changed.
- Ruff has no severities — all ruff findings surface as `error`.
- Auto-injection triggers on harness file events; direct out-of-band edits (the user editing files externally) are not observed until the tool is called.
- Linters must be installed (repo-local `node_modules/.bin` is resolved first, then `PATH`, then `linterPath`); nothing is bundled, by design.
- The completion gate is a bounded nudge, not a hard block: it forces at most `gateMaxSteers` continuations per turn, then admits the turn — it can never wedge a session.
- Developer-preview harness: expect breaking harness/plugin API changes upstream.

## Development

```sh
pnpm install
pnpm test        # vitest — detection/routing/parsers/tools/fix/lifecycle against a marker-driven fake linter
pnpm typecheck
pnpm build       # tsup → dist/index.js (ESM, external deps)

# probe real linters in a real repo (any checkout with eslint/biome/ruff installed)
node scripts/probe-linter.mjs /path/to/repo src/someFile.ts
```

The suite runs against `tests/helpers/fakeLinter.mjs` — a marker-driven fake (`// lint: <severity> <rule> <message>`) that emits each REAL linter's JSON shape (eslint array, biome diagnostics with 1-based start/end or byte-offset spans, ruff array) and simulates auto-fix by stripping `[fixable]` marker comments — so no real linter is needed in CI. The real eslint 10 / biome 2.5 / ruff 0.16 output shapes were captured and regression-tested via `scripts/probe-linter.mjs`.

## Feedback

- **Questions, ideas, linter requests, workflow feedback** → [Discussions](https://github.com/lemonxiny55/dsh-lint-loop/discussions)
- **Reproducible bugs** → [open an issue](https://github.com/lemonxiny55/dsh-lint-loop/issues/new/choose)

If `dsh-lint-loop` saves you a fix loop, a star helps other dsh users find it.

## License

MIT. Not affiliated with DeepSeek; built on the public `dsh` plugin surface.
