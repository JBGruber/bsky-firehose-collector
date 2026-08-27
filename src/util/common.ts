/**
 * Sleep, optionally cut short by an abort signal.
 *
 * The signal is what makes shutdown reliable. `loop()` sleeps here between
 * reconnect attempts, and that delay reaches five minutes once an endpoint has
 * been unreachable for a while. Without the signal, a SIGTERM arriving mid-sleep
 * left `stop()` waiting for the timer, index.ts hit its 8 s hard-exit timer, and
 * the buffered batch and its cursor were discarded -- precisely when a clean
 * cursor is worth the most, since the endpoint being down is the reason there is
 * ground to make up.
 *
 * Aborting resolves rather than rejects: every caller treats the wait as "enough
 * time has passed", and the one that cares re-checks `stopped` immediately after.
 */
export const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })

export const chunk = <T>(items: T[], size: number): T[][] => {
  if (items.length <= size) return items.length > 0 ? [items] : []
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

export const envInt = (name: string, fallback: number): number => {
  const parsed = parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const log = (msg: string, ...rest: unknown[]) => {
  console.log(`[${new Date().toISOString()}] - ${msg}`, ...rest)
}

export const logError = (msg: string, ...rest: unknown[]) => {
  console.error(`[${new Date().toISOString()}] - ${msg}`, ...rest)
}

/**
 * Exponential backoff with equal jitter, capped at `ceilingMs`.
 *
 * The jitter matters as much as the backoff: both streams reconnect against
 * Bluesky-operated endpoints, so an upstream outage would otherwise have every
 * client retrying in lockstep at exactly the moment the endpoint comes back.
 */
export const backoffDelay = (
  attempt: number,
  baseMs: number,
  ceilingMs: number,
): number => {
  const exp = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), ceilingMs)
  return Math.round(exp / 2 + Math.random() * (exp / 2))
}

/**
 * How far an event's own timestamp may sit from local time before it is treated
 * as unusable. The window exists so that a row can only ever land in a partition
 * the maintainer keeps ahead of -- a relay clock badly out of step must not be
 * able to push rows into the default partition, which would then block the
 * creation of the real partition for that month.
 *
 * Fourteen days, because backdated frames are real and not rare: a PDS coming
 * back online replays its history, and a 3 minute sample of the live firehose
 * held 151 frames out of 36,340 (0.4%) that were over a minute old, the oldest
 * by 8.8 days. Fourteen days still cannot reach further back than the previous
 * month from any day, and the maintainer always keeps that month's partition.
 */
const MAX_BACKDATE_MS = 14 * 24 * 60 * 60 * 1000
const MAX_FUTURE_MS = 60 * 60 * 1000

/** implausible enough that a fabricated createdAt is better recorded as unknown */
const MIN_RECORD_TS_MS = Date.UTC(1970, 0, 1)
const MAX_RECORD_SKEW_MS = 365 * 24 * 60 * 60 * 1000

/**
 * The partition key, and the collector's answer to "when did this happen".
 *
 * Taken from the event's own `time` rather than the wall clock for two reasons.
 * It makes ingestion idempotent: `post` and `engagement` are keyed on
 * `(uri, indexedAt)` now that they are partitioned, so a wall-clock value would
 * give a replayed event a different key and `on conflict do nothing` would stop
 * deduplicating it -- turning the cursor replay that B1 added into a source of
 * duplicate rows. And it takes this process's own write lag out of
 * `time_online = deletedAt - indexedAt`, which previously absorbed whatever lag
 * happened to apply at each end.
 */
export const eventIndexedAt = (raw: unknown, now = Date.now()): string => {
  const parsed = typeof raw === 'string' ? Date.parse(raw) : NaN
  if (!Number.isFinite(parsed)) return new Date(now).toISOString()
  const clamped = Math.min(
    Math.max(parsed, now - MAX_BACKDATE_MS),
    now + MAX_FUTURE_MS,
  )
  return new Date(clamped).toISOString()
}

/**
 * A record's own `createdAt`, which is whatever the posting client wrote and is
 * the one timestamp the collector does not generate. Now that the column is
 * `timestamptz`, a value Postgres refuses -- year 0, a year beyond its range --
 * would abort the whole batch, so anything implausible becomes null instead.
 */
export const recordTimestamp = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null
  const parsed = Date.parse(raw)
  if (!Number.isFinite(parsed)) return null
  if (parsed < MIN_RECORD_TS_MS || parsed > Date.now() + MAX_RECORD_SKEW_MS) {
    return null
  }
  return new Date(parsed).toISOString()
}
