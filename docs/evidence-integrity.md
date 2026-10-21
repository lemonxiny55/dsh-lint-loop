# v0.7.0 Evidence Integrity

Candidate only. This is a bounded source verification system, not a Git/CI
platform, an LLM reviewer, or proof about every process on the machine.

## Source and lifecycle audit

The audit used the published v0.6.0 source and bundle, the exact DSH tag
[`dsh-v0.2.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.2)
at `687f282e8625c6b8d11ff58211a90524be2e4317`, published DSH/tools
`0.2.1-rc.2`, and Cordis `4.0.5`. v0.6.0's 162 original tests passed before changes.

The real [tools pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/core/tools/src/index.ts)
awaits `tools/execute` around dispatch, then post-execute policies, then immutable
`tools/result`. File tools return canonical path/before/after and emit fs
observations. Reads also emit observations. An fs intent is a policy slot that
can short-circuit later listeners; it cannot be the sole mutation observer.
The [shell contract](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/shell/tool-pwsh/src/index.ts)
allows background execution and foreground promotion on timeout. A return code
therefore cannot establish a complete filesystem scope.

The current directory is now a durable `workingDirectory` projection. Header
cwd remains the original project. The separately reviewable
[v0.6.1 hotfix](https://github.com/lemonxiny55/dsh-lint-loop/pull/7) reads the
optional service through public `ctx.get()`, binds cwd to each execution with a
WeakMap, and retains the older-host fallback. Real Cordis rejected undeclared
property access in the first experiment; import-only mocks did not expose it.

## Model

State is keyed by session identity and normalized absolute workspace root. Scans
anchor the explicit root to its physical spelling, accepting Windows case/8.3
aliases while rejecting a symbolic-link root. A Git
worktree's `.git` file is supported; no Git metadata is modified. Explicit
session roots also support non-Git directories; filesystem roots are rejected.

1. Capture immutable pre-edit lint/type/test debt. Check source stability across
   the baseline sweep; side effects or concurrent writes invalidate that evidence.
2. Capture content and mode identities before dispatch. Direct edit/write keeps
   the existing repair scope; nested fs intents reuse that dispatch checkpoint.
3. Capture again after success, failure, exception or cancellation. Cleanup has
   its own scan budget, even when the command's caller has aborted.
4. Compare direct file-tool canonical before/after bytes to both checkpoints.
   Observe `tools/result` so a later policy failure cannot masquerade as success.
5. Before final checks, include both known targets and all observed changes.
   Recheck source stability across final verification. Before displaying a saved
   receipt, check its source digest for staleness.

`tool-target` describes a validated direct file operation. `unattributed`
describes observations without a reliable authorship contract: other paths in
a direct window, general commands, between-window edits, overlaps, partial
failures, or disagreeing commit bytes. General executions always retain an
incomplete scope reason, because they may affect excluded/outside paths or
continue after return. No shell parser or Git dirty status is treated as proof.

Uncertain paths enter `changedFiles` and test selection, but never enter the
automatic repair list. With incomplete attribution, diagnostics are recorded
under `unattributedFindings`, not Agent regression/fix counters. The legacy
ownerless gate seam can still request inspection of diagnostics; its receipt
remains incomplete. Historical debt matching, supported compiler/test adapters,
two repair rounds and bounded steering remain regression-aware.

Deletion is a first-class observed operation. Rename is represented as delete
plus add; identical content does not prove a rename's authorship. Deleted or
unsupported files without applicable lint evidence remain incomplete. New direct
write targets get an authoritative empty lint baseline only after safe absence
is established.

## Bounds and receipt

Existing configuration remains valid. Additive settings:

| Setting | Default | Meaning |
|---|---:|---|
| `trackingTimeoutMs` | 2000 | Cooperative budget for one source scan |
| `trackingMaxBytes` | 33554432 | Shared byte reservation across scan readers |
| `trackingMaxFileBytes` | 2097152 | Maximum individual file size |
| existing `qualityMaxFiles` | 2000 | Discovery entries and retained change events |

Eight readers share the reservation budget; file descriptors close in `finally`.
Each buffer has one extra growth-detection byte. An exceeded budget, unstable
file, unreadable directory, permission denial, special file or symlink makes
coverage incomplete. Symlinks are not traversed. Root and ancestor paths are
checked before tool/fixer invocation. Turn/end and dispose detach/cancel state;
late operations cannot populate a later turn's receipt. Reasons and retained
change events are capped.

The declared source exclusions are `.git`, `node_modules`, `dist`, `build`,
`coverage`, `.cache`, `.next`, `.turbo` at any directory level. A receipt's
`evidenceCoverage` reports these exclusions, scope, content/mode identities,
source digest, outcomes, attribution, reasons and tracking scan costs. It keeps
schemaVersion 1 with additive fields. It is a detached JSON snapshot, not a
signed attestation. Coverage metrics count tracking scans; command and check
timings are separate.

Missing or stale coverage cannot produce a CLEAN final verdict. Known regressions
remain regressions; uncertain diagnostics, skipped/missing checks and budget
exhaustion remain explicit. The receipt tool runs source scans, not lint or tests.

## Performance

`scripts/benchmark-evidence.mjs` uses the same machine, runtime and fixture for
both bundles, one warmup plus 20 measured samples, and three direct edits per
sample. It validates complete receipts and semantic equality, samples memory, and
sets `completionChecks=false` to isolate change tracking. A second scenario applies
deterministic shell-like filesystem changes through an `exec` event callback; it
does not include shell-process startup. This is not an application-throughput
benchmark.

Actual Windows / Node 24.19.0 medians in milliseconds:

| Source files | v0.6 first edit | v0.7 first edit | v0.6 repeat | v0.7 four-reader repeat |
|---:|---:|---:|---:|---:|
| 100 | 66.90 | 134.67 | 0.83 | 42.80 |
| 1000 | 69.28 | 678.34 | 0.96 | 398.64 |

The original one-reader comparison measured 968.42ms versus 398.64ms at four
readers for a repeated 1000-file edit. The updated [optimized comparison](release-evidence/v0.7.0/benchmark-optimization-node24.json)
measures four versus eight readers: **394.46ms → 311.22ms** median and
**400.12ms → 315.77ms** P95. The shell batch/add/delete/rename scenario measured
**411.39ms → 325.89ms** median. Receipt semantics matched. Sixteen readers were
tested but not selected; their [exploration](release-evidence/v0.7.0/benchmark-reader-limit-exploration-node24.json)
shows roughly twice the observed shell-batch heap peak versus eight. These candidate
checks remain slower than v0.6 because v0.6 did not inventory file content.
[Original raw samples](release-evidence/v0.7.0/benchmark-node24.json) retain the
one- and four-reader results. These runs were sequential, not a controlled
CPU-isolated experiment. Real full-check timings are in the lifecycle demo receipts.

Baseline check promises are shared once per session/root/turn, retaining the
original pre-edit debt. Completion results are rerun: source-only hashing excludes
dependencies and environment, so reusing checks from that hash alone would be
unsound. No mtime-only cache or restored user checkout is used to save time.

## Optional code-index assessment

The npm `dsh-code-index@0.10.1` artifact exports `buildChangeContext`,
`ChangeContextResult`, `AffectedTest`, graph provenance and truncation flags.
This is a real public interface. Its suggested tests can be based on import,
symbol-name or path-convention evidence, and its graph explicitly has syntax,
read and truncation limits. Those labels do not promise exhaustive executable
test coverage or a stable host service for this plugin.

No experiment proved a safe selection reduction beyond the existing conservative
reverse-import provider. Integration is deferred. `ImpactProvider` stays optional;
no mandatory companion dependency, graph cache or LLM reviewer is added.

## Remaining limits

- Checkpoints observe endpoints, not every intermediate write. A transient edit
  reverted between scans is invisible. They cannot prove exclusive OS ownership.
- General scripts, custom execution worlds, background work and outside/excluded
  paths cannot establish complete attribution and therefore remain incomplete.
- Canonical string/byte disagreement, including unsupported encoding/newline
  transformations, fails closed rather than guessing.
- Source scans and path checks are cooperative local filesystem operations, not
  atomic snapshots or hard deadlines for a kernel call stalled on a network mount.
  Ancestor replacement races are not eliminated by portable Node filesystem APIs.
- Dependencies, tools, environment and flaky tests can change independently.
  Test side effects in the source tree invalidate the sweep. Artifact directories
  are explicitly outside scope; dependency/environment changes are not hashed.
- Static test selection is conservative. Unsupported runners, references,
  custom/chained scripts and missing or skipped test evidence stay incomplete.
- Safe fixers retain v0.6's bounded historical-debt checks and rollback behavior.
  Tracking itself performs no writes, index edits, reset, stash or file restoration.
