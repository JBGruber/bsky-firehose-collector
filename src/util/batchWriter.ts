import { Transaction } from 'kysely'
import { Database } from '../db/index.js'
import { DatabaseSchema } from '../db/schema.js'
import { logError, wait } from './common.js'

export type Trx = Transaction<DatabaseSchema>

/** How one stream's buffered rows are accumulated and written. */
export type BatchSpec<B> = {
  empty: () => B
  size: (buf: B) => number
  write: (trx: Trx, buf: B) => Promise<void>
}

export type WriterOptions = {
  /** flush once the buffer holds this many rows; also the backpressure point */
  highWater?: number
  /** flush a partial buffer after this long */
  flushIntervalMs?: number
  /** attempts per batch before giving up and forcing a resubscribe */
  maxAttempts?: number
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
 */
export class BatchWriter<B> {
  private buf: B
  private pendingSeq: number | null = null
  private flushing: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null

  readonly highWater: number
  readonly flushIntervalMs: number
  private readonly maxAttempts: number

  /** set when a batch could not be written; the stream must resubscribe from the last committed cursor */
  public needsReset = false
  public rowsWritten = 0
  public flushErrors = 0
  public lastFlushAt: number | null = null
  public committedSeq: number | null = null

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
  }

  get depth(): number {
    return this.spec.size(this.buf)
  }

  /**
   * Accumulate one event's rows. `fill` must be synchronous: if it could yield,
   * a timed flush could swap the buffer out from under it and the rows would be
   * committed under a cursor that does not cover them.
   */
  async add(fill: Filler<B>, seq: number): Promise<void> {
    fill(this.buf)
    if (this.pendingSeq === null || seq > this.pendingSeq) {
      this.pendingSeq = seq
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
    const rows = this.spec.size(batch)
    if (rows === 0 && seq === null) return

    this.buf = this.spec.empty()
    this.pendingSeq = null

    const done = this.write(batch, seq, rows)
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
    this.needsReset = false
  }

  /** final flush on shutdown */
  async close(): Promise<void> {
    await this.flush()
    this.clearTimer()
  }

  private async write(
    batch: B,
    seq: number | null,
    rows: number,
  ): Promise<void> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.db.transaction().execute(async (trx) => {
          if (rows > 0) await this.spec.write(trx, batch)
          if (seq !== null) await upsertCursor(trx, this.service, seq)
        })
        this.rowsWritten += rows
        this.lastFlushAt = Date.now()
        if (seq !== null) this.committedSeq = seq
        return
      } catch (err) {
        if (attempt < this.maxAttempts) {
          await wait(250 * 2 ** (attempt - 1))
          continue
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

const upsertCursor = async (trx: Trx, service: string, seq: number) => {
  // migration 001 creates sub_state but never seeds it, so an UPDATE matches
  // nothing and succeeds silently -- hence the upsert.
  await trx
    .insertInto('sub_state')
    .values({ service, cursor: BigInt(seq) })
    .onConflict((oc) =>
      oc.column('service').doUpdateSet({ cursor: BigInt(seq) }),
    )
    .execute()
}
