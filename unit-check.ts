import assert from 'assert'
import { rm, mkdtemp } from 'fs/promises'
import { readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { wait } from './src/util/common.js'
import { FallbackLadder } from './src/util/ladder.js'
import { recordDrop, dropStats, dropReason } from './src/util/drops.js'
import { SpillWriter, pendingSpillFiles } from './src/util/spill.js'

let failures = 0
const check = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch((err) => {
      failures++
      console.log(`  FAIL ${name}: ${err.message}`)
    })

const run = async () => {
  console.log('B13 -- abort-aware wait')
  await check('resolves on the timer when no signal is given', async () => {
    const t = Date.now()
    await wait(60)
    assert.ok(Date.now() - t >= 55, `returned after ${Date.now() - t}ms`)
  })
  await check('resolves immediately when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const t = Date.now()
    await wait(300_000, ac.signal)
    assert.ok(Date.now() - t < 50, `took ${Date.now() - t}ms`)
  })
  await check('resolves when the signal aborts mid-wait', async () => {
    const ac = new AbortController()
    const t = Date.now()
    setTimeout(() => ac.abort(), 40)
    await wait(300_000, ac.signal)
    const dt = Date.now() - t
    assert.ok(dt >= 35 && dt < 400, `took ${dt}ms`)
  })
  await check('does not leave the event loop alive after an abort', async () => {
    // the timer must be cleared, or node would sit here for five minutes
    const ac = new AbortController()
    const p = wait(300_000, ac.signal)
    ac.abort()
    await p
  })

  console.log('Part D -- ladder')
  const changes: string[] = []
  const ladder = new FallbackLadder({
    shedLikesLagMs: 60_000,
    shedRepostsLagMs: 300_000,
    spillLagMs: 900_000,
    recoverAfterMs: 120_000,
    onChange: (c) => changes.push(`${c.from}->${c.to}`),
  })
  await check('starts normal, collecting everything', () => {
    assert.equal(ladder.name, 'normal')
    assert.ok(ladder.collectLikes && ladder.collectReposts && !ladder.spilling)
    assert.deepEqual(ladder.streams, ['posts','deletions','media','accounts','reposts','likes'])
  })
  await check('sheds likes above 60s', () => {
    ladder.update(61_000, false, 0)
    assert.equal(ladder.name, 'shed_likes')
    assert.equal(ladder.collectLikes, false)
    assert.equal(ladder.collectReposts, true)
    assert.deepEqual(ladder.streams, ['posts','deletions','media','accounts','reposts'])
  })
  await check('escalates straight past a rung when lag jumps', () => {
    ladder.update(901_000, false, 1_000)
    assert.equal(ladder.name, 'spill')
    assert.ok(ladder.spilling && !ladder.collectLikes && !ladder.collectReposts)
  })
  await check('does not step back up until lag has stayed down', () => {
    ladder.update(10_000, false, 2_000)     // below, clock starts
    assert.equal(ladder.name, 'spill')
    ladder.update(10_000, false, 100_000)   // 98s later, not yet
    assert.equal(ladder.name, 'spill')
    ladder.update(10_000, false, 130_000)   // 128s, one rung
    assert.equal(ladder.name, 'shed_reposts')
  })
  await check('steps back up one rung at a time', () => {
    ladder.update(10_000, false, 131_000)
    ladder.update(10_000, false, 260_000)
    assert.equal(ladder.name, 'shed_likes')
    ladder.update(10_000, false, 261_000)
    ladder.update(10_000, false, 390_000)
    assert.equal(ladder.name, 'normal')
    assert.ok(ladder.collectLikes && ladder.collectReposts)
  })
  await check('the recovery margin stops a stream sitting on the threshold flapping', () => {
    const l = new FallbackLadder({ recoverAfterMs: 1_000 })
    l.update(61_000, false, 0)
    assert.equal(l.name, 'shed_likes')
    l.update(55_000, false, 10_000)   // below 60s but above 48s
    l.update(55_000, false, 20_000)
    assert.equal(l.name, 'shed_likes')
    l.update(47_000, false, 30_000)
    l.update(47_000, false, 40_000)
    assert.equal(l.name, 'normal')
  })
  await check('a database outage stays separable from lag', () => {
    // the two conditions must not collapse into one rung, or the recovery of
    // the database is invisible while lag holds the stream on rung 3
    const l = new FallbackLadder({ recoverAfterMs: 1_000 })
    l.update(901_000, false, 0)
    assert.equal(l.name, 'spill')
    l.update(901_000, true, 1_000)   // database fails while already on rung 3
    assert.equal(l.spilling, true)
    l.update(901_000, false, 2_000)  // and comes back, lag unchanged
    assert.equal(l.spilling, true)
    assert.equal(l.lagName, 'spill')
  })
  await check('a database outage spills without shedding anything', () => {
    const seen: string[] = []
    const l = new FallbackLadder({ onChange: (c) => seen.push(`${c.from}->${c.to}`) })
    l.update(0, true, 0)
    assert.equal(l.name, 'spill')
    assert.ok(l.spilling)
    assert.equal(l.collectLikes, true, 'likes must not be shed for a db outage')
    assert.equal(l.collectReposts, true)
    assert.equal(l.lagName, 'normal', 'lag accounts for none of this')
    assert.deepEqual(seen, [], 'a db outage is not a ladder transition -- the stream records it')
    l.update(0, false, 1_000)
    assert.equal(l.name, 'normal')
  })
  await check('every transition was announced', () => {
    assert.deepEqual(changes, [
      'normal->shed_likes',
      'shed_likes->spill',
      'spill->shed_reposts',
      'shed_reposts->shed_likes',
      'shed_likes->normal',
    ])
  })

  console.log('A6 -- drop counters')
  await check('counts by reason and reports the first sighting', () => {
    const first = recordDrop('app.bsky.feed.post: Record/createdAt must be a string')
    const second = recordDrop('app.bsky.feed.post: Record/createdAt must be a string')
    assert.equal(first, true)
    assert.equal(second, false)
    recordDrop('app.bsky.feed.like: Record must have the property "subject"')
    const stats = dropStats()
    assert.equal(stats.total, 3)
    assert.equal(stats.byReason['app.bsky.feed.post: Record/createdAt must be a string'], 2)
  })
  await check('caps distinct reasons so a noisy validator cannot grow the map', () => {
    for (let i = 0; i < 200; i++) recordDrop(`synthetic reason ${i}`)
    const stats = dropStats()
    assert.ok(Object.keys(stats.byReason).length <= 64, `${Object.keys(stats.byReason).length} reasons`)
    assert.ok(stats.byReason['other'] > 0, 'overflow is counted under other')
  })
  await check('dropReason flattens a validation error to one line', () => {
    const r = dropReason('app.bsky.feed.post', new Error('Record/createdAt\n  must be a\tstring'))
    assert.equal(r, 'app.bsky.feed.post: Record/createdAt must be a string')
  })

  console.log('Part D -- spill file')
  const dir = await mkdtemp(join(tmpdir(), 'spill-test-'))
  await check('writes one NDJSON line per batch and fsyncs it', async () => {
    const w = await SpillWriter.create(dir, 'wss://bsky.network')
    assert.ok(w)
    const ok = await w!.write({ seq: 42, tables: { post: [{ uri: 'at://a', text: 'x' }] } })
    assert.equal(ok, true)
    await w!.write({ seq: 43, tables: { engagement: [{ uri: 'at://b' }, { uri: 'at://c' }] } })
    assert.equal(w!.rowsWritten, 3)
    assert.equal(w!.linesWritten, 2)
    await w!.close()

    const files = await pendingSpillFiles(dir)
    assert.equal(files.length, 1, `found ${files.join(', ')}`)
    const lines = readFileSync(files[0], 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0])
    assert.equal(first.v, 1)
    assert.equal(first.seq, 42)
    assert.equal(first.service, 'wss://bsky.network')
    assert.deepEqual(first.tables.post, [{ uri: 'at://a', text: 'x' }])
  })
  await check('an empty batch is a no-op rather than a blank line', async () => {
    const w = await SpillWriter.create(dir, 'wss://empty.example')
    assert.equal(await w!.write({ seq: 1, tables: {} }), true)
    assert.equal(w!.linesWritten, 0)
    await w!.close()
    const files = await pendingSpillFiles(dir)
    assert.equal(files.length, 1, 'no file is created for a batch with no rows')
  })
  await check('an unusable directory disables the fallback instead of throwing', async () => {
    const blocker = join(dir, 'not-a-dir')
    writeFileSync(blocker, 'x')
    const w = await SpillWriter.create(join(blocker, 'sub'), 'wss://x')
    assert.equal(w, null)
  })
  await rm(dir, { recursive: true, force: true })

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

run()
