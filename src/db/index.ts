import { Pool } from 'pg'
import { Kysely, Migrator, PostgresDialect } from 'kysely'
import { DatabaseSchema } from './schema'
import { migrationProvider } from './migrations'
import { envInt, logError } from '../util/common'

export type DbOptions = {
  max?: number
  /** 0 disables the timeout (used for migrations, which may legitimately run long) */
  statementTimeoutMs?: number
}

export const createDb = (
  connectionString: string,
  opts: DbOptions = {},
): Database => {
  const pool = new Pool({
    connectionString,
    max: opts.max ?? envInt('COLLECTOR_DB_POOL_MAX', 15),
    connectionTimeoutMillis: envInt('COLLECTOR_DB_CONNECT_TIMEOUT_MS', 10_000),
    idleTimeoutMillis: envInt('COLLECTOR_DB_IDLE_TIMEOUT_MS', 30_000),
    statement_timeout:
      opts.statementTimeoutMs ??
      envInt('COLLECTOR_DB_STATEMENT_TIMEOUT_MS', 60_000),
  })

  // Without this listener, an error on an *idle* client -- a database restart, a
  // network blip -- is an unhandled 'error' event, which takes the process down.
  pool.on('error', (err) => {
    logError('idle database client errored (pool will replace it)', err)
  })

  return new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({ pool }),
  })
}

/**
 * Migrations run on their own short-lived pool so that DDL is not subject to the
 * ingest pool's statement timeout, and so a slow migration cannot occupy the
 * connections the collector needs.
 */
export const migrateToLatest = async (connectionString: string) => {
  const db = createDb(connectionString, { max: 2, statementTimeoutMs: 0 })
  try {
    const migrator = new Migrator({ db, provider: migrationProvider })
    const { error } = await migrator.migrateToLatest()
    if (error) throw error
  } finally {
    await db.destroy()
  }
}

export type Database = Kysely<DatabaseSchema>
