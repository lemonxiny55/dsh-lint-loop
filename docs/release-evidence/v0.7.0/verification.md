# v0.7.0 Evidence Integrity candidate verification

Candidate: `0.7.0-rc.0`. Date: 2026-10-19.
Status: **RELEASE CANDIDATE READY** for the documented bounded source scope.
At the time this verification was captured, no npm publication, GitHub Release or merge had been performed.

Optimized runtime source revision: `8ab76d3c00c97ef6501fcd4c5e2725d74a60e219`.
The optimization changes the bounded checkpoint reader count from four to eight.
Final PR review and the four-job matrix remain release gates.

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
to satisfy the gate. The final PR head is gated by the full Windows/Linux × Node 22/24 CI matrix.

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
required for a general shell execution. The performance fixture applies this batch
inside a deterministic `exec` event callback to isolate checkpoint overhead; it does
not include shell child-process startup. Real shell/bash/pwsh behavior is exercised
separately by the test suite and cross-platform CI. The [eight-versus-sixteen reader exploration](benchmark-reader-limit-exploration-node24.json)
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

## Final eight-reader package acceptance (2026-10-20)

The preceding DSH Web/Desktop rows and `web/` / `desktop/` links above are the
**historical four-reader acceptance** for bundle SHA256
`1554b0cab8e729bbdb2c099538c159253fcd725e984da725721b1666c1adc4e1`. They do not
represent the final candidate. The following runs installed the eight-reader
candidate from the exact local npm pack archive and then exercised each real host.
Both app profiles, DSH homes, and Desktop Electron user data were isolated under
`.cache/host-final8`; the user's normal configuration and sessions were not used.

| Item | Final eight-reader candidate |
|---|---|
| PR head inspected before acceptance | `b51c88f63dfbc4d3d2b4d0f8108a5fc9c654d2db` |
| Source implementation | `8ab76d3c00c97ef6501fcd4c5e2725d74a60e219` |
| npm pack file | `dsh-lint-loop-0.7.0-rc.0.tgz`, 128,768 bytes |
| npm archive SHA256 | `acdc28228ca6af5797e4dff4ed73a2e5cd76b4479712627d4632664730e03ae9` |
| npm manifest shasum / SRI | `347933a9e95120fddbd6ea136fdb781c7f5d8e61` / `sha512-0RCoPzoHqhmTFiAT+E+Cxx5vUEThvUjLv3Iy0WOT7dzt5YLBo4f1bVgSRE4ObhFg+vxj5TmNAw6UbRGf5Xbing==` |
| `dist/index.js` SHA256 | `96d57d4c3f4cb053c41aac9fd7d9f657cbaf27466922792a38e18142ec837d5e` (151,520 bytes) |
| Installed Web and Desktop `dist/index.js` | Both match the package bundle SHA256 above |

| Host | Actual app / Node | Lifecycle and result |
|---|---|---|
| DSH Web | DSH `0.2.1-rc.2`, Node `24.19.0` | DSH CLI installed, loaded, uninstalled and reinstalled the local archive; final reload passed. AgentLoop ended normally; supervisor cleaned up the app process. |
| Official DSH Desktop rc.2 | Desktop-bundled DSH `0.2.1-rc.2`, Node `24.21.0` | Official Desktop CLI performed install, load, uninstall and reinstall in its isolated Electron-managed profile; final reload passed. AgentLoop ended normally; supervisor cleaned up the app process. |

The DSH lifecycle, file tools and check processes were real. Only model input was
a deterministic scripted adapter. Each host emitted 20 real DSH events and a
completed `turn/end`. Its four Quality Receipts were `regression`, `regression`,
`clean`, `clean`, all with `complete` evidence coverage and the same three ignored
historical debts. The first two receipts captured newly introduced lint,
typecheck and test failures; the host ran the safe lint repair; final typecheck,
impacted tests and lint were clean. Web/Desktop receipt structures matched after
ignoring host-specific temp roots, timestamps and measured durations.

Each actual Windows host ran native DSH `pwsh` success, exit-7 failure, and
cancellation-after-write cases. All three retained their actual added file, marked
the change `unattributed`, and returned `incomplete` coverage. In particular,
exit 0 did not produce CLEAN. Real bash success/failure/cancellation and file
change assertions are exercised by the Linux CI host tests/jobs; this Windows
Desktop/Web run used the host's native pwsh tool. The deterministic evidence
adapter cannot stand in for a live model, and no live model quality claim is made.

Per-host evidence is retained in [`host-final8/web`](host-final8/web/) and
[`host-final8/desktop`](host-final8/desktop/): package identity, lifecycle record,
full Quality Receipts, full shell result records, concise summaries, host logs,
and completion records. `acceptance.json` records the app executable, Node
runtime, final candidate, verdicts and cleanup. The `.cache` archive itself is
local test input; its recorded SHA256 identifies the exact installed package.

The PR head's full CI run [39262086458](https://github.com/lemonxiny55/dsh-lint-loop/actions/runs/39262086458)
completed successfully on all four Windows/Linux × Node 22/24 jobs (197 tests per
job, typecheck, build and host/API smoke). The final release-candidate head must pass
the same matrix before merge. The stable  .7.0 release archive prepared from
that source is recorded below; publication and merge are still pending.

## Stable release archive prepared from verified source (2026-10-21)

The stable package metadata is `dsh-lint-loop@0.7.0`. It was built on the
release worktree based on PR #8 head `b51c88f63dfbc4d3d2b4d0f8108a5fc9c654d2db`;
the only runtime payload is the same eight-reader `dist/index.js` used by the
Desktop/Web rc.0 acceptance. This separates the tested rc.0 host package identity
from the exact stable archive intended for publication.

| Item | Prepared stable archive |
|---|---|
| Archive | `dsh-lint-loop-0.7.0.tgz` |
| Size | 128,670 bytes |
| SHA256 | `344cedad9d8469436c69d0449c819d05f7f12348275069bab03543fb015d477b` |
| Packed file list | `LICENSE`, `README.md`, `README.zh.md`, `cordis.patch.yml`, `dist/index.js`, `dist/index.js.map`, `package.json` |
| `dist/index.js` | 151,520 bytes; SHA256 `96d57d4c3f4cb053c41aac9fd7d9f657cbaf27466922792a38e18142ec837d5e` |
| Preparation checks | 197/197 tests, typecheck and build passed on Windows / Node 24.19.0 |

`npm pack --ignore-scripts` produced this exact archive after the successful build;
the npm cache was directed to the isolated worktree. The release should publish
this exact archive so the published tarball hash matches the value above. The
Desktop/Web runtime acceptance remains the separately identified rc.0 tarball
(`acdc2822…03ae9`) whose installed bundle hash is identical. Final four-platform
CI, merges and publication are pending; this document does not claim RELEASE READY.