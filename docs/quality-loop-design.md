# v0.6 architecture audit and design

Audited on 2026-10-07 from the clean 0.5.1 checkout. Original verification:
frozen pnpm install, TypeScript and 131/131 tests passed on Windows Node 24.19.0.
Sandboxed runs could not resolve the managed worktree/peer symlinks and temp
renames; the same commands with normal workspace access passed. No failed test
was removed, disabled or weakened.

## Existing architecture

`index.ts` adapts DSH tools/execute plus fs intents/observations, registers five
tools, a prompt section and the awaited completion checkpoint. `baseline.ts`
already owns session-aware, source-aware lint matching. `manager.ts` routes
file/package/crate linters, serializes processes, maintains current findings
and protects file-local repair. `repair.ts` orchestrates two-round lint repair.
The old gate only checked lint and consumed dirty files at each stop. It could
not prove type/test safety or reliably recheck the whole turn after a nudge.
`lintMany` intentionally retains old findings after failed probes, so its
best-effort store cannot serve as successful verification evidence.

Retain this tested lint substrate and add a separate evidence layer. A new
linter registry or general task/CI framework would duplicate existing concerns.

## Published DSH API audit

The actual npm tarballs for `@deepseek-ai/dsh-tools` and `dsh-agent` at
**0.2.0-rc.2** were inspected, rather than assuming master matched the release:

- tools/execute is an around-dispatch waterfall; call and await next exactly
  once. ToolDispatchExecution carries arguments, agent/session identity and
  AbortSignal. Definitions still use defineTool + canonical JSON output.
- agent/turn-stopping is a serial, awaited checkpoint, carries an AbortSignal,
  and permits steer before final inbox drain. It has no built-in retry bound.
- session/event carries a durable turn/end on success, errors and cancellation.
  Errors can bypass turn-stopping; this boundary cancels pending checks and
  resets baselines and accounting while preserving the last receipt. Detached
  state prevents old in-flight evidence from populating a subsequent turn.
- presentCall/presentResult are pure Host-local descriptors in both APIs.
  Desktop inspection corrected the initial assumption that these prove Web
  UI support: the installed tools README explicitly says the built-in Web
  Client does not consume them. Its renderer is selected by tool.call.toolview
  and derives props from durable raw events. Host presenter tests therefore
  prove only that contract; a dedicated desktop/Web Quality Bar is deferred.
- The client session-header slot also exists, but a persistent bar requires a
  client bundle, a session resource transport and client lifecycle wiring.
  That is outside this release's scope. No DOM injection or undocumented HTTP
  endpoint is used. v0.6 ships ordinary structured tool output and optional
  Host-local presenters, not a desktop/Web Quality Bar.

Primary upstream references:
[core lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md),
[agent contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/README.md),
[tools package](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/tools).
The isolated 0.2 API ruler and runtime smoke are recorded in release evidence.
The 0.5.1 disjunctive peer range and Cordis policy are deliberately unchanged.

## Architecture

```text
DSH lifecycle adapter
  before first write: session/root package evidence baseline
  after successful write: original lint baseline + tracked file
           |
           +-- Fast Lane: section + diagnostics + transactional lint repair
           |
           +-- Completion Lane: awaited checkpoint / quality_verify
                 discovery -> ImpactProvider -> local check adapters
                 immutable baseline -> multiset delta -> Quality Receipt
                                             -> bounded steering
                                             -> structured tool output / Host presenter
```

`quality-plan.ts`: bounded repository/package inventory and conservative static
ImpactProvider. `quality-checks.ts`: local TypeScript and Vitest/Jest execution,
report parsing and process evidence. `quality.ts`: session/root baselines,
completion budgets, deltas, repair accounting and detached receipts.
`quality-view.ts`: pure Host presenters. `gate.ts`: whole-turn retention and
bounded continuation. The existing manager now exposes execution evidence and
cooperative cancellation without converting best-effort stores to proof.

## Semantic decisions

Capture type/test evidence before any tracked mutation; never reconstruct a
baseline by temporarily restoring tracked files, checking out HEAD or stashing
user work. Capture repository packages once because later changes can affect
other packages and newly selected tests need comparable evidence. This has a
bounded upfront cost. Unknown custom scripts are not executed automatically.

Lint retains source-aware matching. Modern missing/failed lint baselines yield
incomplete evidence and cannot gate old findings as new. The owner-less legacy
markDirty seam retains its earlier behavior but is explicitly incomplete.
Type diagnostics compare file/code/message/source-context multisets; tests compare suite,
fullName and failure signature. Line positions are ignored without throwing
away duplicate counts. Changed symptoms in a failing test remain regressions.
Suite-load failures and skipped/pending tests do not count as successful proof.
The gate only steers for provable regressions, never for historical debt or
unknown evidence. Limit exhaustion admits the agent with a regression receipt.

A receipt's autoFixed comes from actual safe lint repair, not inferred lint
absence. agentFixed requires a prior observed regression and a successful
subsequent check; a removed/skipped test is not advertised as a fix. Receipts
retain actual baseline/current commands and selected/executed test identities.
JSON snapshots cannot mutate stored evidence. Unload aborts owned processes;
late async completions cannot recreate receipts after a remount.

Static import selection is evidence within a restricted domain, not a complete
runtime index. Dynamic/bare workspace/alias/runtime dependencies, test setup or
custom discovery cause repository fallback. No proven test edge causes package
fallback. Reference builds are not claimed verified by tsc --noEmit. Missing
runners, unreadable paths/symlinks, entry/check budgets and invalid reporters
remain incomplete. An optional future index can implement ImpactProvider and
supply explicit complete/uncertain evidence without becoming a hard dependency.

## Scope cuts

No LLM review, requirements workflow, CI/coverage/security platform, new linter
family or companion-plugin dependency. No persistent web dashboard. Automatic
Go/Rust package/crate fixers are skipped: their source-only snapshots cannot
protect manifest/lockfile/neighbor rewrites. Diagnostics and explicit standalone
fixer APIs remain. Existing eslint/biome/ruff safety is preserved and tracked
lint_fix now uses regression-only permitted findings.

## Validation contract

Keep old tests and strengthen the package-repair boundary test to assert exact
neighbor contents. Update exact tool registration/disposal counts from five to
seven for the two added tools. Add real TypeScript/Vitest integration alongside
process protocol fixtures for debt, regressions, impacted selection/fallback,
Jest arguments, monorepo scopes, cancellation/timeout, queued cancellation,
receipt correctness, presets, bounded retries/repairs and lifecycle. Run frozen
install + typecheck + complete suite + build under both Node 22 and 24. Extend
CI to Windows/Linux for shell/path behavior. No publication is authorized.
