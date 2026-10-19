# Reproduce the Evidence Integrity demo

All commands below run from the repository root. Use Node 22 or 24. No npm
publication, Release or merge is needed.

Use npm 11.17.0 for the auxiliary installs below (CI pins it explicitly). The
Node 22 bundled npm 10.9.9 crashed with `edgesOut` on the demo dependency graph;
that installation failure was not counted as a passing demo. Node runtime tests
still execute separately on Node 22 and 24.

```sh
pnpm install --frozen-lockfile
pnpm build
node scripts/prepare-demo-dependencies.mjs
npm install --prefix .cache/dsh021 @deepseek-ai/dsh@0.2.1-rc.2 @deepseek-ai/dsh-tools@0.2.1-rc.2 @deepseek-ai/cordis@4.0.5 --no-audit --no-fund
npm install --prefix .cache/demo-v070 eslint@10.12.0 typescript@6.0.3 vitest@4.1.11 --no-audit --no-fund
node scripts/check-dsh-api.mjs
node scripts/dsh-runtime-demo.mjs
```

This mounts the published real Cordis services, AgentLoop, session projections,
workingDirectory and DSH file tools. Model input comes from a deterministic
scripted adapter, explicitly not a live model request. Every edit, observation,
tool outcome, turn event, linter, compiler and test process is real. A divergent
lifecycle, tool error or unexpected verdict fails the script after saving results.

The newly created fixture starts with an old unused variable, an old type error,
an old failing assertion, an unrelated passing test and pre-existing dirty bytes.
The Agent introduces a type/test regression and a missing semicolon, verifies,
performs bounded lint repair, verifies again, repairs only its new value and
verifies. Actual expected sequence:

| Step | lint | types | tests | Final |
|---|---|---|---|---|
| New string and missing semicolon | regression | regression | regression | regression |
| Safe lint repair | clean | regression | regression | regression |
| Agent restores its value | clean | clean | clean | clean |

The final receipt retains all three historical debts. Original legacy source,
test bytes and dirty bytes are asserted unchanged. The fixture is deliberately
retained for inspection; the driver disposes its real Agent and host Context.
Results are saved under `.cache/runtime-demo/results.json`.

In the actual Web/Desktop app, the driver mounts the published `standard`
preset through its public setup API. It disables only the isolated profile's
auxiliary title-model request, so that request cannot consume the deterministic
response script. It reads before editing and re-reads after the external linter
fix, honoring the real filesystem observation/stale-version policy.

Real shell/bash/pwsh success, nonzero failure and cancellation run in
`tests/evidence.spec.ts`, together with delete/add/rename, actual Git worktrees,
permissions, symlink and external-writer cases. General execution receipts are
expected to remain incomplete even when supported checks pass.

For an actual Web or Desktop profile acceptance run, first pack the built
candidate and install it using that host's `dsh plugin` command under an isolated
`DSH_HOME`. `node scripts/prepare-host-demo.mjs web` (or `desktop`) creates an
isolated overlay and driver. The overlay runs the same deterministic-input
AgentLoop experiment inside the actual app after service activation. It writes
results under `.cache/host-demo-<host>/output/`, not fabricated screenshots.
Desktop uses its own bundled CLI; npm's CLI deliberately cannot manage the
reserved Desktop profile. Use a distinct Electron `--user-data-dir` as well as
an isolated DSH_HOME.

For performance and complete local verification:

```sh
node scripts/verify-candidate.mjs .cache/verification.json
node scripts/benchmark-evidence.mjs /absolute/path/v060/dist/index.js dist/index.js
```

The benchmark prints raw JSON after one warmup and five samples. Build the
baseline from v0.6.0 in a separate checkout. Never reset or stash a user checkout
to manufacture a baseline. See the [verification record](release-evidence/v0.7.0/verification.md)
for which host installations and matrix jobs were actually executed.
