// pg is CommonJS and its exports are not statically analysable, so a named
// ESM import of Pool resolves to undefined at runtime
import pg from 'pg'
const { Pool } = pg
import { Kysely, Migrator, PostgresDialect } from 'kysely'
import { DatabaseSchema } from './schema.js'
import { migrationProvider } from './migrations.js'
import { envInt, logError } from '../util/common.js'

export type DbOptions = {
  max?: number
  /** 0 disables the timeout (used for migrations, which may legitimately run long) */
  statementTimeoutMs?: number
}

/**
 * The one place the connection details are assembled, so that the collector and
 * `dist/backfill.js` cannot end up pointed at different databases.
 */
export const connectionStringFromEnv = (): string => {
  if (process.env.COLLECTOR_POSTGRES_URL) return process.env.COLLECTOR_POSTGRES_URL
  const host = process.env.COLLECTOR_DB_HOST || 'localhost'
  const port = parseInt(process.env.COLLECTOR_DB_PORT || '5432', 10)
  const user = process.env.COLLECTOR_DB_USER || 'collector'
  const password = process.env.COLLECTOR_DB_PASSWORD || 'collector'
  const database = process.env.COLLECTOR_DB_DATABASE || 'collector-db'
  return `postgres://${user}:${password}@${host}:${port}/${database}`
}

/** where the connection came from -- the URL itself carries a password */
export const describeConnection = (): string =>
  process.env.COLLECTOR_POSTGRES_URL
    ? 'COLLECTOR_POSTGRES_URL'
    : `${process.env.COLLECTOR_DB_HOST || 'localhost'}:${process.env.COLLECTOR_DB_PORT || '5432'}/${process.env.COLLECTOR_DB_DATABASE || 'collector-db'}`

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
