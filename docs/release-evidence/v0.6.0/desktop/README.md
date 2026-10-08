# Live desktop acceptance evidence

These are actual quality-tool receipts and selected lifecycle events from our
isolated DSH 0.2.0-rc.2 desktop sessions. Full conversations, model reasoning,
account details and credentials are excluded.

## Passing tool acceptance

`rc/28-quality_verify.json`: three new regressions and three old debts.
`rc/52-quality_verify.json`: safe lint repair removed only the new semicolon;
two new type/test regressions remain; agentFixed is empty.
`rc/105-quality_verify.json` and `rc/122-quality_receipt.json`: final clean,
three ignored old debts, one auto-fixed lint issue, two agent-fixed issues,
one repair round, changedFiles only src/a.js, tests only tests/a.test.js.
The full acceptance turn completed normally despite transient model rate limits.

`resumed/188-quality_receipt.json` records successful recovery of the previously
interrupted task. Restarted state correctly does not claim prior-turn repairs.

Real fixture dependencies are ESLint 10.12.0, TypeScript 6.0.3 and Vitest 4.1.11.
Legacy lint/type/test failures remain unchanged. The unrelated b test is not
selected by completion checks. All receipt commands and scopes are retained.

## Earlier failure evidence and fixes

The first three runs (numbered JSON files in this directory) had unrecognized
TypeScript evidence and correctly remained incomplete. They used custom fixture
entry wrappers. Electron self-spawn now explicitly requests supported Node mode;
formal packages in the fixture produce recognized desktop evidence. The custom
wrapper discrepancy is not advertised as a verified supported scenario.

`diagnostic/` and `final/` retain the later diagnostic/partial tool evidence.
Model 429 errors ended those turns; they are not passing completion evidence.
Those errors exposed stale turn accounting, fixed by the durable turn/end
listener. Trailing-semicolon normalization fixes false type-error repair counts.

`gate-source-error.json` records a real automatic gate detecting and steering
for a new test failure, followed by DSH v4 rejecting the retired generic plugin
source kind. The fix uses producer-owned source kind dsh-lint-loop. The poisoned
acceptance session is left as failure evidence; no durable history was rewritten.
A fresh session is used for the fixed automatic-checkpoint test.

`gate-events.json` records its accepted producer-owned steer and completed
turn. `gate/95-quality_receipt.json` is the final saved checkpoint receipt:
clean, one continuation, one agent-fixed test regression, three historical
debts retained. No explicit quality_verify was used in that gate test.
`fixture-integrity.json` records byte-for-byte source/test preservation.

## Additional native GUI smoke

The [GUI smoke](gui/README.md) was initiated with native mouse/keyboard input:
New Conversation, task entry and Send. The installed plugin completed a real
read/edit/quality_verify/quality_receipt turn. Both receipts are clean, with zero
new regressions and three retained historical debts. We expanded the tool output,
clicked View and inspected the native trajectory Results JSON tree, including
the impacted-test selection. A private actual screenshot is retained locally.
Fresh installation and plugin toggle flows were not exercised.

## Matrix and UI boundary

`node22-rc.log` and `node24-rc.log` record the final complete 162-test matrix,
frozen install, typecheck, build and both DSH API compatibility smokes. Temporary
Node 22 executables were removed after verification; system Node is unchanged.
`pack-rc.json` records an npm pack dry run, not publication.

The installed tools README says built-in Web Client does not consume Host
presentCall/presentResult values. A dedicated desktop/Web Quality Bar is deferred;
plain structured tool output remains available. Presenter contract tests and
mockups are not passed off as live UI screenshots. No system ACL repair was made.
