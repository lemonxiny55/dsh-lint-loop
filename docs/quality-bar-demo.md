# Quality Bar UI audit and future capture guide

v0.6 exposes Quality Receipts through ordinary DSH tool results. It does **not**
ship a dedicated desktop/Web Quality Bar or a dashboard.

The installed DSH 0.2.0-rc.2 tools README states that Host-local
`presentCall` / `presentResult` descriptors are not consumed by the built-in
Web Client. That client selects renderers with `tool.call.toolview` and derives
props from raw durable events and metadata. The original plan assumed Host
presenters were enough; real desktop inspection corrected that assumption.
The pure Host adapters remain useful to consumers of that contract, but their
unit tests do not demonstrate a desktop UI. No screenshot or GIF is presented
as proof of an implemented bar.

A future version can add a public client renderer/resource integration once
its compatibility and lifecycle are verified. It should retain a compact
running / clean / regression / failed line, changed-file count, lint/type/test
statuses and an expandable receipt. Keep it scoped to the quality loop.

Future capture sequence:

1. Use an isolated project with real eslint, TypeScript and Vitest/Jest and
   pre-existing lint/type/test debt.
2. Introduce new regressions in one tested module; display its regression
   receipt and affected-test selection.
3. Run safe lint repair, then fix only the new type/test regressions.
4. Display the clean receipt while the three historical debts remain visible.
5. Crop an actual client capture to about 1200x700. An 8-15s GIF may show
   running -> regression -> expanded receipt -> clean. Exclude unrelated
   conversations, account details and credentials. Label real runner and mode.

Suggested assets after actual client implementation: `docs/media/quality-bar.png`
and `docs/media/quality-loop.gif`. A mockup or a test-rendered Host presenter is
not a screenshot of a working DSH Quality Bar.
