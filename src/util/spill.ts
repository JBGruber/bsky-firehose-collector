import { mkdir, open, readdir, FileHandle } from 'fs/promises'
import { join } from 'path'
import { log, logError } from './common.js'

/**
 * The bottom rung of the fallback ladder (Part D): rows that cannot go to
 * Postgres -- or that would cost too much to put there while the stream is
 * already far behind -- are appended to an NDJSON file under the `data` volume
 * and reconciled offline with `dist/backfill.js`.
 *
 * What is written is the batch the writer had already assembled, not the raw
 * frame it came from. The plan said raw frames; derived rows are better on every
 * axis that matters here. They are roughly a fifth of the size, because a repo
 * commit carries a whole CAR of MST blocks around the one record that is being
 * kept. Backfill is then the same multi-row insert the collector would have run,
 * against the same `on conflict do nothing` keys, instead of a second
 * implementation of `getOpsByType` that could drift from the first. And the
 * decoding has already happened by the time a write fails, so spilling the frame
 * would not save the CPU that the shed rungs above this one are there to save.
 *
 * Every line is one flushed batch:
 *
 *   { "v":1, "service":"wss://bsky.network", "seq":123, "at":"2026-…",
 *     "tables": { "post":[…], "engagement":[…] } }
 *
 * `seq` is the cursor the batch covers. It is not advanced in `sub_state` while
 * spilling, so the relay replays the same range if it is still within retention
 * -- the spill file is the copy that survives when it is not.
 */
export class SpillWriter {
  private handle: FileHandle | null = null
  private openDay: string | null = null
  /** writes are chained rather than concurrent: NDJSON tolerates no interleaving */
  private queue: Promise<void> = Promise.resolve()
  private warned = false

  public linesWritten = 0
  public rowsWritten = 0

  private constructor(
    private dir: string,
    private service: string,
  ) {}

  /**
   * A spill directory that cannot be created disables spilling rather than
   * stopping the collector: losing the bottom rung of the ladder is bad, and
   * not collecting at all is worse.
   */
  static async create(
    dir: string,
    service: string,
  ): Promise<SpillWriter | null> {
    const writer = new SpillWriter(dir, service)
    try {
      await mkdir(dir, { recursive: true })
    } catch (err) {
      logError(
        `spill directory ${dir} is not usable; the disk fallback is disabled ` +
          `for ${service} (set COLLECTOR_DATA_DIR to a writable path)`,
        err,
      )
      return null
    }
    log(`${service}: disk fallback ready at ${writer.path(today())}`)
    return writer
  }

  /** current file, so the health endpoint can say where the data went */
  path(day: string): string {
    const slug = this.service.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')
    return join(this.dir, `spill-${slug}-${day}.ndjson`)
  }

  /**
   * Append one batch. Resolves true only once the bytes are on the platter:
   * the caller is entitled to treat a spilled batch as durable and move past
   * it, so an unsynced write would be a worse lie than not spilling at all.
   */
  async write(payload: {
    seq: number | null
    tables: Record<string, unknown[]>
  }): Promise<boolean> {
    const rows = Object.values(payload.tables).reduce(
      (sum, table) => sum + table.length,
      0,
    )
    if (rows === 0) return true

    const line =
      JSON.stringify({
        v: 1,
        service: this.service,
        seq: payload.seq,
        at: new Date().toISOString(),
        tables: payload.tables,
      }) + '\n'

    let ok = false
    this.queue = this.queue.then(async () => {
      try {
        const handle = await this.file()
        await handle.write(line)
        await handle.sync()
        this.linesWritten++
        this.rowsWritten += rows
        this.warned = false
        ok = true
      } catch (err) {
        if (!this.warned) {
          logError(`${this.service}: could not append to the spill file`, err)
          this.warned = true
        }
        await this.reopen()
      }
    })
    await this.queue
    return ok
  }

  async close(): Promise<void> {
    await this.queue
    await this.reopen()
  }

  private async file(): Promise<FileHandle> {
    const day = today()
    if (this.handle && this.openDay === day) return this.handle
    // rotate: a file per UTC day keeps any one of them small enough to move,
    // and makes it obvious which days a backfill still has to cover
    await this.reopen()
    this.handle = await open(this.path(day), 'a')
    this.openDay = day
    return this.handle
  }

  private async reopen(): Promise<void> {
    const handle = this.handle
    this.handle = null
    this.openDay = null
    if (handle) await handle.close().catch(() => {})
  }
}

const today = (): string =>
  new Date().toISOString().slice(0, 10).replace(/-/g, '')

/**
 * Spill files still sitting in the data directory. Anything listed here is data
 * the collector holds but Postgres does not, so it is reported at startup and
 * kept in the health output until `dist/backfill.js` has been run and the files
 * renamed away.
 */
export const pendingSpillFiles = async (dir: string): Promise<string[]> => {
  try {
    const names = await readdir(dir)
    return names
      .filter((name) => name.startsWith('spill-') && name.endsWith('.ndjson'))
      .sort()
      .map((name) => join(dir, name))
  } catch {
    return []
  }
}
