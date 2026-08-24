import { createDb, migrateToLatest } from './db'
import { FirehoseSubscription } from './subscription'
import { LabelSubscription } from './labelSubscription'
import { startHealthServer, startStatsLogger } from './util/health'
import { envInt, log, logError } from './util/common'

const run = async () => {
  const pgHost = process.env.COLLECTOR_DB_HOST || 'localhost'
  const pgPort = parseInt(process.env.COLLECTOR_DB_PORT || '5432', 10)
  const pgUser = process.env.COLLECTOR_DB_USER || 'collector'
  const pgPassword = process.env.COLLECTOR_DB_PASSWORD || 'collector'
  const pgDatabase = process.env.COLLECTOR_DB_DATABASE || 'collector-db'

  const connectionString = process.env.COLLECTOR_POSTGRES_URL ||
    `postgres://${pgUser}:${pgPassword}@${pgHost}:${pgPort}/${pgDatabase}`

  // the URL carries a password, so report only where it came from
  log(
    `Connecting to database: ${process.env.COLLECTOR_POSTGRES_URL
      ? 'COLLECTOR_POSTGRES_URL'
      : `${pgHost}:${pgPort}/${pgDatabase}`}`,
  )

  await migrateToLatest(connectionString)

  const db = createDb(connectionString)

  const reconnectDelay = parseInt(process.env.COLLECTOR_SUBSCRIPTION_RECONNECT_DELAY || '3000', 10)

  const firehose = new FirehoseSubscription(
    db,
    process.env.COLLECTOR_SUBSCRIPTION_ENDPOINT || 'wss://bsky.network'
  )

  const labelSub = new LabelSubscription(
    db,
    process.env.COLLECTOR_LABEL_SUBSCRIPTION_ENDPOINT || 'wss://mod.bsky.app'
  )

  const streams = [firehose, labelSub]
  const stats = () => streams.map((stream) => stream.stats())

  const health = startHealthServer({
    port: envInt('COLLECTOR_PORT', 3000),
    host: process.env.COLLECTOR_LISTENHOST || '0.0.0.0',
    maxLagMs: envInt('COLLECTOR_MAX_LAG_MS', 600_000),
    streams: stats,
  })
  const statsLogger = startStatsLogger(
    stats,
    envInt('COLLECTOR_STATS_INTERVAL_MS', 60_000),
  )

  for (const stream of streams) {
    stream.run(reconnectDelay).catch((err) => {
      logError(`${stream.name} subscription exited unexpectedly`, err)
    })
  }

  log('🔥 Firehose collection started')

  // Without this, `docker stop` discards whatever is buffered along with the
  // cursor position covering it.
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log(`${signal} received, shutting down`)

    // never let a wedged flush outlast docker's kill timer
    const hardExit = setTimeout(() => {
      logError('shutdown timed out, exiting')
      process.exit(1)
    }, envInt('COLLECTOR_SHUTDOWN_TIMEOUT_MS', 8_000))
    hardExit.unref()

    clearInterval(statsLogger)
    health.close()
    try {
      await Promise.all(streams.map((stream) => stream.stop()))
      await db.destroy()
      log('shutdown complete')
      process.exit(0)
    } catch (err) {
      logError('error during shutdown', err)
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

run().catch((err) => {
  logError('collector failed to start', err)
  process.exit(1)
})
