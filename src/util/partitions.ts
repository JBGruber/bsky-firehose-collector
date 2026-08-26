import { sql } from 'kysely'
import { Database } from '../db/index.js'
import { log, logError } from './common.js'

/**
 * Every table that migration 005 partitions by month. The `_default` partition
 * of each is the safety net: an insert whose partition key falls outside every
 * declared range lands there rather than failing the batch.
 */
export const PARTITIONED_TABLES = [
  'post',
  'engagement',
  'media',
  'post_deletion',
  'engagement_deletion',
] as const

const monthsAround = (now: Date, ahead: number): string[] => {
  const months: string[] = []
  // one month back as well: events are clamped to at most seven days old, so on
  // the first days of a month a row can still belong to the previous one
  for (let offset = -1; offset <= ahead; offset++) {
    months.push(
      new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1),
      ).toISOString(),
    )
  }
  return months
}

/**
 * Create any month partition that does not exist yet, for the current month and
 * `monthsAhead` after it. Cheap and idempotent: `ensure_month_partition` returns
 * immediately when the partition is already there.
 */
export const ensurePartitions = async (
  db: Database,
  monthsAhead = 2,
): Promise<void> => {
  const months = monthsAround(new Date(), monthsAhead)
  for (const table of PARTITIONED_TABLES) {
    for (const month of months) {
      await sql`select ensure_month_partition(${table}, ${month}::timestamptz)`.execute(
        db,
      )
    }
  }
}

/**
 * A row in a default partition means the clamp in `eventIndexedAt` did not hold,
 * or that partition creation has been failing unnoticed. It also blocks the
 * creation of the real partition for that month, so it has to be visible rather
 * than merely survivable.
 */
export const warnOnDefaultPartitions = async (db: Database): Promise<void> => {
  for (const table of PARTITIONED_TABLES) {
    const { rows } = await sql<{ occupied: boolean }>`
      select exists (select 1 from ${sql.table(`${table}_default`)} limit 1) as occupied
    `.execute(db)
    if (rows[0]?.occupied) {
      logError(
        `${table}_default holds rows: some event fell outside every declared ` +
          `month partition, and the partition for that month can no longer be created`,
      )
    }
  }
}

/**
 * Keeps partitions ahead of the collector while it runs, so a month boundary is
 * never reached without somewhere to write. Failures are logged rather than
 * fatal -- the default partition absorbs the rows in the meantime, and a
 * collector that refuses to run because it could not issue DDL would be a worse
 * outcome than one running on a stale partition set.
 */
export const startPartitionMaintainer = (
  db: Database,
  intervalMs: number,
  monthsAhead = 2,
): NodeJS.Timeout => {
  const timer = setInterval(() => {
    ensurePartitions(db, monthsAhead).catch((err) =>
      logError('partition maintenance failed', err),
    )
  }, intervalMs)
  timer.unref()
  return timer
}

/** startup pass: partitions first, then report anything already in a default */
export const initPartitions = async (
  db: Database,
  monthsAhead = 2,
): Promise<void> => {
  await ensurePartitions(db, monthsAhead)
  await warnOnDefaultPartitions(db)
  log(`monthly partitions ensured through +${monthsAhead} months`)
}
