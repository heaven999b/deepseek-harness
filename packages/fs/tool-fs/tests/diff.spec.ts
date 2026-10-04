/**
 * Unit tests for the result-time contextual-diff computation (`src/diff.ts`):
 * the pure before/after → {@link FileDiff}[] hunk builder and the defensive
 * `meta` narrowing. These pin the exact hunk reconstruction (context lines,
 * multi-hunk replaceAll, pure insertion/deletion, no-op) that UIs render.
 */

import { describe, expect, it } from 'vitest'
import { computeHunkDiffs, diffsFromMeta, DIFF_CONTEXT, DIFF_TIMEOUT_MS } from '../src/diff.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line${i + 1}`).join('\n') + '\n'

/** A budget large enough that the small comparisons in these tests always complete. */
const AMPLE_MS = 5_000

describe('computeHunkDiffs', () => {
  it('a single-line change yields one hunk with ±context lines on both sides', () => {
    const before = lines(8)
    const after = before.replace('line4', 'CHANGED')
    const diffs = computeHunkDiffs('f.txt', before, after, AMPLE_MS)
    expect(diffs).toEqual([{
      path: 'f.txt',
      oldText: 'line1\nline2\nline3\nline4\nline5\nline6\nline7',
      newText: 'line1\nline2\nline3\nCHANGED\nline5\nline6\nline7',
    }])
  })

  it('a scattered replace_all yields one FileDiff PER hunk (matching per-site editor blocks)', () => {
    const before = lines(20)
    const after = before.replace('line3', 'A').replace('line16', 'B')
    const diffs = computeHunkDiffs('f.txt', before, after, AMPLE_MS)
    expect(diffs).toHaveLength(2)
    expect(diffs[0]?.path).toBe('f.txt')
    expect(diffs[0]?.oldText).toContain('line3')
    expect(diffs[0]?.newText).toContain('A')
    expect(diffs[1]?.oldText).toContain('line16')
    expect(diffs[1]?.newText).toContain('B')
    // The two hunks are distinct sites, not one merged block.
    expect(diffs[0]?.newText).not.toContain('B')
    expect(diffs[1]?.newText).not.toContain('A')
  })

  it('identical before/after (a no-op) yields no hunks', () => {
    expect(computeHunkDiffs('f.txt', 'same\n', 'same\n', AMPLE_MS)).toEqual([])
  })

  it('a pure insertion into empty content reports oldText null (nothing to diff against)', () => {
    const diffs = computeHunkDiffs('f.txt', '', 'brand new\n', AMPLE_MS)
    expect(diffs).toEqual([{ path: 'f.txt', oldText: null, newText: 'brand new' }])
  })

  it('a pure deletion of the whole file reports newText empty', () => {
    const diffs = computeHunkDiffs('f.txt', 'gone\n', '', AMPLE_MS)
    expect(diffs).toEqual([{ path: 'f.txt', oldText: 'gone', newText: '' }])
  })

  it('drops the "\\ No newline at end of file" marker from a no-trailing-newline change', () => {
    const diffs = computeHunkDiffs('f.txt', 'x', 'y', AMPLE_MS)
    // The marker line (starting with "\\") must never leak into a diff block.
    expect(diffs).toEqual([{ path: 'f.txt', oldText: 'x', newText: 'y' }])
    expect(diffs[0]?.oldText).not.toContain('\\')
    expect(diffs[0]?.newText).not.toContain('\\')
  })

  it('uses DIFF_CONTEXT (3) surrounding lines', () => {
    expect(DIFF_CONTEXT).toBe(3)
    const before = lines(20)
    const after = before.replace('line10', 'CHANGED')
    const [diff] = computeHunkDiffs('f.txt', before, after, AMPLE_MS)
    // 3 context above (7,8,9) + the change + 3 below (11,12,13) = 7 lines a side.
    expect(diff?.oldText?.split('\n')).toHaveLength(7)
    expect(diff?.newText.split('\n')).toHaveLength(7)
    expect(diff?.oldText?.split('\n')[0]).toBe('line7')
  })

  it('degrades to no hunks when the comparison exceeds the timeout', () => {
    // A near-total rewrite of a large file is near-quadratic. With a 1 ms budget
    // the comparison cannot complete on any machine, so it must return no hunks
    // quickly instead of blocking the host thread for seconds. (Before the fix,
    // the untimed comparison ran to completion and returned hunks after seconds.)
    const before = lines(4_000)
    const after = Array.from({ length: 4_000 }, (_, i) => `rewritten-${i}-${(i * 2654435761) % 1000}`).join('\n') + '\n'
    const started = performance.now()
    expect(computeHunkDiffs('f.txt', before, after, 1)).toEqual([])
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('still computes full hunks for the same rewrite under an ample budget', () => {
    const before = lines(400)
    const after = before.replace('line200', 'CHANGED')
    expect(computeHunkDiffs('f.txt', before, after, AMPLE_MS)).not.toEqual([])
  })

  it('exposes a positive default timeout', () => {
    expect(Number.isInteger(DIFF_TIMEOUT_MS)).toBe(true)
    expect(DIFF_TIMEOUT_MS).toBeGreaterThan(0)
  })
})

describe('diffsFromMeta (defensive narrowing)', () => {
  // The narrowing accepts an opaque JsonValue; a malformed payload is not a
  // statically-valid JsonValue, so route every case through one cast helper that
  // mirrors how a hand-edited/older session log delivers arbitrary shapes.
  const m = (value: unknown): JsonValue | undefined => value as JsonValue | undefined
  const good = { diffs: [{ path: 'f.txt', oldText: 'a', newText: 'b' }] }

  it('narrows a well-formed { diffs } payload', () => {
    expect(diffsFromMeta(m(good))).toEqual(good.diffs)
  })

  it('accepts a diff whose oldText is null (a create-style hunk)', () => {
    const meta = { diffs: [{ path: 'f.txt', oldText: null, newText: 'x' }] }
    expect(diffsFromMeta(m(meta))).toEqual(meta.diffs)
  })

  it('rejects undefined / non-object / array meta', () => {
    expect(diffsFromMeta(undefined)).toBeUndefined()
    expect(diffsFromMeta(null)).toBeUndefined()
    expect(diffsFromMeta(m('nope'))).toBeUndefined()
    expect(diffsFromMeta(m([]))).toBeUndefined()
  })

  it('rejects a missing / empty / non-array diffs field', () => {
    expect(diffsFromMeta(m({}))).toBeUndefined()
    expect(diffsFromMeta(m({ diffs: [] }))).toBeUndefined()
    expect(diffsFromMeta(m({ diffs: 'x' }))).toBeUndefined()
  })

  it('rejects a diffs array containing a malformed entry', () => {
    expect(diffsFromMeta(m({ diffs: [{ path: 'f.txt', oldText: 'a' }] }))).toBeUndefined()
    expect(diffsFromMeta(m({ diffs: [{ path: 1, oldText: 'a', newText: 'b' }] }))).toBeUndefined()
    expect(diffsFromMeta(m({ diffs: [{ path: 'f', oldText: 5, newText: 'b' }] }))).toBeUndefined()
    expect(diffsFromMeta(m({ diffs: [{ path: 'f', oldText: 'a', newText: 7 }] }))).toBeUndefined()
    expect(diffsFromMeta(m({ diffs: [null] }))).toBeUndefined()
    expect(diffsFromMeta(m({ diffs: ['x'] }))).toBeUndefined()
    expect(diffsFromMeta(m({ diffs: [[]] }))).toBeUndefined()
  })
})
