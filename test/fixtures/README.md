# Executable fixtures

`codex/` is an independently written JSONL fake Codex. It never invokes another CLI or a model.
`test/support/codex-fixture.mjs` supplies private workspace, state, controls, history and traffic capture.
`runner-fixture.mjs` derives shared task observations from that actual traffic and supplies deterministic waits.

Controls include version, startup/method delays, hangs, crashes, stdin behavior, turn status/text/items,
usage, rate limits and every server-to-client request. A private history file supports cold resume and client-ID recovery.
The fake can edit a configured workspace file for Git delivery tests. Its private lifetime file ends every fake at teardown.
Runtime suites keep driver identities and held handles; no test terminates a process by bare PID.

`hermetic-clone.test.mjs` is the one test of the clone `test/hermetic.test.mjs` plants in a temporary profile's `.claude` folder.
It passes only there: the filesystem guard lets the clone read its own tree and refuses the folders above and beside it.

`role-rendering.json` records the unchanged public roles/display names and reviewed template hashes at fixed placeholder paths.
Update hashes only after an intentional installed-content change. The equality test catches unrelated rendering drift.
