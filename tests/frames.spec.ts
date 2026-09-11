import { afterEach, describe, expect, it } from 'vitest'
import { clearFrameCache, frameFor, recordFileLines } from '../src/frames.js'

afterEach(() => {
  clearFrameCache()
})

describe('frameFor', () => {
  it('renders context around the finding line with the line marked', () => {
    recordFileLines('src/a.ts', 'const a = 1\nconst b = 2\nconst c = 3\n')
    expect(frameFor('src/a.ts', 2, 1)).toBe(['  1 | const a = 1', '  2 | const b = 2  █', '  3 | const c = 3'].join('\n'))
  })

  it('clamps context at file edges and honours contextLines=0', () => {
    recordFileLines('src/a.ts', 'line one\nline two\n')
    expect(frameFor('src/a.ts', 1, 1)).toBe(['  1 | line one  █', '  2 | line two'].join('\n'))
    expect(frameFor('src/a.ts', 2, 0)).toBe('  2 | line two  █')
  })

  it('returns undefined for uncached files and out-of-range lines', () => {
    expect(frameFor('src/missing.ts', 1, 1)).toBeUndefined()
    recordFileLines('src/a.ts', 'only line\n')
    expect(frameFor('src/a.ts', 9, 1)).toBeUndefined()
    expect(frameFor('src/a.ts', 0, 1)).toBeUndefined()
  })

  it('clearFrameCache drops everything', () => {
    recordFileLines('src/a.ts', 'x\n')
    clearFrameCache()
    expect(frameFor('src/a.ts', 1, 1)).toBeUndefined()
  })

  it('ignores empty relative paths', () => {
    recordFileLines('', 'x\n')
    expect(frameFor('', 1, 1)).toBeUndefined()
  })
})
