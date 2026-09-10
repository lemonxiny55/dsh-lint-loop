import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBiomeJson, parseEslintJson, parseRuffJson } from '../src/parse.js'
import { ParseError } from '../src/errors.js'

const ROOT = '/repo' // path-only math for eslint/ruff — no fs reads involved

describe('parseEslintJson', () => {
  it('maps eslint results onto 1-based findings with fixable flags', () => {
    const stdout = JSON.stringify([
      {
        filePath: '/repo/src/a.ts',
        messages: [
          {
            ruleId: 'no-unused-vars', severity: 2, line: 3, column: 10,
            endLine: 3, endColumn: 15, message: "'x' is defined but never used",
          },
          {
            ruleId: 'semi', severity: 1, line: 4, column: 1,
            endLine: 4, endColumn: 2, message: 'missing semicolon',
            fix: { range: [10, 10], text: ';' },
          },
        ],
        errorCount: 1,
        warningCount: 1,
      },
    ])
    const findings = parseEslintJson(stdout, ROOT)
    expect(findings).toHaveLength(2)
    expect(findings[0]).toMatchObject({
      rule: 'no-unused-vars', file: 'src/a.ts', line: 3, col: 10,
      severity: 'error', fixable: false, linter: 'eslint',
    })
    expect(findings[1]).toMatchObject({
      rule: 'semi', line: 4, col: 1, severity: 'warning', fixable: true,
    })
  })

  it('maps fatal parse errors onto the eslint/parse rule', () => {
    const stdout = JSON.stringify([
      {
        filePath: '/repo/broken.ts',
        messages: [{ ruleId: null, fatal: true, severity: 2, line: 1, column: 1, message: 'Parsing error' }],
      },
    ])
    expect(parseEslintJson(stdout, ROOT)[0].rule).toBe('eslint/parse')
  })

  it('skips severity-0 entries and tolerates missing fields', () => {
    const stdout = JSON.stringify([
      { filePath: '/repo/a.ts', messages: [{ ruleId: 'x', severity: 0, message: 'off' }, {}] },
    ])
    const findings = parseEslintJson(stdout, ROOT)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ rule: 'eslint', line: 1, col: 1, severity: 'info', message: '' })
  })

  it('raises ParseError on malformed output', () => {
    expect(() => parseEslintJson('not json', ROOT)).toThrow(ParseError)
    expect(() => parseEslintJson('{"object":"not array"}', ROOT)).toThrow(ParseError)
  })
})

describe('parseBiomeJson', () => {
  async function fixtureFile(content: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'biome-parse-'))
    const file = path.join(dir, 'a.ts')
    await writeFile(file, content, 'utf8')
    return file
  }

  it('converts byte-offset spans to 1-based line/col (incl. multibyte prefix)', async () => {
    const content = 'const é = 1\nconst b = 2 // lint marker here\n'
    const file = await fixtureFile(content)
    // Real biome reports spans as byte offsets into the file.
    const markerByte = Buffer.byteLength(content.slice(0, content.indexOf('//')))
    const stdout = JSON.stringify({
      diagnostics: [
        {
          category: 'lint/suspicious/noDebugger',
          severity: 'error',
          description: 'unexpected debugger',
          location: {
            path: { file },
            span: [markerByte, markerByte + 2],
          },
        },
      ],
    })
    const findings = await parseBiomeJson(stdout, ROOT)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      rule: 'lint/suspicious/noDebugger',
      severity: 'error',
      fixable: false,
      linter: 'biome',
      message: 'unexpected debugger',
    })
    expect(findings[0].line).toBe(2)
    expect(findings[0].col).toBe(content.indexOf('//') - content.indexOf('\n') - 1 + 1)
  })

  it('skips format diffs and accepts plain line/column locations as fallback', async () => {
    const file = await fixtureFile('const a = 1\n')
    const stdout = JSON.stringify({
      diagnostics: [
        { category: 'format', severity: 'error', description: 'format diff', location: { path: { file }, span: [0, 5] } },
        {
          category: 'lint/style/useConst', severity: 'warning', description: 'use const',
          location: { path: { file }, start: { line: 1, column: 7 }, end: { line: 1, column: 8 } },
        },
      ],
    })
    const findings = await parseBiomeJson(stdout, ROOT)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ rule: 'lint/style/useConst', line: 1, col: 7, severity: 'warning' })
  })

  it('maps information/hint severities onto info', async () => {
    const file = await fixtureFile('const a = 1\n')
    const stdout = JSON.stringify({
      diagnostics: [
        { category: 'assist/xxx', severity: 'information', description: 'fyi', location: { path: { file }, span: [0, 1] } },
      ],
    })
    expect((await parseBiomeJson(stdout, ROOT))[0].severity).toBe('info')
  })

  it('parses the REAL biome 2.5.12 reporter shape (string path, 1-based start/end)', async () => {
    const file = await fixtureFile('const a = 1\nconst b = 2\n')
    // Verbatim shape from `biome check --reporter=json` on biome 2.5.12:
    // location.path is a CLI-relative STRING and positions are 1-based objects.
    const stdout = JSON.stringify({
      summary: { errors: 1, warnings: 1 },
      diagnostics: [
        {
          severity: 'warning',
          message: 'This variable unusedVariable is unused.',
          category: 'lint/correctness/noUnusedVariables',
          location: {
            path: file,
            start: { line: 1, column: 7 },
            end: { line: 1, column: 21 },
          },
          advices: [],
        },
        {
          severity: 'error',
          message: 'Formatter would have printed the following content:',
          category: 'format',
          location: { path: file, start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
          advices: [],
        },
      ],
      command: 'check',
    })
    const dir = path.dirname(file)
    const findings = await parseBiomeJson(stdout, dir)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      rule: 'lint/correctness/noUnusedVariables',
      severity: 'warning',
      line: 1,
      col: 7,
      endLine: 1,
      endCol: 21,
      message: 'This variable unusedVariable is unused.',
    })
  })

  it('accepts a bare diagnostics array and raises ParseError on garbage', async () => {
    const file = await fixtureFile('const a = 1\n')
    const bare = JSON.stringify([
      { category: 'lint/x/y', severity: 'error', description: 'd', location: { path: { file }, span: [0, 1] } },
    ])
    expect(await parseBiomeJson(bare, ROOT)).toHaveLength(1)
    await expect(parseBiomeJson('garbage {', ROOT)).rejects.toThrow(ParseError)
  })
})

describe('parseRuffJson', () => {
  it('maps ruff messages onto error findings with fixable flags', () => {
    const stdout = JSON.stringify([
      {
        code: 'F401', message: 'os imported but never used', filename: '/repo/mod.py',
        location: { row: 1, column: 8 }, end_location: { row: 1, column: 10 },
        fix: null, noqa_row: 1, url: '',
      },
      {
        code: 'I001', message: 'unsorted imports', filename: '/repo/mod.py',
        location: { row: 2, column: 1 }, end_location: { row: 2, column: 9 },
        fix: { applicability: 'FixApplicability.Safe', edits: [], message: '' },
      },
    ])
    const findings = parseRuffJson(stdout, ROOT)
    expect(findings).toHaveLength(2)
    expect(findings[0]).toMatchObject({
      rule: 'F401', file: 'mod.py', line: 1, col: 8, severity: 'error', fixable: false, linter: 'ruff',
    })
    expect(findings[1].fixable).toBe(true)
  })

  it('raises ParseError on malformed output', () => {
    expect(() => parseRuffJson('[broken', ROOT)).toThrow(ParseError)
  })
})
