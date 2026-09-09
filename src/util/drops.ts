/**
 * A6 -- count what never made it into the corpus.
 *
 * Records are dropped in several places on the ingest path, and until now every
 * one of them was silent: `isType()` returned false on any validation failure
 * with no log and no counter, so a record with a malformed `createdAt` -- common
 * from third-party clients -- simply was not there. An unknown exclusion is a
 * description problem before it is an engineering one: the methods section has
 * to be able to say what fraction of the stream was not stored, even if the
 * answer turns out to be zero.
 *
 * Deliberately a module-level counter rather than something threaded through
 * every call site: the drops happen inside static helpers (`isPost`, `isLike`)
 * that have no access to a stream instance, and the number wanted is a corpus
 * total, not a per-stream one. The reason string carries the stream where it
 * matters.
 */

/**
 * Distinct reasons are bounded so that a validator message carrying a value --
 * or a new failure mode arriving on every frame -- cannot grow the map without
 * limit. Anything past the cap is counted under `other`, whose own key is
 * inside the cap rather than one past it.
 */
const MAX_REASONS = 64
const OTHER = 'other'

const counts = new Map<string, number>()
let total = 0

/**
 * Count one dropped record. Returns true the first time a given reason is seen,
 * which is the caller's cue to log it once: the periodic totals carry the
 * volume, so logging every occurrence would only flood the log at exactly the
 * moment it needs to stay readable.
 */
export const recordDrop = (reason: string): boolean => {
  total++
  const key =
    counts.has(reason) || counts.size < MAX_REASONS - 1 ? reason : OTHER
  const seen = counts.get(key) ?? 0
  counts.set(key, seen + 1)
  return seen === 0 && key === reason
}

/**
 * Turn a validation error into a reason string that is stable across records.
 * Lexicon messages name the field and the rule (`Record/createdAt must be a
 * string`), so they group naturally; the truncation is only a guard against a
 * message that quotes the offending value.
 */
export const dropReason = (prefix: string, err: unknown): string => {
  const msg = err instanceof Error ? err.message : String(err)
  return `${prefix}: ${msg.replace(/\s+/g, ' ').trim().slice(0, 120)}`
}

export type DropStats = {
  total: number
  byReason: Record<string, number>
}

export const dropStats = (): DropStats => ({
  total,
  byReason: Object.fromEntries(
    [...counts.entries()].sort((a, b) => b[1] - a[1]),
  ),
})

/** one line, most frequent reason first, for the periodic stats log */
export const formatDrops = (): string => {
  const { byReason } = dropStats()
  const parts = Object.entries(byReason).map(([reason, n]) => `${n}x ${reason}`)
  return parts.join(' | ')
}

/**
 * Records that failed the lexicon gate on a field the collector does not store,
 * and were admitted anyway rather than dropped.
 *
 * Kept separate from the drop counter because the two answer different
 * questions: drops say what is missing from the corpus, recoveries say what is
 * in it despite being malformed on the wire. Both belong in the methods
 * section, and collapsing them would make the first number look worse and the
 * second disappear.
 */
const recoveries = new Map<string, number>()
let recovered = 0

/** Count one admitted-despite-invalid record. Same first-sighting cue as `recordDrop`. */
export const recordRecovery = (reason: string): boolean => {
  recovered++
  const key =
    recoveries.has(reason) || recoveries.size < MAX_REASONS - 1 ? reason : OTHER
  const seen = recoveries.get(key) ?? 0
  recoveries.set(key, seen + 1)
  return seen === 0 && key === reason
}

export const recoveryStats = (): DropStats => ({
  total: recovered,
  byReason: Object.fromEntries(
    [...recoveries.entries()].sort((a, b) => b[1] - a[1]),
  ),
})

/** one line, most frequent reason first, for the periodic stats log */
export const formatRecoveries = (): string =>
  Object.entries(recoveryStats().byReason)
    .map(([reason, n]) => `${n}x ${reason}`)
    .join(' | ')
