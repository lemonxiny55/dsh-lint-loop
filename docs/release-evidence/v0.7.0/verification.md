# v0.7.0 Evidence Integrity candidate verification

Candidate: `0.7.0-rc.0`. Date: 2026-10-19.
Status: **RELEASE CANDIDATE READY** for the documented bounded source scope.
No npm publication, GitHub Release or merge has been performed or authorized.

Optimized runtime source revision: `8ab76d3c00c97ef6501fcd4c5e2725d74a60e219`.
The optimization changes the bounded checkpoint reader count from four to eight.
The PR remains a reviewable draft.

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
| Local Windows / Node 22.23.3 | **197/197 tests** passed; standalone local typecheck was blocked by mismatched DSH/Cordis declarations in the clone |
| Local Windows / Node 24.19.0 | **197/197 tests**, build and compatibility smoke passed; standalone local typecheck was blocked by mismatched DSH/Cordis declarations in the clone |
| GitHub Linux × Node 22/24 | optimized source CI passed (2/2 jobs) |
| GitHub Windows × Node 22/24 | optimized source CI passed (2/2 jobs) |
| Actual DSH Web / Windows / Node 24.19.0 | historical four-reader bundle acceptance; optimized package not installed in the app |
| Official DSH Desktop rc.2 / Windows / embedded Node 24.21.0 | historical four-reader bundle acceptance; optimized package not installed in the app |

The earlier runtime-source CI run [39249462133](https://github.com/lemonxiny55/dsh-lint-loop/actions/runs/39249462133)
and prior [captured job/step results](ci.json) apply to the pre-optimization head.
The optimized runtime commit passed all four matrix jobs in [run 39259992219](https://github.com/lemonxiny55/dsh-lint-loop/actions/runs/39259992219),
with typecheck, tests, build, compatibility smoke, exact published DSH API and real AgentLoop demo in each job; captured details are in [ci-optimization.json](ci-optimization.json).
Local actual command outputs are in
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
identities, benchmark scripts, official installer identity, tgz SHA256 and the
optimized bundle SHA256 `96d57d4c3f4cb053c41aac9fd7d9f657cbaf27466922792a38e18142ec837d5e`.
Web/Desktop acceptance hashes below refer to the prior four-reader bundle
(`1554b0cab8e729bbdb2c099538c159253fcd725e984da725721b1666c1adc4e1`).
The [package manifest](package-manifest.json) contains npm's actual pack integrity
and file list. These are inspectable records, not signed attestations.

The [reproduction guide](../../evidence-demo.md) builds and runs the experiments.
The original 1000-file comparison measured 0.96ms for v0.6 (which did not inventory
file contents), 968.42ms for a one-reader v0.7 variant, and 398.64ms for the
four-reader v0.7 candidate. These are not equivalent feature scopes. The file
inventory must remain complete to detect writes outside the reported tool target,
shell side effects, additions, deletions, renames and concurrent writers. Per-file
identity checks, no-follow opens, stable reads and SHA-256 hashing account for most
of the checkpoint cost. Each checkpoint rehashes the bounded source tree. Metadata-
only cache keys can miss writes, and a watcher cannot reliably establish coverage
for all shell writers. Readers share one reserved byte budget. With `--expose-gc`
and 5ms sampling, 1000-file heap peak median/P95 was 53.54/54.16MB at four readers
and 53.99/54.41MB at eight; shell-batch medians were 53.36MB and 53.38MB. RSS delta
is noisier due to allocator retention and is an observed run value, not an allocation
guarantee.

The evidence comparison and final workspace digest were not performance
bottlenecks. Their implementation was left unchanged. The same-source comparison
increased the fixed reader bound from four to eight. Eight readers improved
1000-file repeated-edit median/P95 from **394.46/400.12ms** to **311.22/315.77ms**;
the shell batch with add/delete/rename improved from **411.39/420.51ms** to
**325.89/348.06ms**. Receipt semantics matched. The candidate remains slower than
v0.6 because it proves substantially more; no overall speedup over v0.6 is claimed.
The 16-reader experiment was faster, but its 1000-file shell batch heap peak was
about **26.6MB** versus **13.3MB** at eight readers, for about 14% additional speed.
We retained eight as the measured performance/memory balance. The reader bound
remains finite and uses the existing byte, file and time budgets.

[Optimized comparison](benchmark-optimization-node24.json) records Windows/Node 24,
one warmup and 20 measured samples, three edits per fixture, a 5ms memory sampler,
and a complete Quality Receipt check after each sample. Receipt fields match after
normalizing workspace paths, timestamps and elapsed durations. It covers 100- and
1000-file fixtures for continuous single-file edits and shell batch edits that
modify ten files, add one, delete one and rename one (reported as delete+add).
Batch receipts remained `incomplete` with changes marked `unattributed`, as
required for a general shell execution. The [eight-versus-sixteen reader exploration](benchmark-reader-limit-exploration-node24.json)
records the memory trade-off. Memory is peak heap/RSS delta sampled after forced GC;
RSS P95 varies with allocator retention and is an observed run result, not a
per-check allocation guarantee. The earlier [raw comparison](benchmark-node24.json)
retains the original five-sample results. Baseline promises are shared once per turn;
full completion checks are rerun.

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
