# Explicitly run after authenticating gh. No publishing or release actions.
$ErrorActionPreference = 'Stop'
$metadataPath = Join-Path $PSScriptRoot '../docs/repository-metadata.json'
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
$arguments = @('repo', 'edit', 'lemonxiny55/dsh-lint-loop', '--description', $metadata.description)
foreach ($topic in $metadata.topics) { $arguments += @('--add-topic', $topic) }
& gh @arguments
if ($LASTEXITCODE -ne 0) { throw 'GitHub metadata update failed; authenticate gh and retry.' }
& gh repo view lemonxiny55/dsh-lint-loop --json description,repositoryTopics
if ($LASTEXITCODE -ne 0) { throw 'Metadata readback failed.' }
