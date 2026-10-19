# v0.7.0 Evidence Integrity candidate verification

Candidate: `0.7.0-rc.0`. Date: 2026-10-19.
Status: **RELEASE CANDIDATE READY** for the documented bounded source scope.
No npm publication, GitHub Release or merge has been performed or authorized.

Runtime/test source revision: `7db62ca6c1454ac1938044ef4d22df7dcdd72b67`.
Later commits add evidence, documentation and the isolated serial benchmark builder;
they do not change the installed runtime bundle. The PR remains a reviewable draft.

## Review and compatibility

- [PR #7](https://github.com/lemonxiny55/dsh-lint-loop/pull/7) isolates the blocking
  latest-DSH workingDirectory compatibility fix, version `0.6.1-rc.0`. Its
  [four-job CI](https://github.com/lemonxiny55/dsh-lint-loop/actions/runs/39242458977)
  passed; local checks passed 163/163 tests, types, build and smoke. The real DSH
  AgentLoop demo also completed regression → regression → clean with three old debts.
- [PR #8](https://github.com/lemonxiny55/dsh-lint-loop/pull/8) is stacked on #7 and
  contains Evidence Integrity. Existing v0.6 configuration and peer policy remain.
- Audit inputs: published v0.6.0 code (162 original tests passed), exact DSH tag
  `dsh-v0.2.1-rc.2`, published DSH/tools `0.2.1-rc.2` and Cordis `4.0.5`.
  Optional code-index `0.10.1` integration is deferred: no safe measurable test
  selection benefit was established from its heuristic/truncated graph contract.

## Completed validation

| Environment | Actual result |
|---|---|
| Local Windows / Node 22.23.3 | typecheck, **197/197 tests**, build, smoke passed |
| Local Windows / Node 24.19.0 | typecheck, **197/197 tests**, build, smoke passed |
| GitHub Linux × Node 22/24 | all CI steps passed, including 197 tests, exact published DSH API and real AgentLoop demo |
| GitHub Windows × Node 22/24 | all CI steps passed, including 197 tests, exact published DSH API and real AgentLoop demo |
| Actual DSH Web / Windows / Node 24.19.0 | final tgz installed through profile CLI; app startup, real tools and native pwsh scenarios passed |
| Official DSH Desktop rc.2 / Windows / embedded Node 24.21.0 | final tgz installed using bundled CLI; actual app, real tools and native pwsh scenarios passed |

[Runtime-source CI](https://github.com/lemonxiny55/dsh-lint-loop/actions/runs/39249462133)
and [captured job/step results](ci.json). Local actual command outputs are in
[Node 22](node22.json) and [Node 24](node24.json). No tests are disabled or skipped
to satisfy the gate. The final evidence commit also runs the full PR CI.

The suite covers real shell/bash/pwsh success, nonzero failure and cancellation;
new/deleted/renamed/cross-directory files; pre-existing dirty bytes; same-target
and other-target concurrent writers; audit-to-verification races; real OS ACL
denial; symlinks; Git/non-Git roots; actual Git worktrees; owner isolation; timeout,
byte/entry/event/reason budgets; final tool policy failures; turn/end and dispose.

The published DSH AgentLoop uses real file tools plus ESLint `10.12.0`, TypeScript
`6.0.3` and Vitest `4.1.11`. Its input is a **deterministic scripted model adapter**,
not a live model. Check outputs, files and processes are real. Both actual apps
produced regression → regression → clean while preserving three historical debts.
All three native pwsh cases retained actual file effects and returned **incomplete**,
including the successful command; an exit code cannot establish confinement.

| Inspect | Web | Desktop |
|---|---|---|
| First regression | [receipt](web/initial.json) | [receipt](desktop/initial.json) |
| After safe lint repair | [receipt](web/after-lint-repair.json) | [receipt](desktop/after-lint-repair.json) |
| Final clean and old debt | [receipt](web/final.json) | [receipt](desktop/final.json) |
| Native shell success | [evidence](web/shell-success.json) | [evidence](desktop/shell-success.json) |
| Native shell failure | [evidence](web/shell-failure.json) | [evidence](desktop/shell-failure.json) |
| Native shell cancellation | [evidence](web/shell-cancelled.json) | [evidence](desktop/shell-cancelled.json) |
| Runtime acceptance/log | [record](web/acceptance.json), [log](web/host.log) | [record](desktop/acceptance.json), [log](desktop/host.log) |
| Original identity restored | [proof](web/integrity.json) | [proof](desktop/integrity.json) |

Desktop acceptance used an isolated extraction of the official installer payload,
an isolated DSH_HOME and Electron user-data directory; it did not replace the
user's system installation. Installer SHA512 matched the official nightly feed.
Agent handles disposed normally. The acceptance supervisor then stopped its own
application process tree; this is not a claim of graceful whole-app shutdown.
Full Desktop/Web application acceptance was on Windows; Linux host APIs and real
AgentLoop/check processes were exercised by CI, not a Linux GUI session.

## Identity, performance and limits

[Provenance](provenance.json) records 64 normalized source/config/test/script
identities, the additional benchmark builder, official installer identity, tgz
SHA256 and matching production/installed bundle hashes for both hosts. The bundle
SHA256 is `1554b0cab8e729bbdb2c099538c159253fcd725e984da725721b1666c1adc4e1`.
The [package manifest](package-manifest.json) contains npm's actual pack integrity
and file list. These are inspectable records, not signed attestations.

The [reproduction guide](../../evidence-demo.md) builds and runs the experiments.
Final Windows/Node 24 repeated 1000-file edit medians: v0.6 **0.96ms**, final
single-reader comparison **968.42ms**, final four-reader candidate **398.64ms**.
Four readers reduce same-source serial cost by about **59%**. The candidate is
still slower than v0.6 because it inventories source content; no overall speedup
over v0.6 is claimed. [Raw samples](benchmark-node24.json) retain all variability.
Baseline promises are shared once per turn; full completion checks are rerun.

The existing workspace `.git` link points to a missing old checkout and was
preserved. Separate clones and authenticated GitHub commits were used. Tracking
and baseline capture never reset, stash, rewind or restore user files. Real
permission tests alter only newly created disposable fixtures. Earlier CI failures
(Windows path aliases, early pwsh cancellation and npm 10 `edgesOut`) were fixed
and rerun; failed installations were never counted as successful demos. CI pins
npm `11.17.0` for auxiliary installs while retaining both Node runtime versions.
Profile installation still emits the existing missing-peer warning; actual host
core service resolution and runtime operation passed.

Read the [architecture and blind spots](../../evidence-integrity.md): endpoint
scans cannot see transient write/revert operations, prove OS-exclusive ownership
or confine general/background scripts. Excluded trees, dependencies and environment
remain outside the content digest. Portable path checks are not atomic, and kernel
filesystem calls can exceed cooperative deadlines. Unsupported/missing checks,
uncertain attribution, symlinks, denied reads and exhausted budgets remain explicit
**incomplete**, never a misleading CLEAN. These are scoped candidate limits, not
claims of universal filesystem or CI coverage.
