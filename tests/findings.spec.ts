import { describe, expect, it } from 'vitest'
import {
  capFindings,
  findingKey,
  filterFindings,
  renderFindings,
  sortFindings,
  type Finding,
} from '../src/findings.js'

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    rule: 'no-unused-vars',
    file: 'src/a.ts',
    line: 3,
    col: 10,
    endLine: 3,
    endCol: 15,
    severity: 'error',
    message: "'x' is defined but never used",
    fixable: false,
    linter: 'eslint',
    ...overrides,
  }
}

describe('findingKey', () => {
  it('is stable across identical findings and differs on position', () => {
    expect(findingKey(finding())).toBe(findingKey(finding()))
    expect(findingKey(finding())).not.toBe(findingKey(finding({ line: 4 })))
    expect(findingKey(finding())).not.toBe(findingKey(finding({ message: 'other' })))
  })
})

describe('filterFindings', () => {
  const findings = [
    finding({ severity: 'error' }),
    finding({ severity: 'warning' }),
    finding({ severity: 'info' }),
  ]

  it('filters by severity', () => {
    expect(filterFindings(findings, 'error')).toHaveLength(1)
    expect(filterFindings(findings, 'warning')).toHaveLength(1)
    expect(filterFindings(findings)).toHaveLength(3)
  })
})

describe('sortFindings', () => {
  it('sorts errors first, then warnings, then info, by file/line/col', () => {
    const sorted = sortFindings([
      finding({ file: 'b.ts', severity: 'error', line: 9, message: 'e2' }),
      finding({ severity: 'warning' }),
      finding({ line: 2, message: 'e1' }),
      finding({ severity: 'info', message: 'fyi only' }),
    ])
    // b.ts sorts before src/a.ts within the error band.
    expect(sorted.map((f) => f.message)).toEqual(['e2', 'e1', "'x' is defined but never used", 'fyi only'])
  })
})

describe('capFindings', () => {
  it('caps and reports the dropped count', () => {
    const findings = [finding(), finding(), finding()]
    expect(capFindings(findings, 2)).toEqual({ result: findings.slice(0, 2), dropped: 1 })
    expect(capFindings(findings, 10).dropped).toBe(0)
  })
})

describe('renderFindings', () => {
  it('matches the documented compact table shape', () => {
    const findings = [
      finding({ fixable: true }),
      finding({
        file: 'src/b.ts', line: 8, col: 5, severity: 'warning', rule: 'semi', message: 'missing semicolon',
      }),
    ]
    expect(renderFindings(findings)).toBe(
      [
        '# lint findings (1 error, 1 warning)',
        "src/a.ts:3:10  error  no-unused-vars  'x' is defined but never used  [fixable]",
        'src/b.ts:8:5   warn   semi            missing semicolon',
      ].join('\n'),
    )
  })

  it('appends a suppression note when findings were dropped', () => {
    expect(renderFindings([finding()], 7)).toContain('(+7 more suppressed')
  })

  it('renders none for an empty list', () => {
    expect(renderFindings([])).toBe('# lint findings (none)')
  })
})
