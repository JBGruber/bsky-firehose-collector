import { Subscription } from '@atproto/xrpc-server'
import { cborToLexRecord, readCar } from '@atproto/repo'
import { BlobRef } from '@atproto/lexicon'
import { ids, lexicons } from '../lexicon/lexicons.js'
import { Record as PostRecord } from '../lexicon/types/app/bsky/feed/post.js'
import { Record as RepostRecord } from '../lexicon/types/app/bsky/feed/repost.js'
import { Record as LikeRecord } from '../lexicon/types/app/bsky/feed/like.js'
import { Commit } from '../lexicon/types/com/atproto/sync/subscribeRepos.js'
import { Database } from '../db/index.js'
import { BatchSpec, BatchWriter, Filler, WriterOptions } from './batchWriter.js'
import { backoffDelay, envInt, log, logError, wait } from './common.js'

export type StreamStats = {
  name: string
  service: string
  connected: boolean
  eventsSeen: number
  rowsWritten: number
  flushErrors: number
  reconnects: number
  bufferDepth: number
  /** how far behind the stream is, in ms, from the event's own timestamp */
  lagMs: number | null
  lastEventAt: number | null
  lastFlushAt: number | null
  committedSeq: number | null
}

export type StreamOptions<B> = {
  name: string
  method: string
  spec: BatchSpec<B>
  writer?: WriterOptions
}

/**
 * Shared machinery for the repo and label streams: cursor handling, batched
 * writes with backpressure, lag measurement and graceful shutdown.
 */
export abstract class StreamSubscriptionBase<Evt, Buf> {
  public sub: Subscription<Evt>
  protected writer: BatchWriter<Buf>
  public readonly name: string

  private ac = new AbortController()
  private stopped = false
  private running: Promise<void> | null = null

  private connected = false
  private eventsSeen = 0
  private reconnects = 0
  private lagMs: number | null = null
  private lastEventAt: number | null = null
  /** newest event timestamp seen on the current connection -- see handle() */
  private newestEventTime: number | null = null

  constructor(
    public db: Database,
    public service: string,
    opts: StreamOptions<Buf>,
  ) {
    this.name = opts.name
    this.writer = new BatchWriter(db, service, opts.spec, opts.writer)
    this.sub = new Subscription({
      service: service,
      method: opts.method,
      signal: this.ac.signal,
      // called again on every (re)connect, so the stream always resumes from
      // the last durably committed cursor
      getParams: () => this.getCursor(),
      // the ws keepalive reconnects on network errors by itself, with its own
      // exponential backoff -- count those too, or the metric hides them
      onReconnectError: (err, n) => {
        this.connected = false
        this.reconnects++
        logError(`${this.name} subscription reconnecting (attempt ${n})`, err)
      },
      validate: (value: unknown) => {
        try {
          return lexicons.assertValidXrpcMessage<Evt>(opts.method, value)
        } catch (err) {
          logError(`${this.name} subscription skipped invalid message`, err)
        }
      },
    })
  }

  /** turn one event into a synchronous buffer fill, or null if it carries nothing to store */
  protected abstract prepare(evt: Evt): Promise<Filler<Buf> | null>

  /** event timestamp in ms, used for the lag metric */
  protected abstract eventTime(evt: Evt): number | null

  run(subscriptionReconnectDelay: number): Promise<void> {
    this.running = this.loop(subscriptionReconnectDelay)
    return this.running
  }

  private async loop(subscriptionReconnectDelay: number): Promise<void> {
    const ceilingMs = envInt('COLLECTOR_RECONNECT_MAX_DELAY_MS', 300_000)
    // how long a connection has to survive before it counts as evidence that
    // the endpoint is healthy again
    const stableMs = envInt('COLLECTOR_RECONNECT_STABLE_MS', 60_000)
    let attempt = 0

    while (!this.stopped) {
      let connectedAt: number | null = null
      try {
        for await (const evt of this.sub) {
          if (connectedAt === null) {
            connectedAt = Date.now()
            this.newestEventTime = null
          }
          this.connected = true
          await this.handle(evt)
          if (this.stopped) break
          if (this.writer.needsReset) {
            this.writer.reset()
            throw new Error(
              'batch write failed; resubscribing from last committed cursor',
            )
          }
        }
      } catch (err) {
        if (!this.stopped) {
          this.reconnects++
          logError(`${this.name} subscription errored`, err)
        }
      }
      this.connected = false
      if (this.stopped) break

      // Reset only after a connection that actually held. Resetting on the
      // first frame instead would let a flapping endpoint -- connect, one
      // frame, drop -- retry at the base delay forever.
      if (connectedAt !== null && Date.now() - connectedAt >= stableMs) {
        attempt = 0
      }
      attempt++

      const delay = backoffDelay(attempt, subscriptionReconnectDelay, ceilingMs)
      log(
        `${this.name} subscription reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${attempt})`,
      )
      await wait(delay)
    }
  }

  private async handle(evt: Evt): Promise<void> {
    const seq = seqOf(evt)
    // frames without a sequence number (#info) carry no position to record
    if (seq === null) return

    this.eventsSeen++
    this.lastEventAt = Date.now()
    // Lag is measured against the newest event seen, not the last one. Frames
    // are not delivered in timestamp order: a PDS coming back online replays
    // days of history into an otherwise current stream, and 0.4% of frames in a
    // live sample were over a minute old, the oldest by 8.8 days. Taking the
    // last event's age let any one of those read as days of lag, which is the
    // signal the health check and the Part D ladder are supposed to act on.
    //
    // The newest time is per-connection: after a reconnect the stream may be
    // genuinely behind, and a value carried over from before would hide it.
    const time = this.eventTime(evt)
    if (
      time !== null &&
      time <= Date.now() + MAX_CLOCK_AHEAD_MS &&
      (this.newestEventTime === null || time > this.newestEventTime)
    ) {
      this.newestEventTime = time
    }
    if (this.newestEventTime !== null) {
      this.lagMs = Date.now() - this.newestEventTime
    }

    const fill = await this.prepare(evt)
    // still recorded even when there is nothing to store, so the cursor keeps up
    await this.writer.add(fill ?? noop, seq)
  }

  /** stop consuming, flush what is buffered, persist the cursor */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.ac.abort()
    if (this.running) await this.running.catch(() => {})
    await this.writer.close()
    log(
      `${this.name} subscription stopped at cursor ${this.writer.committedSeq ?? 'none'}`,
    )
  }

  stats(): StreamStats {
    return {
      name: this.name,
      service: this.service,
      connected: this.connected,
      eventsSeen: this.eventsSeen,
      rowsWritten: this.writer.rowsWritten,
      flushErrors: this.writer.flushErrors,
      reconnects: this.reconnects,
      bufferDepth: this.writer.depth,
      lagMs: this.lagMs,
      lastEventAt: this.lastEventAt,
      lastFlushAt: this.writer.lastFlushAt,
      committedSeq: this.writer.committedSeq,
    }
  }

  async getCursor(): Promise<{ cursor?: number }> {
    const res = await this.db
      .selectFrom('sub_state')
      .selectAll()
      .where('service', '=', this.service)
      .executeTakeFirst()

    if (!res) return {}
    const cursor = Number(res.cursor)
    log(`${this.name} subscription resuming from cursor ${cursor}`)
    return { cursor }
  }
}

/**
 * An event timestamp further ahead than this is ignored when tracking the
 * newest event: relay clocks run a few seconds ahead of local time in normal
 * operation, but one badly wrong frame must not be able to peg lag at zero and
 * mask a stream that is genuinely behind.
 */
const MAX_CLOCK_AHEAD_MS = 5 * 60 * 1000

const noop = () => {}

const seqOf = (evt: unknown): number | null => {
  if (evt && typeof evt === 'object' && 'seq' in evt) {
    const seq = (evt as { seq: unknown }).seq
    if (typeof seq === 'number' && Number.isFinite(seq)) return seq
  }
  return null
}

export const getOpsByType = async (evt: Commit): Promise<OperationsByType> => {
  const car = await readCar(evt.blocks)
  const opsByType: OperationsByType = {
    posts: { creates: [], updates: [], deletes: [] },
    reposts: { creates: [], updates: [], deletes: [] },
    likes: { creates: [], updates: [], deletes: [] },
  }

  for (const op of evt.ops) {
    const uri = `at://${evt.repo}/${op.path}`
    const [collection] = op.path.split('/')

    if (op.action === 'create' || op.action === 'update') {
      if (!op.cid) continue
      const recordBytes = car.blocks.get(op.cid)
      if (!recordBytes) continue
      const record = cborToLexRecord(recordBytes)
      const write = { uri, cid: op.cid.toString(), author: evt.repo }
      if (collection === ids.AppBskyFeedPost && isPost(record)) {
        // An edit replaces the post's content: the previous text, embeds and
        // link card stop being publicly visible exactly as a deletion would
        // remove them, so it belongs to what the project measures. `post` is
        // keyed (uri, indexedAt), which makes it a version table -- the edit is
        // an additional row rather than an overwrite of the original.
        const bucket =
          op.action === 'update'
            ? opsByType.posts.updates
            : opsByType.posts.creates
        bucket.push({ record, ...write })
      } else if (op.action === 'update') {
        // Likes and reposts carry nothing editable -- only a subject and a
        // timestamp -- and an update op on one is vanishingly rare. Recording it
        // would add a second engagement row for the same uri and inflate every
        // count derived from the table, so it is skipped rather than stored.
        continue
      } else if (collection === ids.AppBskyFeedRepost && isRepost(record)) {
        opsByType.reposts.creates.push({ record, ...write })
      } else if (collection === ids.AppBskyFeedLike && isLike(record)) {
        opsByType.likes.creates.push({ record, ...write })
      }
    }

    if (op.action === 'delete') {
      if (collection === ids.AppBskyFeedPost) {
        opsByType.posts.deletes.push({ uri })
      } else if (collection === ids.AppBskyFeedRepost) {
        opsByType.reposts.deletes.push({ uri })
      } else if (collection === ids.AppBskyFeedLike) {
        opsByType.likes.deletes.push({ uri })
      }
    }
  }

  return opsByType
}

type OperationsByType = {
  posts: Operations<PostRecord>
  reposts: Operations<RepostRecord>
  likes: Operations<LikeRecord>
}

type Operations<T = Record<string, unknown>> = {
  creates: WriteOp<T>[]
  /** only ever populated for posts -- see getOpsByType */
  updates: WriteOp<T>[]
  deletes: DeleteOp[]
}

type WriteOp<T> = {
  uri: string
  cid: string
  author: string
  record: T
}

type DeleteOp = {
  uri: string
}

export const isPost = (obj: unknown): obj is PostRecord => {
  return isType(obj, ids.AppBskyFeedPost)
}

export const isRepost = (obj: unknown): obj is RepostRecord => {
  return isType(obj, ids.AppBskyFeedRepost)
}

export const isLike = (obj: unknown): obj is LikeRecord => {
  return isType(obj, ids.AppBskyFeedLike)
}

const isType = (obj: unknown, nsid: string) => {
  try {
    lexicons.assertValidRecord(nsid, toBlobRefs(obj))
    return true
  } catch (err) {
    return false
  }
}

/**
 * `cborToLexRecord` decodes blobs into plain lex-data objects
 * (`{ $type: 'blob', ref, mimeType, size }`), but the lexicon validator still
 * requires `BlobRef` instances, so every record carrying an image or video has
 * to be converted before it will validate. Skipping this silently rejects about
 * a third of all posts -- every one with media or a link-card thumbnail.
 */
const toBlobRefs = (obj: unknown): unknown => {
  if (Array.isArray(obj)) {
    return obj.map(toBlobRefs)
  }
  if (obj && typeof obj === 'object') {
    if (obj instanceof BlobRef) return obj
    const blob = BlobRef.asBlobRef(obj)
    if (blob) return blob
    return Object.entries(obj).reduce((acc, [key, val]) => {
      return Object.assign(acc, { [key]: toBlobRefs(val) })
    }, {} as Record<string, unknown>)
  }
  return obj
}
