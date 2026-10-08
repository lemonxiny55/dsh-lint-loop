# v0.6.0 — Quality Loop candidate verification

This records the pre-publication candidate audit. Subsequent publication and
remote CI status are recorded in the
[formal release](https://github.com/lemonxiny55/dsh-lint-loop/releases/tag/v0.6.0).

Verified on **2026-10-08**, Windows / PowerShell 7.6, pnpm **10.32.1**.
Status: **RELEASE CANDIDATE READY**. The automated matrix, real desktop tool
acceptance and automatic Completion Lane all pass. Desktop/Web Quality Bar is
explicitly deferred within the requested UI fallback boundary.
No npm publication, GitHub Release, commit or push was performed.

## Full matrix actually executed

| Check | Node 22.23.3 | Node 24.19.0 |
|---|---|---|
| frozen install | passed | passed |
| typecheck | passed | passed |
| full tests | 162/162, 14 files | 162/162, 14 files |
| build | passed, 125.60 KB ESM | passed, 125.60 KB ESM |
| bundle with DSH tools 0.1.7-rc.2 | passed | passed |
| bundle with isolated DSH tools 0.2.0-rc.2 | passed | passed |
| isolated 0.2 declaration typecheck | passed | passed |

[Final Node 22 log](desktop/node22-rc.log) ·
[Final Node 24 log](desktop/node24-rc.log).
These runs include `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`,
`pnpm build`, both runtime compatibility smokes and the 0.2 declaration check.
No skipped or disabled tests in either full run. The original 131 tests passed
before implementation. Existing tests were retained, with registration counts
updated for actual new tools/listeners and package-fixer protection strengthened.
The root lockfile, disjunctive DSH peer range and Cordis peer policy are unchanged.

The Node 22 binary came from nodejs.org and its directory led PATH for the whole
matrix, including lifecycle scripts and subprocesses. The temporary directory
was removed after these checks; the system Node 24 installation is unchanged.
Earlier 158/159-test candidate logs remain as historical execution evidence.

The new lifecycle and semicolon-identity regressions were also verified in a
red/green cycle: temporarily removing the fixes made all three targeted
regression tests fail; restoring them passed the full 162-test matrix.
No test was weakened to obtain a pass.

## Real desktop acceptance

The user installed the local package link into their desktop profile. The real
host is DSH **0.2.0-rc.2**, Electron **44.0.0**, embedded Node **24.18.1**.
Acceptance uses the official authenticated localhost API: exchange the launch
URL for a cookie, then call session/create and session/prompt. Credentials stay
in process memory; no auth settings or security permissions were modified.
Mouse/keyboard automation is not required for this background acceptance.

The isolated Git fixture installs real ESLint **10.12.0**, TypeScript **6.0.3**
and Vitest **4.1.11**. Before editing, it contains an unused variable, an old
TS2322 in legacy.js and an old failing test. The unrelated b test passes.

The original incomplete TypeScript receipts are retained as failure evidence.
Electron self-spawn now explicitly uses supported Node mode. Failed reporters
retain bounded raw output and exit code. After installing formal compiler/test
packages in the isolated fixture, actual desktop checks parse successfully.
The earlier custom-wrapper discrepancy is not treated as a proven supported
scenario. A prior DSH pwsh sandbox ACL error did not require or receive repair.

The interrupted session was resumed and completed normally: its final
[receipt](desktop/resumed/188-quality_receipt.json) is clean, with all three old
debts intact. Restart resets in-memory accounting; it does not claim earlier
repairs happened in the resumed turn.

A fresh complete acceptance turn then produced:

| Stage | lint | types | tests | new | old | auto | agent |
|---|---|---|---|---:|---:|---:|---:|
| introduce string and missing semicolon | regression | regression | regression | 3 | 3 | 0 | 0 |
| safe lint repair | clean | regression | regression | 2 | 3 | 1 | 0 |
| restore only the new code | clean | clean | clean | 0 | 3 | 1 | 2 |

[Initial receipt](desktop/rc/28-quality_verify.json) ·
[After autofix](desktop/rc/52-quality_verify.json) ·
[Final verification](desktop/rc/105-quality_verify.json) ·
[Final receipt](desktop/rc/122-quality_receipt.json).

Changed files are exactly `src/a.js`; impacted selection is exactly
`tests/a.test.js`; executed identities include its working and historical tests.
Only the baseline sweep runs both test files. Repair rounds: **1**. The final
receipt records real commands, arguments, baseline and current evidence,
selection reasons and elapsed time. Missing semicolon repair does not count
the unresolved type failure as agent-fixed. This turn ends with reason completed;
DSH's automatic retry recovered transient model rate limits within the turn.

The live automatic checkpoint was tested separately, without quality_verify:
the agent changed a from 1 to 2 and attempted to stop. The gate found the new
test failure and injected one accepted producer-owned dsh-lint-loop message.
The agent restored only that value and completed normally. The subsequent
[saved receipt](desktop/gate/95-quality_receipt.json) is clean, with
continuationRounds **1**, agentFixed **1** and historical debt **3**.
[Selected events](desktop/gate-events.json) prove the accepted steer and normal
turn/end. The earlier generic plugin source rejection is preserved in
[failure evidence](desktop/gate-source-error.json); the final format correction
passed a targeted red/green test and both full matrices. No session history was
rewritten to hide that failure.

[Fixture integrity](desktop/fixture-integrity.json) asserts that original source
and test bytes remain intact after acceptance, including all three old debts.

A subsequent [native GUI smoke](desktop/gui/README.md) also passed. Using
Computer Use in the real desktop window, we created a conversation, entered the
task and clicked Send. The agent appended one blank line in src/a.js and ran
quality_verify then quality_receipt. Both saved results are identical: all three
checks complete and clean, zero new regressions, three historical debts,
tests/a.test.js selected, elapsedMs 1007. The UI showed normal completion; we
expanded ordinary tool output, clicked View and inspected the native trajectory
Results JSON tree and expanded test selection. No localhost API initiated this
GUI turn. The isolated fixture was restored after capture; a private unmodified
screenshot remains local. Fresh installation and plugin toggle flows are outside
this smoke's scope.

## API, lifecycle and UI boundary

Both DSH tools release lines import the built bundle, register seven tools,
six listeners and one prompt section, dispose everything and mount again.
Published 0.2 declarations typecheck independently. Tests cover bounded repair
and steering, cancellation/timeouts, process-tree termination, Windows cmd/path
handling, detached receipts, remount and late completion protection.
Durable session/event turn/end clears state after success, errors and cancellation,
including model failures that bypass agent/turn-stopping. Pending checks are
cancelled and detached so they cannot overwrite a later turn's receipt.

**Desktop/Web Quality Bar is deferred.** The installed tools README explicitly
says built-in Web Client does not consume Host presentCall/presentResult values.
Pure Host presenter tests prove that contract only. Ordinary tool output exposes
the structured receipts; no client bundle, DOM injection or screenshot mockup
is represented as an implemented Quality Bar. See the corrected
[UI audit and future capture guide](../../quality-bar-demo.md).

## Behavior and packaging

The suite covers historical lint/type/test debt, new/changed/multiset regressions,
safe autofix and rollback, impacted selection and uncertainty fallback,
monorepo/package scopes, presets, budgets, cancellation, timeout and receipt
correctness. Real TypeScript/Vitest integration verifies old debt and selected
tests. Jest is covered by adapter/report/argument fixtures; real Jest execution
was not performed. Linux/Windows x Node 22/24 is configured in CI; Linux was
not run in this local Windows session.

The dry-run manifest is [pack-rc.json](desktop/pack-rc.json). Package contents
are LICENSE, both READMEs, profile patch, bundle, map and package manifest.
No runtime dependency was added; no package was published.

README first screen and before/after demo now explain change-aware quality
proof. Chinese README and CHANGELOG describe value, semantics and boundaries.
The repository description and eleven topics were saved and read back in the
authenticated GitHub UI; [screenshot](github-metadata.jpg) records the changes.
Remote source is unchanged because no commit or push was performed.

## Known limits

Only successful DSH edit/write mutations and compatible fs intents establish
an authoritative scope. Shell/custom edits, deletion and external writes are
not fully attributed. Baseline suites may have side effects and flaky tests
can look like regressions. Static selection is conservative; unresolved imports
and configuration broaden supported suites. Custom/chained scripts, node:test,
missing runners, TypeScript reference builds and incomplete discovery remain
explicitly incomplete. Type diagnostic source-context normalization ignores
line shifts, whitespace and trailing semicolons; it is not a semantic AST matcher.
No LLM review, requirements management, security/coverage/CI platform or mandatory
companion plugin is added. A code-index provider can implement ImpactProvider
later without becoming a v0.6 dependency.
