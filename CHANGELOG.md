# Changelog

All notable changes to dsh-lint-loop are documented here.

## Unreleased

- **fix(compat):** widen the `@deepseek-ai/dsh-tools` peer range from
  `>=0.1.0-rc.1 <0.2.0-0` to the family's four-clause union
  `>=0.1.2-rc.1 <0.2.0 || >=0.1.5-alpha.1 <0.2.0 || >=0.1.6-0 <0.2.0 || >=0.1.7-0 <0.3.0-0`.
  Since dsh `0.2.0-rc.2` the plugin loader evaluates every `@deepseek-ai/dsh*`
  peer with `semver.satisfies(runtimeVersion, requirement, { includePrerelease:
  true })` and rejects the install when the runtime does not satisfy the range;
  prerelease `0.2.0-rc.2` sits below the old `<0.2.0-0` bound, so the plugin
  could not install on the current desktop line. The first three clauses admit
  every host line the old range admitted, and the `<0.3.0-0` upper bound keeps
  the last clause closed against a future `0.3.0` line. The dev/test pin moves
  from `0.1.0-rc.8` to `0.1.7-rc.2`, matching the last clause's floor so the
  suite executes the host packages the declared range targets.
- **fix(lockfile):** drop the stale `.tmp/dsh-lint-loop-smoke` importer (and
  its unused dependencies) that `pnpm install --frozen-lockfile` on CI trips
  over: `ERR_PNPM_OUTDATED_LOCKFILE ... not up to date with
  <ROOT>/.tmp/dsh-lint-loop-smoke/package.json`.

## 0.5.0 — 2026-09-27

Regression-aware self-repair: one bounded Agent call repairs only lint
regressions introduced or changed in files edited during the current turn.

- **feat(repair):** add `lint_repair { scope: "turn" }`, which batches edited
  files by existing linter/package/crate targets, prioritizes each linter's
  existing fixer, re-lints after each pass, and stops after at most two passes.
- **feat(safety):** file-local fixers snapshot and verify their target; if a
  fixer adds a diagnostic, the file is restored and linted again. They are
  skipped when they could also fix historical debt (Biome's fixability is
  unknown, so any old finding is a reason to skip). Package and crate fixers
  run only when the scoped findings are all current-turn regressions. They are
  not rolled back; the receipt lists every file they changed and reports newly
  introduced findings.
- **feat(receipt):** return regressions found, resolved, remaining, affected
  files, actual fixer changes, ignored pre-existing findings, and stop reason.
- **feat(status):** add a compact `lint_status` Agent tool. The current DSH
  plugin surface exposes tools and prompt sections but no stable slash-command
  registration API, so `/lint-status` is deferred rather than emulated.
- **test/docs:** cover turn scoping, ignored historical debt, package fixer
  batches, transactional rollback, and bounded retries. Stylelint is deferred
  to keep this release focused on safe regression repair.

## 0.4.0 — 2026-09-19

Regression-aware lint loop: an edit is evaluated against the findings that
existed immediately before that edit, so historical lint debt no longer blocks
an otherwise clean turn.

- **feat(baseline):** capture per-session baselines through DSH's
  `fs/edit-intent` / `fs/write-intent` waterfalls before the mutation delegates
  to the harness policy; preserve the first baseline across repeated edits in
  one turn and re-arm it after a completed turn.
- **feat(matching):** add position-independent finding fingerprints using
  linter, rule, severity, normalized message, source line, and bounded
  approximate location. Existing `findingKey` remains compatible; inserted
  lines no longer make every historical finding look new, and duplicate
  rule/message occurrences are matched one-to-one.
- **feat(gate):** completion steering now considers only unresolved introduced
  or changed errors. Pre-existing errors remain visible but do not block the
  turn; `gateMaxSteers` remains the loop guard.
- **feat(tools):** `lint_diagnostics` accepts an optional compatible
  `scope: all | introduced | preexisting` filter and returns a `scope` label;
  `lint_workspace_errors` labels current errors; `lint_fix` re-lints before
  and after fixing, keeps the baseline intact, and reports resolved findings.
- **feat(section):** `lint:findings` prioritizes introduced/changed findings,
  suppresses historical debt, and de-duplicates repeated observations using
  the same robust matcher.
- **feat(lifecycle):** modern DSH intent hooks are pass-through observers;
  legacy `fs/observed` integrations retain a compatibility fallback. Windows
  direct executable spawning now preserves stdout and ENOENT install hints.
- **test/docs:** 121 tests cover baseline capture, line drift, duplicate
  findings, repeated edits, new files, intent-hook pass-through, gate
  re-steer/fix, tool scopes, fixer re-lint, current golangci JSON summaries,
  and package-scoped batch distribution. Release evidence records current DSH
  smoke results and known filesystem limits.

## 0.3.0 — 2026-09-14

- **feat(detect):** Go (`golangci-lint`) is detected via any `.golangci.yml` / `.golangci.yaml` / `.golangci.toml` / `.golangci.json`; Rust (`cargo clippy`) via a `Cargo.toml` (clippy ships with the toolchain). `.go` routes to golangci-lint, `.rs` to clippy; config-basename changes re-probe as before.
- **feat(linters):** two **package-scoped** linters. `golangci-lint` runs `run --output.json.path=stdout` (v2) with an automatic `--out-format=json` fallback (v1); `cargo clippy` runs `clippy --message-format=json` in the nearest `Cargo.toml` directory. Per-linter timeout floors (60s / 120s) keep the 10s default from killing a cold cargo build.
- **feat(parse):** golangci-lint `{ Issues: [...] }` → findings (empty `Severity` → `error`; `SuggestedFixes` in v1.64+/v2 or a legacy `Replacement` → `fixable`); cargo clippy NDJSON `compiler-message` → findings (`clippy::*` / `E####` codes, child-span suggestion → `fixable`). Reported paths resolve against the run's base directory (workspace root / crate root) with an existence fallback.
- **feat(manager):** package-scoped results are **distributed** into the store by each finding's own file, so `lint_diagnostics { file }` stays per-file; a new batched `lintMany` runs one package linter per package, so the completion gate and the injected section analyze N edited files in a crate with a single `cargo clippy` run.
- **docs/tests:** README (EN+ZH) tables and supported-linter sections updated; 109 tests (up from 94) — new coverage for Go/Rust detection + routing, both parsers, package-scope distribution, single-run batching, crate-root resolution, and package-linter auto-fix, all via the extended marker-driven fake linter (new golangci-lint and cargo-clippy modes).

## 0.2.0 — 2026-09-10

The P0 loop upgrades: a completion gate, source code frames, and a slimmer injected section.

- **fix(gate):** the `agent/turn-stopping` listener now **returns the async handler** so the harness awaits the lint + steer before committing the turn boundary. It was fire-and-forget (`void handleTurnStopping(...)`), which raced the turn close — the steer could land after the process had already exited (caught by a headless live run: `errors= 3` printed after the turn ended). Found and fixed during real-harness verification.
- **fix(tools):** `lint_diagnostics` / `lint_fix` now accept the harness-consistent **`file_path`** argument (native `read`/`write`/`edit` convention) alongside the original `file` alias. Live models reached for `file_path` and hit `missing required property "file"`; both names now resolve, and `lint_fix` returns a friendly error only when neither is given.
- **feat(gate):** the completion gate on the harness `agent/turn-stopping` seam. When files edited during the current turn still carry errors, the plugin steers the agent for another step (via a structurally-built `UserMessage`, so no new runtime dependency) instead of letting the turn close. Self-limiting: each file is evaluated once per stopping, each turn forces at most `gateMaxSteers` continuations (default 2), and `lint_fix` re-arms the check after it rewrites a file (the linter process bypasses `fs/observed`). Gated severity defaults to `error`; `gate: false` disables. Backward compatible: `autoInject: false` alone still means tools-only.
- **feat(frames):** **source code frames** on rendered findings — each (up to `frameLimit`, default 5) finding is followed by `frameLines` (default 1) lines of context with the offending line marked `█`. The Aider trick: the model fixes from the finding without re-reading the file. Lines are cached during the lint run and looked up synchronously by the render path; an uncached/replayed result simply omits frames. `codeFrames: false` disables.
- **feat(section):** the injected `lint:findings` delta is now **errors-only by default** (`sectionSeverity`, default `error`) — warnings stay out of the prompt unless asked for. The quiet period before re-linting is configurable (`settleMs`, default 600ms). The delta text names the count and severity it reports, and keeps the explicit truncation note.
- **test:** 94 vitest cases (up from 72) — new `frames.spec` and `gate.spec`, a regression test that the turn-stopping listener returns an awaitable promise (the race above), `file_path`-alias coverage, section severity filtering, and code-frame integration. Verified end-to-end on the real harness (headless target): edit → gate fires → model runs `lint_fix` → file rewritten → gate re-checks → turn admitted, with the final file clean.

## 0.1.0 — 2026-09-09

Initial release — the edit → lint → fix loop for dsh agents.

- **feat(tools):** three model-visible tools — `lint_diagnostics` (per-file or seen-files findings with rule, file:line:col, message, and a fixable flag; severity filter and `max` cap), `lint_workspace_errors` (all errors across files linted this session), and `lint_fix` (runs `eslint --fix` / `biome check --write` / `ruff check --fix` on ONE file, then re-lints and returns what changed, a +added/-removed line summary, and the remaining findings). Every `execute` is wrapped: missing linters surface with their exact install command, unconfigured repos get init hints (`npx eslint --init` / `biome init` / ruff), out-of-workspace files and unsupported extensions get friendly messages — errors never throw to the model.
- **feat(detect):** zero-config linter detection — probes the repo root for eslint (`eslint.config.*` / `.eslintrc.*`), biome (`biome.json[c]`), and ruff (`ruff.toml` / `.ruff.toml` / `pyproject.toml` with `[tool.ruff]`); caches per root and re-probes when a config file changes (via `fs/observed`). JS-family files route to eslint by default, biome only when a biome config exists without eslint; `.py/.pyi` route to ruff. A `linters` config key forces the set. Repos with no linter config leave the tools quiet-but-alive: calling them returns the init hints.
- **feat(runner):** one serial lane per (workspace root, linter) so a save storm never runs N linters concurrently; per-run timeout (default 10s, configurable) kills the process and degrades with a clear message instead of hanging the loop; stdout/stderr capped; `--no-warn-ignored` falls back automatically on eslint versions that reject it (< 8.22), remembered per root.
- **feat(parse):** defensive JSON parsers per linter — eslint (`-f json`), biome (`check --reporter=json`, both the ≥ 2 1-based line/column shape and the legacy byte-offset `span` shape, with `format`/`organizeImports` diffs excluded), and ruff (`check --output-format=json`, 1-based, `fix` → fixable). Malformed output raises a friendly ParseError, never a stack trace.
- **feat(repo-local binaries):** `npm i -D eslint` / `@biomejs/biome` binaries in `node_modules/.bin` are resolved before PATH (`.cmd` variants on Windows) — the standard install layout just works.
- **feat(section):** auto-injected `lint:findings` system-prompt section (order 75, right after `lsp:diagnostics`; gated by `autoInject`, default on). Subscribes to the harness `fs/observed` event; the sync listener only queues the file; a debounced refresh lints through the same serial pool and injects only the NEW/CHANGED findings for the edited file — top 5 lines plus counts, capped, expiring after `sectionTtlMs` (30s default).
- **feat(config):** `autoInject` / `maxFindings` / `linters` / `linterPath` / `sectionTtlMs` / `timeoutMs`, merged over defaults with input coercion; `linterPath` overrides ending in `.js/.mjs/.cjs` run under the current Node (the seam the test fakes use).
- **test:** 72 vitest cases against a marker-driven fake linter (`// lint: <severity> <rule> <message>`, emitting each real linter's JSON shape) — detection/routing (three suffix families, dual-config coexistence, forced sets), parse shapes (real-captured biome 2.5.12 output regression-tested), caps and truncation notes, timeout degradation, `lint_fix` before/after diffs, config-change re-probing, missing-binary install hints, serial-lane ordering, and mount/dispose/remount lifecycle. No real linter required in CI.
- **chore:** ESM + tsup (`dts: false`), Node ≥ 22 engines, MIT, bilingual README, GitHub Actions CI (Node 22/24 matrix). Verified against real eslint 10.x, biome 2.5.x, and ruff 0.16.x via `scripts/probe-linter.mjs`.
