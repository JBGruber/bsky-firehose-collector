import { createReadStream } from 'fs'
import { rename, stat } from 'fs/promises'
import { createInterface } from 'readline'
import { sql } from 'kysely'
import { connectionStringFromEnv, createDb, Database } from './db/index.js'
import { DatabaseSchema } from './db/schema.js'
import { pendingSpillFiles } from './util/spill.js'
import { chunk, log, logError } from './util/common.js'

/**
 * Reconcile the spill files written by Part D's bottom rung.
 *
 *   node dist/backfill.js [--dry-run] [--keep] [file|dir ...]
 *
 * With no paths it takes every `spill-*.ndjson` in COLLECTOR_DATA_DIR. Each line
 * is one batch the collector had already assembled, keyed by table name, so this
 * is the same multi-row insert the collector would have run -- including the same
 * `on conflict do nothing`, which is what makes running it twice harmless and
 * makes overlap with whatever the relay replayed free.
 *
 * A file is renamed to `.done` once it has been read through without error, so a
 * later run does not redo it and the collector stops reporting it at startup.
 * `--keep` leaves it in place.
 */

/** the column each partitioned table is ranged on; absent means not partitioned */
const PARTITION_KEY: Record<string, string> = {
  post: 'indexedAt',
  engagement: 'indexedAt',
  media: 'indexedAt',
  post_deletion: 'deletedAt',
  engagement_deletion: 'deletedAt',
}

const KNOWN_TABLES = new Set<keyof DatabaseSchema>([
  'post',
  'post_deletion',
  'media',
  'engagement',
  'engagement_deletion',
  'label',
  'account_event',
])

type Counts = Record<string, number>

const monthOf = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const ts = Date.parse(value)
  if (!Number.isFinite(ts)) return null
  const date = new Date(ts)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString()
}

/**
 * A spilled batch can be weeks old by the time it is reconciled, and the
 * collector only keeps partitions from a month back to two months ahead. Without
 * this the rows would land in the default partition, where they are invisible to
 * partition pruning and block that month's real partition from ever being made.
 */
const ensureMonths = async (
  db: Database,
  table: string,
  rows: unknown[],
  seen: Set<string>,
): Promise<void> => {
  const key = PARTITION_KEY[table]
  if (!key) return
  for (const row of rows) {
    const month = monthOf((row as Record<string, unknown>)[key])
    if (month === null) continue
    const marker = `${table}:${month}`
    if (seen.has(marker)) continue
    seen.add(marker)
    await sql`select ensure_month_partition(${table}, ${month}::timestamptz)`.execute(db)
  }
}

/**
 * Returns rows actually inserted, not rows attempted. The difference is the
 * whole point of running this twice: overlap with what the relay replayed, or
 * with a previous backfill, is deduplicated by the same `on conflict do nothing`
 * the collector uses, and a report that counted attempts would claim to have
 * done work it did not do.
 */
const insertRows = async (
  db: Database,
  table: string,
  rows: unknown[],
): Promise<{ inserted: number; skipped: number }> => {
  let inserted = 0
  for (const batch of chunk(rows, 500)) {
    // The table name comes from the file, so this is the one place the schema
    // cannot be checked statically; KNOWN_TABLES is the check that replaces it.
    const res = await (db as any)
      .insertInto(table)
      .values(batch)
      .onConflict((oc: any) => oc.doNothing())
      .executeTakeFirst()
    inserted += Number(res?.numInsertedOrUpdatedRows ?? 0)
  }
  return { inserted, skipped: rows.length - inserted }
}

const backfillFile = async (
  db: Database,
  path: string,
  opts: { dryRun: boolean; keep: boolean },
): Promise<Counts> => {
  const counts: Counts = {}
  const skipped: Counts = {}
  const months = new Set<string>()
  let lines = 0
  let bad = 0

  const reader = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  for await (const line of reader) {
    if (line.trim() === '') continue
    lines++
    let payload: { tables?: Record<string, unknown[]> }
    try {
      payload = JSON.parse(line)
    } catch (err) {
      // A truncated last line is the expected shape of a crash mid-append; the
      // rest of the file is still good, so it is counted rather than fatal.
      bad++
      continue
    }
    for (const [table, rows] of Object.entries(payload.tables ?? {})) {
      if (!KNOWN_TABLES.has(table as keyof DatabaseSchema)) {
        logError(`${path}: skipping unknown table "${table}"`)
        continue
      }
      if (!Array.isArray(rows) || rows.length === 0) continue
      if (opts.dryRun) {
        counts[table] = (counts[table] ?? 0) + rows.length
        continue
      }
      await ensureMonths(db, table, rows, months)
      const res = await insertRows(db, table, rows)
      counts[table] = (counts[table] ?? 0) + res.inserted
      skipped[table] = (skipped[table] ?? 0) + res.skipped
    }
  }

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
  const totalSkipped = Object.values(skipped).reduce((sum, n) => sum + n, 0)
  log(
    `${path}: ${lines} batches, ${total} rows inserted` +
      (totalSkipped > 0 ? `, ${totalSkipped} already present` : '') +
      (bad > 0 ? `, ${bad} unparseable line(s) skipped` : '') +
      (opts.dryRun ? ' (dry run, nothing written)' : ''),
  )
  for (const table of Object.keys({ ...counts, ...skipped }).sort()) {
    const dup = skipped[table] ?? 0
    log(`  ${table}: ${counts[table] ?? 0}${dup > 0 ? ` (+${dup} already present)` : ''}`)
  }

  if (!opts.dryRun && !opts.keep) {
    await rename(path, `${path}.done`)
    log(`  renamed to ${path}.done`)
  }
  return counts
}

const run = async () => {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const keep = args.includes('--keep')
  const paths = args.filter((arg) => !arg.startsWith('--'))

  const dataDir = process.env.COLLECTOR_DATA_DIR || '/app/data'
  const files: string[] = []
  if (paths.length === 0) {
    files.push(...(await pendingSpillFiles(dataDir)))
  } else {
    for (const path of paths) {
      const info = await stat(path)
      if (info.isDirectory()) files.push(...(await pendingSpillFiles(path)))
      else files.push(path)
    }
  }

  if (files.length === 0) {
    log(`nothing to backfill (looked in ${paths.length ? paths.join(', ') : dataDir})`)
    return
  }

  // No migrations here: backfill runs against a database the collector has
  // already migrated. Running them from a second process would race it.
  const db = createDb(connectionStringFromEnv(), {
    max: 4,
    statementTimeoutMs: 0,
  })
  const totals: Counts = {}
  try {
    for (const file of files) {
      const counts = await backfillFile(db, file, { dryRun, keep })
      for (const [table, n] of Object.entries(counts)) {
        totals[table] = (totals[table] ?? 0) + n
      }
    }
  } finally {
    await db.destroy()
  }

  const total = Object.values(totals).reduce((sum, n) => sum + n, 0)
  log(`backfill complete: ${total} rows inserted from ${files.length} file(s)`)
}

run().catch((err) => {
  logError('backfill failed', err)
  process.exit(1)
})
