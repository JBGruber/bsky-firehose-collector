import { createServer, Server } from 'http'
import { StreamStats } from './subscription.js'
import { log, logError } from './common.js'
import {
  dropStats,
  formatDrops,
  formatRecoveries,
  recoveryStats,
} from './drops.js'

export type HealthOptions = {
  port: number
  host: string
  /** a stream lagging further behind than this reports unhealthy */
  maxLagMs: number
  streams: () => StreamStats[]
}

const startedAt = Date.now()

/**
 * How far behind a stream really is. Falls back to the time since the last event
 * so that a stream which is connected but receiving nothing -- wedged rather than
 * dead -- is not reported as healthy.
 */
export const effectiveLagMs = (stats: StreamStats): number => {
  const since = stats.lastEventAt ?? startedAt
  return Math.max(stats.lagMs ?? 0, Date.now() - since)
}

const snapshot = (opts: HealthOptions) => {
  const streams = opts.streams().map((stats) => ({
    ...stats,
    effectiveLagMs: effectiveLagMs(stats),
    lastEventAt: stats.lastEventAt
      ? new Date(stats.lastEventAt).toISOString()
      : null,
    lastFlushAt: stats.lastFlushAt
      ? new Date(stats.lastFlushAt).toISOString()
      : null,
  }))
  // A stream writing to the spill file is still collecting, but the database is
  // not receiving it, and that needs to be visible to whatever is watching --
  // restarting will not fix it, and it is the one state that leaves work to do
  // afterwards.
  const healthy = streams.every(
    (stream) =>
      stream.connected &&
      stream.effectiveLagMs <= opts.maxLagMs &&
      !stream.dbUnavailable,
  )
  return {
    status: healthy ? 'ok' : 'degraded',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    maxLagMs: opts.maxLagMs,
    // A6: records that never made it into the corpus, by reason. Needed to
    // describe the corpus whether or not the number turns out to be zero.
    drops: dropStats(),
    // The other half of that description: records that failed validation on a
    // field the collector does not store and were kept anyway.
    recoveries: recoveryStats(),
    streams,
    healthy,
  }
}

export const startHealthServer = (opts: HealthOptions): Server => {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/health' && path !== '/') {
      res.writeHead(404).end()
      return
    }
    const body = snapshot(opts)
    res.writeHead(body.healthy ? 200 : 503, {
      'content-type': 'application/json',
    })
    res.end(JSON.stringify(body, null, 2))
  })

  // a health endpoint that cannot bind must not take the collector down with it
  server.on('error', (err) => logError('health server error', err))
  server.listen(opts.port, opts.host, () => {
    log(`health endpoint listening on ${opts.host}:${opts.port}/health`)
  })
  return server
}

/** periodic one-line summary per stream -- the record of whether ingest is keeping up */
export const startStatsLogger = (
  streams: () => StreamStats[],
  intervalMs: number,
): NodeJS.Timeout => {
  const seen = new Map<string, { events: number; rows: number }>()
  const timer = setInterval(() => {
    for (const stats of streams()) {
      const prev = seen.get(stats.name) ?? { events: 0, rows: 0 }
      seen.set(stats.name, {
        events: stats.eventsSeen,
        rows: stats.rowsWritten,
      })
      const perSec = (n: number) => (n / (intervalMs / 1000)).toFixed(1)
      log(
        `${stats.name}: lag ${(effectiveLagMs(stats) / 1000).toFixed(1)}s | ` +
          `${perSec(stats.eventsSeen - prev.events)} evt/s | ` +
          `${perSec(stats.rowsWritten - prev.rows)} rows/s | ` +
          `buffer ${stats.bufferDepth} | cursor ${stats.committedSeq ?? 'none'} | ` +
          `reconnects ${stats.reconnects} | flush errors ${stats.flushErrors}` +
          (stats.mode === 'normal' ? '' : ` | MODE ${stats.mode}`) +
          (stats.spilledRows > 0 ? ` | spilled ${stats.spilledRows}` : '') +
          (stats.dbUnavailable ? ' | DB UNAVAILABLE' : '') +
          (stats.connected ? '' : ' | DISCONNECTED'),
      )
    }
    // A6: one line, only when there is something to say. The totals are the
    // point -- individual drops are logged once per distinct reason and then
    // never again, so this is where the volume becomes visible.
    const drops = dropStats()
    if (drops.total > 0) {
      log(`dropped ${drops.total} records: ${formatDrops()}`)
    }
    const recoveries = recoveryStats()
    if (recoveries.total > 0) {
      log(`kept ${recoveries.total} malformed records: ${formatRecoveries()}`)
    }
  }, intervalMs)
  timer.unref()
  return timer
}
