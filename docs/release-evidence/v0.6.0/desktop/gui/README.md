# Native desktop GUI smoke — 2026-10-08

This additional smoke used Computer Use mouse/keyboard input in the actual DSH
desktop window. It did not create or prompt the conversation through the localhost
API. DSH was already installed and the local plugin was already enabled.

In the desktop-quality-smoke workspace, we clicked New Conversation, typed a
task and clicked Send. The task asked the agent to read src/a.js, append one blank
line using edit, run quality_verify and then quality_receipt. The agent used
exactly read, edit, read, quality_verify and quality_receipt and completed normally
after DSH automatically retried transient model rate limits. The UI showed a
duration of 1 minute 9 seconds.

We expanded the completed execution group and quality_receipt tool output in
the conversation. Clicking View opened the native trajectory event detail.
The Results tab rendered a JSON tree; expanding selection showed dependency
strategy, tests/a.test.js and complete: true. All three clean statuses, the new
regression list and historical debt were available in the receipt. This is DSH's
ordinary result viewer, not a dedicated Quality Bar.

[Verification output](51-quality_verify.json) and
[saved receipt](71-quality_receipt.json) are identical: changedFiles only src/a.js,
zero new regressions, three ignored historical debts, all three checks complete,
lint/typecheck/tests and finalVerdict clean. Current tests executed only the a and
historical cases in tests/a.test.js; the baseline also executed tests/b.test.js.
Verification elapsedMs is 1007; repairRounds and continuationRounds are zero.

[Selected completion evidence](completion.json) excludes model reasoning and
credentials. [Fixture integrity](integrity.json) verifies the only source/test
mutation was one trailing blank line. After capturing the receipt, fixture
teardown restored that exact blank line directly and verified original bytes;
this teardown is not an agent repair or another validation round. The independently
installed code-index plugin updated its own cache; that is outside this agent's
tracked source/test mutation and is not a dependency of dsh-lint-loop.

A private, unmodified screenshot of the native result viewer is saved locally at
`.cache/gui-smoke/receipt-details.jpg`. It is not included in public release
evidence because the surrounding desktop conversation/account UI is visible.
No mockup is presented as an implemented Quality Bar.

This smoke covers initiating a task, actual plugin execution, completion display,
expanding ordinary tool output and the native result viewer. It does not cover
fresh installation, disable/enable UI, accessibility or a dedicated Quality Bar.
