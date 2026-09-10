// The suite spawns and kills linter child processes (timeout tests kill
// mid-flight). Stream errors from killed children are surfaced by the
// runner's own handlers; anything else must still be loud, not swallowed.
process.on('unhandledRejection', (reason) => {
  console.error('[dsh-lint-loop test] unhandled rejection:', reason)
})
