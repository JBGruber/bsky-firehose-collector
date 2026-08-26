import { Database } from '../db/index.js'
import { log, logError } from './common.js'

/**
 * Why collection was not running normally.
 *
 *  - `restart`    the process was not running. Opened at the watermark the last
 *                 run committed, closed by the first event after resuming, so a
 *                 cursor replay that worked shows up as a near-zero interval and
 *                 one that did not shows the real hole.
 *  - `disconnected` the stream dropped mid-run and reconnected.
 *  - `cursor_expired` the relay answered with `#info OutdatedCursor`: the cursor
 *                 was outside its retention and the stream resumed at whatever
 *                 the relay still had. This is the one reason that always means
 *                 data is genuinely missing.
 *  - `degraded`   a fallback-ladder rung was in force; `streams` says what was
 *                 still being collected.
 *  - `db_unavailable` batches could not be written to Postgres and went to the
 *                 spill file instead.
 */
export type GapReason =
  | 'restart'
  | 'disconnected'
  | 'cursor_expired'
  | 'degraded'
  | 'db_unavailable'

export type Gap = {
  /** null until the row has been written; the database assigns it */
  id: string | null
  reason: GapReason
  startedAt: number
  endedAt: number | null
  detail: string | null
  streams: string[] | null
  /** false when the row in the database does not yet match this object */
  synced: boolean
}

export type GapOptions = {
  detail?: string | null
  streams?: string[] | null
}

/**
 * Anything past this many unwritten gaps means the database has been
 * unreachable for a very long time; the oldest are dropped rather than allowed
 * to grow into the memory problem this whole plan exists to remove. Each gap is
 * a few hundred bytes and one is written per reconnect, so the cap is reached
 * only after tens of thousands of them.
 */
const MAX_PENDING = 5_000

/**
 * A5 -- writes and maintains `collection_gap` rows for one stream.
 *
 * The awkward part is that a gap is most likely to be opened exactly when the
 * database cannot be written to, so gaps live in memory first and are flushed
 * whenever a write succeeds. A gap that is opened and closed while Postgres is
 * down is still recorded, in one insert, once it comes back.
 */
export class GapRecorder {
  private pending: Gap[] = []
  private syncing: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null
  private dropped = 0

  constructor(
    private db: Database,
    private service: string,
    retryIntervalMs = 60_000,
  ) {
    this.timer = setInterval(() => void this.sync(), retryIntervalMs)
    this.timer.unref()
  }

  /** currently-open gaps, for the health endpoint */
  get open(): Gap[] {
    return this.pending.filter((gap) => gap.endedAt === null)
  }

  openGap(reason: GapReason, startedAt: number, opts: GapOptions = {}): Gap {
    const gap: Gap = {
      id: null,
      reason,
      startedAt,
      endedAt: null,
      detail: opts.detail ?? null,
      streams: opts.streams ?? null,
      synced: false,
    }
    this.enqueue(gap)
    log(
      `${this.service}: collection gap opened (${reason}) at ${new Date(startedAt).toISOString()}` +
        (gap.detail ? ` -- ${gap.detail}` : ''),
    )
    void this.sync()
    return gap
  }

  closeGap(gap: Gap, endedAt: number, detail?: string): void {
    if (gap.endedAt !== null) return
    gap.endedAt = Math.max(endedAt, gap.startedAt)
    if (detail) gap.detail = gap.detail ? `${gap.detail}; ${detail}` : detail
    gap.synced = false
    log(
      `${this.service}: collection gap closed (${gap.reason}) after ` +
        `${((gap.endedAt - gap.startedAt) / 1000).toFixed(1)}s` +
        (gap.detail ? ` -- ${gap.detail}` : ''),
    )
    void this.sync()
  }

  /**
   * Correct the reason of a gap already opened. Used when the relay answers a
   * resume with `#info OutdatedCursor`: the interval was opened as an ordinary
   * restart, and the answer turns it into the one kind that always means data is
   * genuinely gone.
   */
  reclassify(gap: Gap, reason: GapReason, detail?: string): void {
    if (gap.reason === reason) return
    gap.reason = reason
    if (detail) gap.detail = gap.detail ? `${gap.detail}; ${detail}` : detail
    gap.synced = false
    logError(
      `${this.service}: collection gap reclassified as ${reason}` +
        (gap.detail ? ` -- ${gap.detail}` : ''),
    )
    void this.sync()
  }

  /** a gap whose bounds are already known -- one insert, never an update */
  record(
    reason: GapReason,
    startedAt: number,
    endedAt: number,
    opts: GapOptions = {},
  ): void {
    const gap = this.openGap(reason, startedAt, opts)
    this.closeGap(gap, endedAt)
  }

  /**
   * Startup: close whatever a previous run left open, bounded by the watermark
   * it last committed, and hand back nothing. Without this a collector that is
   * restarted repeatedly accumulates open rows that no later run will ever
   * close, and every one of them reads as an unbounded outage.
   */
  async closeOrphans(watermark: number | null): Promise<void> {
    try {
      const endedAt = new Date(watermark ?? Date.now()).toISOString()
      const closed = await this.db
        .updateTable('collection_gap')
        .set({
          endedAt,
          detail: 'closed at startup: the run that opened it did not close it',
        })
        .where('service', '=', this.service)
        .where('endedAt', 'is', null)
        .executeTakeFirst()
      const n = Number(closed?.numUpdatedRows ?? 0)
      if (n > 0) {
        log(`${this.service}: closed ${n} gap(s) left open by a previous run`)
      }
    } catch (err) {
      logError(`${this.service}: could not close orphaned collection gaps`, err)
    }
  }

  /** write everything that is not yet in the database, oldest first */
  async sync(): Promise<void> {
    while (this.syncing) await this.syncing
    if (this.pending.every((gap) => gap.synced)) {
      this.prune()
      return
    }
    const done = this.flush()
    this.syncing = done
    try {
      await done
    } finally {
      if (this.syncing === done) this.syncing = null
    }
  }

  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.sync()
    const unwritten = this.pending.filter((gap) => !gap.synced).length
    if (unwritten > 0) {
      logError(
        `${this.service}: ${unwritten} collection gap(s) could not be written; ` +
          `they are lost, but the intervals are visible in the log above`,
      )
    }
  }

  private enqueue(gap: Gap): void {
    this.pending.push(gap)
    while (this.pending.length > MAX_PENDING) {
      this.pending.shift()
      this.dropped++
    }
  }

  private async flush(): Promise<void> {
    for (const gap of this.pending) {
      if (gap.synced) continue
      try {
        if (gap.id === null) {
          const row = await this.db
            .insertInto('collection_gap')
            .values({
              service: this.service,
              startedAt: new Date(gap.startedAt).toISOString(),
              endedAt:
                gap.endedAt === null
                  ? null
                  : new Date(gap.endedAt).toISOString(),
              reason: gap.reason,
              detail: gap.detail,
              streams: gap.streams,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
          gap.id = String(row.id)
        } else {
          await this.db
            .updateTable('collection_gap')
            .set({
              endedAt:
                gap.endedAt === null
                  ? null
                  : new Date(gap.endedAt).toISOString(),
              // reason too: a restart gap becomes cursor_expired when the relay
              // answers the resume with #info OutdatedCursor, which can arrive
              // after the row has already been written
              reason: gap.reason,
              detail: gap.detail,
              streams: gap.streams,
            })
            .where('id', '=', gap.id)
            .execute()
        }
        gap.synced = true
      } catch (err) {
        // The database is the thing that is unavailable often enough for this
        // class to exist. Stop at the first failure so ordering is preserved
        // and try again on the next tick.
        logError(`${this.service}: could not write collection gap`, err)
        return
      }
    }
    if (this.dropped > 0) {
      logError(
        `${this.service}: ${this.dropped} collection gap(s) were discarded ` +
          `before they could be written -- the buffer cap was reached`,
      )
      this.dropped = 0
    }
    this.prune()
  }

  /** closed and written gaps have nothing left to say; keep memory flat */
  private prune(): void {
    this.pending = this.pending.filter(
      (gap) => !gap.synced || gap.endedAt === null,
    )
  }
}
