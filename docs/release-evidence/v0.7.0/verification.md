# v0.7.0 Evidence Integrity candidate verification

Candidate version: `0.7.0-rc.0`. Date: 2026-10-19.
Status: **IN PROGRESS — not yet RELEASE CANDIDATE READY**.
No npm publication, GitHub Release or merge is authorized.

The audit, scope, performance method and known blind spots are documented in
[Evidence Integrity](../../evidence-integrity.md). The working directory's existing
`.git` link points to a missing old checkout; it was preserved. Separate local
clones and authenticated GitHub commits are used for review, with normalized
repository line endings. No reset, stash, cleanup or rollback of user work was used
for change tracking or baseline capture.

## Actually executed so far

- Original v0.6.0: 162/162 tests before implementation.
- Isolated v0.6.1 compatibility hotfix: 163/163 tests, typecheck, build and smoke.
  A real published DSH AgentLoop demo also completed regression → regression →
  clean with three historical debts. [Separate PR #7](https://github.com/lemonxiny55/dsh-lint-loop/pull/7).
- Candidate intermediate full Windows runs: 187, 189 and then 191 tests passed.
  Node 22.23.3 and Node 24.19.0 each completed typecheck, 191/191 tests, build and
  smoke. Newer tests/changes require fresh final verification; earlier passes are
  not represented as validation of a later source revision.
- Published DSH tools 0.2.1-rc.2 / Cordis 4.0.5 declarations and module import,
  tool registration, disposal and remount passed.
- Actual published DSH AgentLoop and file tools with real ESLint 10.12.0,
  TypeScript 6.0.3 and Vitest 4.1.11 produced regression → regression → clean,
  with three historical debts intact. Model input was a deterministic scripted
  adapter, not a live model. Source, tests and processes were real.
- Windows real shell/bash/pwsh success/failure/cancellation and real ACL denial
  passed in the intermediate full suite. The new real-worktree and final-result
  cases are awaiting the current final run.
- Node 24 performance samples: v0.6 versus candidate, 100 and 1000 files, plus
  serial versus four-reader hashing. See raw sample JSON and architecture table.
- npm DSH 0.2.1-rc.2 is installed in an isolated directory. The official Desktop
  rc.2 installer was downloaded, its SHA512 matched the official feed, and its
  application payload was extracted to an isolated directory. This alone is not
  a claim that Desktop installation and runtime acceptance passed.

## Pending release gates

- Final exact-source local Node 22/24 runs and all Linux/Windows × Node 22/24 CI.
- Actual Web profile package installation, app startup and driver results.
- Actual Desktop profile package installation, app startup and driver results.
- Final PR checks, package manifest, source diff review and demo evidence capture.

These gates must be replaced with actual results before asserting
**RELEASE CANDIDATE READY**. Tests are not skipped or disabled to achieve a pass.
Any missing evidence remains a release limitation rather than a fabricated record.
