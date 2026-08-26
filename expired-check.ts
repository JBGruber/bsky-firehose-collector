import { sql } from 'kysely'
import { createDb, connectionStringFromEnv } from './src/db/index.js'
import { FirehoseSubscription } from './src/subscription.js'

// bsky.network silently clamps an out-of-retention cursor instead of answering
// #info OutdatedCursor, so the reclassify path cannot be reached from the live
// relay. Drive the real FirehoseSubscription with an injected #info frame.
const SERVICE = 'wss://cursor-expired-test.invalid'
const db = createDb(connectionStringFromEnv(), { max: 2 })

const watermark = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()
await db.deleteFrom('sub_state').where('service', '=', SERVICE).execute()
await db.deleteFrom('collection_gap').where('service', '=', SERVICE).execute()
await db.insertInto('sub_state').values({ service: SERVICE, cursor: BigInt(4242), lastEventAt: watermark }).execute()

const stream = new FirehoseSubscription(db, SERVICE, { dataDir: null })
const frames = [
  { $type: 'com.atproto.sync.subscribeRepos#info', name: 'OutdatedCursor', message: 'Requested cursor exceeded limit. Possibly missing events' },
  // the first real event after the reset: at the live head, three days past the watermark
  { $type: 'com.atproto.sync.subscribeRepos#sync', seq: 99999, time: new Date().toISOString(), did: 'did:plc:head', blocks: new Uint8Array(), rev: 'x' },
]
// the real Subscription ends its iterator on the abort signal; this stand-in
// needs its own, or stop() would wait on a promise that never settles
const done = new AbortController()
;(stream as any).sub = {
  [Symbol.asyncIterator]: () => {
    let i = 0
    return {
      next: async () => {
        if (i < frames.length) return { value: frames[i++], done: false }
        if (done.signal.aborted) return { value: undefined, done: true }
        await new Promise<void>((r) => done.signal.addEventListener('abort', () => r(), { once: true }))
        return { value: undefined, done: true }
      },
    }
  },
}

await stream.init()
stream.run(3000).catch(() => {})
await new Promise((r) => setTimeout(r, 1500))
done.abort()
await stream.stop()

const { rows } = await sql<any>`
  select reason, "startedAt", "endedAt",
         round(extract(epoch from ("endedAt"-"startedAt"))/3600, 2) as hours, detail
  from collection_gap where service = ${SERVICE} order by id`.execute(db)
console.log('\ngap rows:')
for (const r of rows) console.log(' ', JSON.stringify(r))

const ok = rows.length === 1 && rows[0].reason === 'cursor_expired' && Number(rows[0].hours) > 70
console.log(ok
  ? '\nPASS -- reclassified to cursor_expired, and the interval is the real 3-day hole'
  : '\nFAIL')
await db.destroy()
process.exit(ok ? 0 : 1)
