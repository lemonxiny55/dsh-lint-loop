# v0.6.0 — Quality Loop

**Fix what the agent broke. Ignore what was already broken. Prove the change is clean.**

The regression-aware lint loop now checks the completed change against evidence
captured before the agent's first edit. Historical lint, type and test failures
remain visible without blocking an unrelated task.

- **Two speeds:** fast post-edit lint feedback and safe repair, followed by bounded
  completion checks for lint delta, TypeScript diagnostics and impacted tests.
- **Change-aware tests:** select affected Vitest/Jest tests through reverse
  dependencies and package scope; uncertain relationships broaden the supported
  suite, while missing evidence stays explicitly incomplete.
- **Quality Receipt:** actual commands, executed tests, ignored debt, new
  regressions, automatic/agent repairs, budgets, elapsed time and final verdict.
- **Simple presets:** balanced by default, fast for lint-only work, strict for
  repository package test suites, with advanced overrides retained.

Existing eslint/biome/ruff behavior, configuration and Node 22/24 support remain.
The DSH 0.1.x / 0.2.x peer policy fixed in 0.5.1 is unchanged. Lifecycle handling
covers cancellation and model errors; Electron-hosted compiler/test tools run
in supported Node mode. Repairs preserve historical debt and file scope.

The candidate passed 162 tests on both supported Node lines, real desktop
regression/repair and automatic-gate acceptance, and a native GUI smoke from
task entry to expanding the saved receipt. CI also checks Windows/Linux on
Node 22/24 before this release is finalized.

**UI boundary:** the structured receipt is available through ordinary DSH tool
results and the native event detail viewer. A dedicated Quality Bar is deferred
because the audited client does not consume Host presentation descriptors.
No client injection or mockup is presented as an implemented UI.

Static dependency selection is conservative. Shell/custom edits, deletion,
flaky tests, custom/chained runners, node:test and TypeScript reference builds
remain documented limitations. This release adds no LLM review, requirements,
security/coverage platform, CI replacement or mandatory companion plugin.

```sh
dsh plugin --profile web add dsh-lint-loop@0.6.0
```

[Full verification](https://github.com/lemonxiny55/dsh-lint-loop/blob/v0.6.0/docs/release-evidence/v0.6.0/verification.md)
· [Native desktop GUI smoke](https://github.com/lemonxiny55/dsh-lint-loop/blob/v0.6.0/docs/release-evidence/v0.6.0/desktop/gui/README.md)
