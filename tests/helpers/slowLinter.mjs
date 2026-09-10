// Sleeps 30s, then would print JSON — the runner's timeout kills it first.
setTimeout(() => {
  console.log('{"too":"late"}')
}, 30_000)
