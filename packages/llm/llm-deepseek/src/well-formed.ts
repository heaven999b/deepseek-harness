/**
 * Replace lone UTF-16 surrogates before request JSON reaches the Messages endpoint, which rejects
 * a body whose `\udXXX` escapes encode an unpaired surrogate.
 */

function wellFormedValue(value: unknown): unknown {
  if (typeof value === 'string') return value.toWellFormed()
  if (Array.isArray(value)) return value.map(wellFormedValue)
  return typeof value === 'object' && value !== null ? wellFormedObject(value) : value
}

/**
 * Copy a JSON object with each lone surrogate in member names and strings replaced by U+FFFD.
 * @param value - JSON object; nested arrays and objects are copied and other values are kept.
 * @returns a copy whose member names and strings are well-formed; well-formed input yields an equal copy.
 */
export function wellFormedObject(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]): [string, unknown] => [key.toWellFormed(), wellFormedValue(item)]))
}
