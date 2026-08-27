import { Transaction } from 'kysely'
import { Database } from '../db/index.js'
import { DatabaseSchema } from '../db/schema.js'
import { log, logError, wait } from './common.js'
import { SpillWriter } from './spill.js'

export type Trx = Transaction<DatabaseSchema>

/** How one stream's buffered rows are accumulated and written. */
export type BatchSpec<B> = {
  empty: () => B
  size: (buf: B) => number
  write: (trx: Trx, buf: B) => Promise<void>
  /**
   * The same rows keyed by table name, for the disk fallback. Backfill then
   * needs no knowledge of the buffer's shape -- it inserts each key into the
   * table of that name -- so the spill format cannot drift away from the
   * schema the collector actually writes.
   */
  tables: (buf: B) => Record<string, unknown[]>
}

export type WriterOptions = {
  /** flush once the buffer holds this many rows; also the backpressure point */
  highWater?: number
  /** flush a partial buffer after this long */
  flushIntervalMs?: number
  /** attempts per batch before giving up and forcing a resubscribe */
  maxAttempts?: number
  /** bottom rung of the fallback ladder; absent means no disk fallback */
  spill?: SpillWriter | null
  /** true while the ladder wants batches to go to disk rather than to Postgres */
  shouldSpill?: () => boolean
}

export type Filler<B> = (buf: B) => void

/**
 * Buffers rows and writes them as multi-row inserts inside a single transaction,
 * together with the cursor for everything the batch covers.
 *
 * Two invariants matter here:
 *
 *  - The cursor is written in the same transaction as the rows, so it can never
 *    claim coverage of data that was not durably committed.
 *  - `add()` only resolves once there is room in the buffer again. Awaiting it in
 *    the consume loop turns a slow database into measurable lag instead of an
 *    unbounded pile of pending queries in the heap.
 *
 * The disk fallback bends the first invariant on purpose and only where it is
 * still true in substance: a batch that has been fsynced to the spill file is
 * durably stored, just not in Postgres, so the cursor may move past it. What
 * makes that safe rather than a quiet hole is that the same condition opens a
 * `collection_gap` row naming the interval, and `dist/backfill.js` puts the rows
 * where they belong.
 */
export class BatchWriter<B> {
  private buf: B
  private pendingSeq: number | null = null
  private pendingEventAt: number | null = null
  private flushing: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null

  readonly highWater: number
  readonly flushIntervalMs: number
  private readonly maxAttempts: number
  /** set by the stream's init(): the directory has to be created first */
  public spill: SpillWriter | null
  private readonly shouldSpill: () => boolean

  /** set when a batch could not be written; the stream must resubscribe from the last committed cursor */
  public needsReset = false
  public rowsWritten = 0
  public flushErrors = 0
  public spilledRows = 0
  public spilledBatches = 0
  /** so a database that is down does not log the same line every flush interval */
  private cursorWarned = false
  /** true from a failed batch until the next write that succeeds */
  public dbUnavailable = false
  public lastFlushAt: number | null = null
  public committedSeq: number | null = null
  /** event time of the newest event the committed cursor covers */
  public committedEventAt: number | null = null

  constructor(
    private db: Database,
    private service: string,
    private spec: BatchSpec<B>,
    opts: WriterOptions = {},
  ) {
    this.buf = spec.empty()
    this.highWater = opts.highWater ?? 1000
    this.flushIntervalMs = opts.flushIntervalMs ?? 500
    this.maxAttempts = opts.maxAttempts ?? 3
    this.spill = opts.spill ?? null
    this.shouldSpill = opts.shouldSpill ?? (() => false)
  }

  get depth(): number {
    return this.spec.size(this.buf)
  }

  /**
   * Accumulate one event's rows. `fill` must be synchronous: if it could yield,
   * a timed flush could swap the buffer out from under it and the rows would be
   * committed under a cursor that does not cover them.
   */
  async add(fill: Filler<B>, seq: number, eventAt: number | null): Promise<void> {
    fill(this.buf)
    if (this.pendingSeq === null || seq > this.pendingSeq) {
      this.pendingSeq = seq
      // the timestamp of the furthest event the batch reaches, which is what
      // "the corpus is complete through here" means for a gap boundary. Frames
      // are not delivered in timestamp order, so this is the time of the highest
      // seq rather than the newest time seen.
      this.pendingEventAt = eventAt
    }
    if (this.depth >= this.highWater) {
      await this.flush()
    } else {
      this.scheduleFlush()
    }
  }

  async flush(): Promise<void> {
    // never resolves to a rejection: write() handles its own failures
    while (this.flushing) await this.flushing
    this.clearTimer()

    const batch = this.buf
    const seq = this.pendingSeq
    const eventAt = this.pendingEventAt
    const rows = this.spec.size(batch)
    if (rows === 0 && seq === null) return

    this.buf = this.spec.empty()
    this.pendingSeq = null
    this.pendingEventAt = null

    const done = this.write(batch, seq, eventAt, rows)
    this.flushing = done
    try {
      await done
    } finally {
      if (this.flushing === done) this.flushing = null
    }
  }

  /** discard anything buffered -- used when the stream rewinds to the committed cursor */
  reset(): void {
    this.clearTimer()
    this.buf = this.spec.empty()
    this.pendingSeq = null
    this.pendingEventAt = null
    this.needsReset = false
  }

  /** final flush on shutdown */
  async close(): Promise<void> {
    await this.flush()
    this.clearTimer()
    if (this.spill) await this.spill.close()
  }

  private async write(
    batch: B,
    seq: number | null,
    eventAt: number | null,
    rows: number,
  ): Promise<void> {
    // Rung 3 reached through lag: Postgres is healthy but cannot take the
    // volume, so the rows go to disk and only the cursor -- one small upsert --
    // still goes to the database.
    if (rows > 0 && this.spill && this.shouldSpill()) {
      if (await this.spillBatch(batch, seq, rows)) {
        await this.commitCursorOnly(seq, eventAt)
        return
      }
      // the disk failed too; the database is the only thing left to try
    }

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.db.transaction().execute(async (trx) => {
          if (rows > 0) await this.spec.write(trx, batch)
          if (seq !== null) await upsertCursor(trx, this.service, seq, eventAt)
        })
        this.rowsWritten += rows
        this.lastFlushAt = Date.now()
        this.dbUnavailable = false
        this.cursorWarned = false
        if (seq !== null) {
          this.committedSeq = seq
          if (eventAt !== null) this.committedEventAt = eventAt
        }
        return
      } catch (err) {
        if (attempt < this.maxAttempts) {
          await wait(250 * 2 ** (attempt - 1))
          continue
        }
        this.dbUnavailable = true

        // Bottom rung: the database is unreachable, so the batch goes to disk
        // instead. The cursor stays where it is -- it lives in the database that
        // just refused the write -- so the relay replays this range too if it is
        // still within retention, and `on conflict do nothing` makes the overlap
        // free. The spill file is what survives when it is not.
        if (this.spill && (await this.spillBatch(batch, seq, rows))) {
          logError(
            `${this.service}: database unavailable after ${attempt} attempts; ` +
              `${rows} rows written to the spill file instead`,
            err,
          )
          return
        }

        // The batch is lost, but the cursor was not advanced with it, so the
        // data is still upstream. Signal a resubscribe from the committed
        // cursor rather than letting a later batch advance the cursor past it.
        this.flushErrors++
        this.needsReset = true
        logError(
          `dropping batch of ${rows} rows for ${this.service} after ${attempt} attempts; ` +
            `rewinding to cursor ${this.committedSeq ?? 'head'}`,
          err,
        )
        return
      }
    }
  }

  private async spillBatch(
    batch: B,
    seq: number | null,
    rows: number,
  ): Promise<boolean> {
    if (!this.spill) return false
    const tables: Record<string, unknown[]> = {}
    for (const [name, values] of Object.entries(this.spec.tables(batch))) {
      if (values.length > 0) tables[name] = values
    }
    const ok = await this.spill.write({ seq, tables })
    if (!ok) return false
    this.spilledRows += rows
    this.spilledBatches++
    this.lastFlushAt = Date.now()
    if (this.spilledBatches === 1) {
      log(
        `${this.service}: writing batches to the spill file; ` +
          `reconcile with \`node dist/backfill.js\` once the database is back`,
      )
    }
    return true
  }

  /**
   * Advance the cursor past rows that went to disk. Best effort: if the database
   * refuses this too it is unavailable, the cursor stays put, and the relay
   * replays the range -- which is the right answer, since a replayed batch is
   * deduplicated on arrival.
   */
  private async commitCursorOnly(
    seq: number | null,
    eventAt: number | null,
  ): Promise<void> {
    if (seq === null) return
    try {
      await this.db.transaction().execute(async (trx) => {
        await upsertCursor(trx, this.service, seq, eventAt)
      })
      this.dbUnavailable = false
      this.cursorWarned = false
      this.committedSeq = seq
      if (eventAt !== null) this.committedEventAt = eventAt
    } catch (err) {
      this.dbUnavailable = true
      // Attempted on every flush even while the database is known to be down --
      // it is one tiny upsert, and succeeding is how recovery is noticed. Logged
      // only on the transition, or it would be a line every flush interval for
      // as long as the outage lasts.
      if (!this.cursorWarned) {
        this.cursorWarned = true
        logError(
          `${this.service}: rows were spilled to disk but the cursor could not be ` +
            `advanced; the stream will replay from ${this.committedSeq ?? 'head'}`,
          err,
        )
      }
    }
  }

  private scheduleFlush(): void {
    if (this.timer) return
    if (this.depth === 0 && this.pendingSeq === null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.flushIntervalMs)
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

const upsertCursor = async (
  trx: Trx,
  service: string,
  seq: number,
  eventAt: number | null,
) => {
  const lastEventAt = eventAt === null ? null : new Date(eventAt).toISOString()
  // migration 001 creates sub_state but never seeds it, so an UPDATE matches
  // nothing and succeeds silently -- hence the upsert.
  await trx
    .insertInto('sub_state')
    .values({ service, cursor: BigInt(seq), lastEventAt })
    .onConflict((oc) =>
      oc.column('service').doUpdateSet(
        // a batch of frames that all lacked a usable timestamp must not erase a
        // watermark an earlier batch established
        lastEventAt === null
          ? { cursor: BigInt(seq) }
          : { cursor: BigInt(seq), lastEventAt },
      ),
    )
    .execute()
}
