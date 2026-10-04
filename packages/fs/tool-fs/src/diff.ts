/**
 * Result-time contextual diff presentation for write and edit. Storage returns before/after
 * text; this model-facing layer derives one three-line-context card per applied hunk.
 * @module @deepseek-ai/dsh-tool-fs/src/diff
 */

import { structuredPatch } from 'diff'
import type { FileDiff } from '@deepseek-ai/dsh-tools'

/** Context lines shown on each side of an applied hunk. */
export const DIFF_CONTEXT = 3

/**
 * Default milliseconds the result-card line diff may run (the `diffTimeoutMs`
 * config). Myers diff is O(N*D), so overwriting or rewriting a large file is
 * near-quadratic; without a budget it runs synchronously on the single host
 * thread for seconds to minutes, freezing every session. A comparison that
 * exceeds the budget degrades to no hunks, and the tools fall back to a
 * whole-file (`write`) or generic (`edit`) card. 100 ms comfortably covers a
 * normal targeted edit, whose edit distance is tiny; only a near-total rewrite
 * reaches it. Mirrors `@deepseek-ai/dsh-workspace-changes`'s `diffTimeoutMs`.
 */
export const DIFF_TIMEOUT_MS = 100

/**
 * The `write`/`edit` tools' private `tool/result` `meta` payload: the applied
 * contextual-diff hunks, and for `write` whether the call created or updated
 * the file, which tells an empty hunk list of a create from one of an
 * unchanged overwrite. Attached opaquely (as `unknown`) on the tool result and
 * persisted with the session log — it must be JSON-serializable (the session
 * validates this at `append`), so `presentResult` reproduces the diff card on
 * replay. The producing tool owns and narrows this opaque shape.
 */
export type FsDiffMeta = { diffs: FileDiff[]; operation?: 'create' | 'update' }

/**
 * Compute one {@link FileDiff} per hunk between `before` and `after`, each carrying the
 * applied change plus {@link DIFF_CONTEXT} context lines. Pure insertions use `oldText: null`,
 * patch-only no-newline markers are omitted, and scattered replacements remain separate hunks.
 *
 * The line comparison is bounded by `timeoutMs`: a comparison that exceeds it yields no hunks,
 * the same result as identical texts, so a near-total rewrite of a large file cannot freeze the
 * host thread. The empty result degrades to a whole-file (`write`) or generic (`edit`) card.
 *
 * @param path - the path stamped on every produced diff (the model-facing `file_path`; the
 *   bridge relativizes it).
 * @param before - the file text before the change (the backend's LF-normalized diff basis).
 * @param after - the file text after the change, on the same basis.
 * @param timeoutMs - milliseconds the line comparison may run before it degrades to no hunks.
 * @returns one diff per applied hunk, in file order; empty when the texts are identical or the
 *   comparison timed out.
 */
export function computeHunkDiffs(path: string, before: string, after: string, timeoutMs: number): FileDiff[] {
  const patch = structuredPatch('', '', before, after, undefined, undefined, { context: DIFF_CONTEXT, timeout: timeoutMs })
  // A timed-out comparison returns undefined; treat it as no hunks so the card degrades.
  if (patch === undefined) return []
  const diffs: FileDiff[] = []
  for (const hunk of patch.hunks) {
    const oldLines: string[] = []
    const newLines: string[] = []
    for (const line of hunk.lines) {
      // The unified-diff marker for a missing trailing newline annotates the
      // patch, not the content — skip it so it never leaks into a diff block.
      if (line.startsWith('\\')) continue
      const text = line.slice(1)
      if (line.startsWith('-')) {
        oldLines.push(text)
      } else if (line.startsWith('+')) {
        newLines.push(text)
      } else {
        // A context (unchanged) line appears on both sides.
        oldLines.push(text)
        newLines.push(text)
      }
    }
    diffs.push({ path, oldText: oldLines.length > 0 ? oldLines.join('\n') : null, newText: newLines.join('\n') })
  }
  return diffs
}

/** Whether `value` is a valid {@link FileDiff} (defensive narrowing from opaque `meta`). */
function isFileDiff(value: unknown): value is FileDiff {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, oldText, newText } = value as Record<string, unknown>
  return typeof path === 'string'
    && (oldText === null || typeof oldText === 'string')
    && typeof newText === 'string'
}

/**
 * Narrow opaque live or replayed result metadata to non-empty file diffs. Malformed metadata
 * returns `undefined` so presentation can fall back instead of throwing during replay.
 * @param meta - result metadata.
 * @returns validated hunks, or `undefined` for absent or malformed data.
 */
export function diffsFromMeta(meta: unknown): FileDiff[] | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs) || diffs.length === 0 || !diffs.every(isFileDiff)) return undefined
  return diffs
}

/**
 * Read the operation's file path even when the applied diff is empty.
 * @param meta - opaque persisted result metadata.
 * @returns the recorded path, or undefined for old or malformed metadata.
 */
export function pathFromMeta(meta: unknown): string | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const path = (meta as Record<string, unknown>).path
  return typeof path === 'string' && path.length > 0 ? path : undefined
}
