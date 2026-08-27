import { createDb, connectionStringFromEnv } from './src/db/index.js'
import { StreamSubscriptionBase } from './src/util/subscription.js'
import { BatchSpec, Filler } from './src/util/batchWriter.js'

// B13 is about the outer reconnect backoff in loop(), which the ws-client's own
// internal retry usually hides. Replace the subscription with one that throws at
// once, so the loop is guaranteed to be sitting in `await wait(delay, signal)`
// when SIGTERM arrives.
type Buf = { rows: never[] }
const spec: BatchSpec<Buf> = {
  empty: () => ({ rows: [] }),
  size: () => 0,
  tables: () => ({}),
  write: async () => {},
}

class AlwaysFailing extends StreamSubscriptionBase<unknown, Buf> {
  constructor(db: any, service: string) {
    super(db, service, { name: 'test', method: 'com.atproto.sync.subscribeRepos', spec })
    // an iterable that throws on the first pull
    this.sub = {
      [Symbol.asyncIterator]: () => ({
        next: async () => { throw new Error('endpoint is down') },
      }),
    } as any
  }
  protected async prepare(): Promise<Filler<Buf> | null> { return null }
  protected eventTime(): number | null { return null }
}

const db = createDb(connectionStringFromEnv(), { max: 2 })
// base delay 90s -> first backoff is 45-90s with equal jitter
const stream = new AlwaysFailing(db, 'wss://b13-test.invalid')
await stream.init()
stream.run(90_000).catch(() => {})

// let it fail and settle into the backoff wait
await new Promise((r) => setTimeout(r, 2_000))

const t = Date.now()
await stream.stop()
const elapsed = Date.now() - t
await db.destroy()

console.log(`\nstop() returned in ${elapsed}ms while the backoff delay was 45-90s`)
console.log(elapsed < 2_000 ? 'PASS -- the wait was interrupted by the abort signal' : 'FAIL -- shutdown waited for the timer')
process.exit(elapsed < 2_000 ? 0 : 1)
