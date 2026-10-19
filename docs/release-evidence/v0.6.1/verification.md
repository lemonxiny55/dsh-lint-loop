# v0.6.1 compatibility hotfix candidate

Unreleased `0.6.1-rc.0`. No npm publication, release or merge authorized.

DSH `dsh-v0.2.1-rc.2` (`687f282e8625c6b8d11ff58211a90524be2e4317`)
resolves file tools through `workingDirectory.ensure(agent, signal)`. The
immutable session header retains the original project. v0.6.0 resolved the
quality tools and mutation baselines from that original header after `cd`.

The adapter now reads the optional `workingDirectory.get(session)` projection
at each tool dispatch and binds it to that execution in a WeakMap. No actor,
header, session or workspace file is rewritten. Older hosts retain the header
fallback. A regression switches between two distinct repository fixtures,
checks edit attribution, then resolves lint diagnostics in the new directory.

Actually executed on Windows, Node 24.19.0, 2026-10-19:

- locked dependencies; typecheck; full 163/163 tests; build; compatibility smoke;
- built bundle imported under published DSH tools 0.2.1-rc.2 / Cordis 4.0.5;
- seven tools, six listeners, dispose and remount checked.

The wider shell evidence changes belong to v0.7.0 and are deliberately absent.
Remote Linux/Windows × Node 22/24 CI and real host acceptance remain separate
verification gates; local tests alone do not establish release readiness.
