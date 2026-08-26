import {
  connectionStringFromEnv,
  createDb,
  describeConnection,
  migrateToLatest,
} from './db/index.js'
import { FirehoseSubscription } from './subscription.js'
import { LabelSubscription } from './labelSubscription.js'
import { startHealthServer, startStatsLogger } from './util/health.js'
import { initPartitions, startPartitionMaintainer } from './util/partitions.js'
import { pendingSpillFiles } from './util/spill.js'
import { envInt, log, logError } from './util/common.js'

const run = async () => {
  const connectionString = connectionStringFromEnv()

  // the URL carries a password, so report only where it came from
  log(`Connecting to database: ${describeConnection()}`)

  await migrateToLatest(connectionString)

  const db = createDb(connectionString)

  // Monthly partitions have to exist before anything is written to them.
  // Logged rather than fatal: the default partition catches rows in the
  // meantime, and refusing to collect at all would be the worse failure.
  const partitionMonthsAhead = envInt('COLLECTOR_PARTITION_MONTHS_AHEAD', 2)
  try {
    await initPartitions(db, partitionMonthsAhead)
  } catch (err) {
    logError('could not ensure monthly partitions at startup', err)
  }
  const partitionMaintainer = startPartitionMaintainer(
    db,
    envInt('COLLECTOR_PARTITION_INTERVAL_MS', 3_600_000),
    partitionMonthsAhead,
  )

  const reconnectDelay = parseInt(process.env.COLLECTOR_SUBSCRIPTION_RECONNECT_DELAY || '3000', 10)

  // Part D's bottom rung writes here. Already mounted as a volume in compose;
  // this is the first thing that uses it.
  const dataDir = process.env.COLLECTOR_DATA_DIR || '/app/data'
  const unreconciled = await pendingSpillFiles(dataDir)
  if (unreconciled.length > 0) {
    logError(
      `${unreconciled.length} spill file(s) in ${dataDir} hold rows that are ` +
        `not in the database; run \`node dist/backfill.js\` to reconcile them:\n  ` +
        unreconciled.join('\n  '),
    )
  }

  const firehose = new FirehoseSubscription(
    db,
    process.env.COLLECTOR_SUBSCRIPTION_ENDPOINT || 'wss://bsky.network',
    {
      dataDir,
      ladder: {
        shedLikesLagMs: envInt('COLLECTOR_SHED_LIKES_LAG_MS', 60_000),
        shedRepostsLagMs: envInt('COLLECTOR_SHED_REPOSTS_LAG_MS', 300_000),
        spillLagMs: envInt('COLLECTOR_SPILL_LAG_MS', 900_000),
        recoverAfterMs: envInt('COLLECTOR_LADDER_RECOVER_MS', 120_000),
      },
    },
  )

  const labelSub = new LabelSubscription(
    db,
    process.env.COLLECTOR_LABEL_SUBSCRIPTION_ENDPOINT || 'wss://mod.bsky.app',
    { dataDir },
  )

  const streams = [firehose, labelSub]
  const stats = () => streams.map((stream) => stream.stats())

  // The disk fallback and the gap covering however long this stream was down.
  // Before run(), so the gap starts at the watermark the last run committed
  // rather than at whenever the first frame happens to arrive.
  for (const stream of streams) {
    await stream.init()
  }

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
    clearInterval(partitionMaintainer)
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
