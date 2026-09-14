/**
 * Error taxonomy. Every error carries a model-friendly message — tools catch
 * them and return the message as text; nothing ever throws to the model raw.
 */

import { LINTER_SPECS, type LinterKey } from './linters.js'
import { SUPPORTED_EXTENSIONS } from './linters.js'

export class MissingLinterError extends Error {
  constructor(readonly linter: LinterKey, stderrTail: string) {
    const spec = LINTER_SPECS[linter]
    super(
      `linter "${spec.displayName}" is not installed or failed to run. Install it with: ${spec.installHint}`
        + (stderrTail.trim() ? `\nlinter said: ${stderrTail.trim().split('\n').slice(-3).join('\n')}` : ''),
    )
    this.name = 'MissingLinterError'
  }
}

export class NoConfigError extends Error {
  constructor(root: string, detected: string[]) {
    const hints = detected.length > 0
      ? `Detected: ${detected.join(', ')}. `
      : 'No linter configuration found. '
    super(
      `no usable linter configuration in ${root}. ${hints}` +
        'Initialize one to activate dsh-lint-loop: npx eslint --init (JS/TS), biome init, ruff (Python, add [tool.ruff] to pyproject.toml), a .golangci.yml (Go), or a Cargo.toml (Rust — clippy ships with the toolchain).',
    )
    this.name = 'NoConfigError'
  }
}

export class UnsupportedFileError extends Error {
  constructor(ext: string) {
    super(
      `no linter for "${ext || 'this file type'}" — supported: ${SUPPORTED_EXTENSIONS.join(' ')}`,
    )
    this.name = 'UnsupportedFileError'
  }
}

export class LinterTimeoutError extends Error {
  constructor(readonly linter: LinterKey, timeoutMs: number) {
    super(
      `linter "${linter}" timed out after ${Math.round(timeoutMs / 1000)}s and was killed — `
        + 'retry, or raise the timeoutMs config if the linter is genuinely slow.',
    )
    this.name = 'LinterTimeoutError'
  }
}

export class ParseError extends Error {
  constructor(readonly linter: LinterKey, detail: string) {
    super(
      `could not parse "${linter}" JSON output — the installed version may differ from the supported shape.`
        + (detail.trim() ? `\nraw output tail: ${detail.trim().slice(-300)}` : ''),
    )
    this.name = 'ParseError'
  }
}
