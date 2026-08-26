import { Subscription } from '@atproto/xrpc-server'
import { ids, lexicons } from './src/lexicon/lexicons.js'
import {
  OutputSchema as RepoEvent,
  isCommit,
} from './src/lexicon/types/com/atproto/sync/subscribeRepos.js'
import { getOpsByType } from './src/util/subscription.js'
import { dropStats } from './src/util/drops.js'

// Part D sheds by not decoding. Take the same live commits twice -- once with
// everything wanted, once at rung 1 and once at rung 2 -- and compare both what
// comes out and what it costs.
const SECONDS = Number(process.env.SECONDS ?? 45)

const ac = new AbortController()
const sub = new Subscription<RepoEvent>({
  service: 'wss://bsky.network',
  method: ids.ComAtprotoSyncSubscribeRepos,
  signal: ac.signal,
  validate: (value: unknown) => {
    try {
      return lexicons.assertValidXrpcMessage<RepoEvent>(ids.ComAtprotoSyncSubscribeRepos, value)
    } catch { return undefined }
  },
})

type Tally = { posts: number; likes: number; reposts: number; deletes: number; us: number }
const tally = (): Tally => ({ posts: 0, likes: 0, reposts: 0, deletes: 0, us: 0 })
const all = tally(), rung1 = tally(), rung2 = tally()

const measure = async (evt: any, want: any, into: Tally) => {
  const t = process.hrtime.bigint()
  const ops = await getOpsByType(evt, want)
  into.us += Number(process.hrtime.bigint() - t) / 1000
  into.posts += ops.posts.creates.length + ops.posts.updates.length
  into.likes += ops.likes.creates.length
  into.reposts += ops.reposts.creates.length
  into.deletes += ops.posts.deletes.length + ops.likes.deletes.length + ops.reposts.deletes.length
}

let commits = 0
const stop = setTimeout(() => ac.abort(), SECONDS * 1000)
try {
  for await (const evt of sub) {
    if (!isCommit(evt)) continue
    commits++
    await measure(evt, {}, all)
    await measure(evt, { likes: false }, rung1)
    await measure(evt, { likes: false, reposts: false }, rung2)
  }
} catch { /* aborted */ }
clearTimeout(stop)

const line = (name: string, t: Tally) =>
  console.log(
    `${name.padEnd(14)} posts ${String(t.posts).padStart(6)} | likes ${String(t.likes).padStart(6)} | ` +
    `reposts ${String(t.reposts).padStart(5)} | deletes ${String(t.deletes).padStart(5)} | ` +
    `${(t.us / commits).toFixed(1)} us/commit`,
  )

console.log(`\n${commits} commits over ${SECONDS}s from wss://bsky.network\n`)
line('normal', all)
line('shed_likes', rung1)
line('shed_reposts', rung2)
console.log(`\ndecode cost: rung 1 is ${((1 - rung1.us / all.us) * 100).toFixed(1)}% cheaper, rung 2 ${((1 - rung2.us / all.us) * 100).toFixed(1)}% cheaper`)
const d = dropStats()
console.log(`\nA6 drops during the run: ${d.total}`)
for (const [reason, n] of Object.entries(d.byReason)) console.log(`  ${n}x ${reason}`)
process.exit(0)
