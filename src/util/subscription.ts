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
import { dropReason, recordDrop } from './drops.js'
import { Gap, GapRecorder } from './gaps.js'
import { FallbackLadder, LadderName, LadderOptions } from './ladder.js'
import { SpillWriter } from './spill.js'

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
  /** current fallback-ladder rung; 'normal' when nothing is being shed */
  mode: LadderName
  /** rows written to the spill file rather than to Postgres */
  spilledRows: number
  dbUnavailable: boolean
  openGaps: { reason: string; startedAt: string; detail: string | null }[]
}

export type StreamOptions<B> = {
  name: string
  method: string
  spec: BatchSpec<B>
  writer?: WriterOptions
  /** absent means this stream sheds nothing and never spills pre-emptively */
  ladder?: LadderOptions
  /** where the disk fallback writes; null disables it */
  dataDir?: string | null
}

/**
 * Shared machinery for the repo and label streams: cursor handling, batched
 * writes with backpressure, lag measurement, gap recording, the fallback ladder
 * and graceful shutdown.
 */
export abstract class StreamSubscriptionBase<Evt, Buf> {
  public sub: Subscription<Evt>
  protected writer: BatchWriter<Buf>
  public readonly name: string
  public readonly ladder: FallbackLadder | null

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

  private gaps: GapRecorder
  /** the gap covering the interval since the stream last received anything */
  private resumeGap: Gap | null = null
  /** the gap covering the current degraded rung, if any */
  private degradedGap: Gap | null = null
  /** the gap covering the current stretch of unwritable database, if any */
  private dbGap: Gap | null = null
  private ladderTimer: NodeJS.Timeout | null = null
  private readonly dataDir: string | null

  constructor(
    public db: Database,
    public service: string,
    opts: StreamOptions<Buf>,
  ) {
    this.name = opts.name
    this.dataDir = opts.dataDir ?? null
    this.gaps = new GapRecorder(db, service)
    this.ladder = opts.ladder
      ? new FallbackLadder({
          ...opts.ladder,
          onChange: (change) => this.onLadderChange(change),
        })
      : null
    this.writer = new BatchWriter(db, service, opts.spec, {
      ...opts.writer,
      shouldSpill: () => this.ladder?.spilling ?? false,
    })
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
          // A6: counted, and logged only the first time each distinct reason is
          // seen. A frame type the vendored lexicon does not know arrives on
          // every frame, so logging each one would flood the log at exactly the
          // moment it needs to stay readable; the periodic totals carry volume.
          if (recordDrop(dropReason(`${this.name} frame`, err))) {
            logError(`${this.name} subscription skipped invalid message`, err)
          }
        }
      },
    })
  }

  /** turn one event into a synchronous buffer fill, or null if it carries nothing to store */
  protected abstract prepare(evt: Evt): Promise<Filler<Buf> | null>

  /** event timestamp in ms, used for the lag metric */
  protected abstract eventTime(evt: Evt): number | null

  /**
   * Frames that carry no sequence number but do say something about coverage.
   * Only `subscribeRepos` has any -- `#info` -- so the default is none.
   */
  protected info(_evt: Evt): { name: string; message?: string } | null {
    return null
  }

  /**
   * Everything that has to happen before the first frame: the disk fallback,
   * and the gap covering however long this stream was not running.
   */
  async init(): Promise<void> {
    if (this.dataDir) {
      this.writer.spill = await SpillWriter.create(this.dataDir, this.service)
    }

    const state = await this.readSubState()
    await this.gaps.closeOrphans(state?.lastEventAt ?? null)

    if (!state) {
      log(`${this.name} subscription starting at the live head (no cursor yet)`)
      return
    }
    if (state.lastEventAt === null) {
      log(
        `${this.name} subscription has a cursor but no watermark, so the ` +
          `interval it was down cannot be bounded; no gap recorded`,
      )
      return
    }
    // Closed by the first event that arrives. Both bounds are event times, so a
    // cursor replay that worked closes this as a near-zero interval and one that
    // did not closes it as the real hole -- without this code having to know
    // which happened.
    this.resumeGap = this.gaps.openGap('restart', state.lastEventAt, {
      detail: `collector restarted; resuming from cursor ${state.cursor}`,
    })
  }

  run(subscriptionReconnectDelay: number): Promise<void> {
    // Runs whether or not this stream has a ladder: the database being
    // unwritable is a condition every stream can be in, and it is recorded the
    // same way for all of them.
    const interval = envInt('COLLECTOR_LADDER_INTERVAL_MS', 5_000)
    this.ladderTimer = setInterval(() => {
      // Pure lagMs rather than the health endpoint's effective lag: while the
      // stream is disconnected the effective value grows on its own, which
      // would escalate the ladder over an outage during which nothing is
      // arriving to shed. On reconnect the real lag shows up within one tick.
      this.ladder?.update(this.lagMs ?? 0, this.writer.dbUnavailable)
      this.trackDbAvailability()
    }, interval)
    this.ladderTimer.unref()
    this.running = this.loop(subscriptionReconnectDelay)
    return this.running
  }

  /**
   * Open a gap for as long as batches are going to the spill file instead of to
   * Postgres. Kept separate from the ladder's own transitions: if lag is holding
   * the stream on rung 3 anyway, the ladder never changes rung when the database
   * fails or recovers, and this window would otherwise be invisible at one end
   * and never closed at the other.
   */
  private trackDbAvailability(): void {
    const down = this.writer.dbUnavailable
    if (down && !this.dbGap) {
      this.dbGap = this.gaps.openGap('db_unavailable', Date.now(), {
        detail: 'batches are being written to the spill file',
        streams: this.ladder?.streams ?? null,
      })
    } else if (!down && this.dbGap) {
      this.gaps.closeGap(
        this.dbGap,
        Date.now(),
        `run \`node dist/backfill.js\` to reconcile ${this.writer.spilledRows} spilled rows`,
      )
      this.dbGap = null
    }
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

      // Flush before opening the gap, so its start is the watermark the cursor
      // actually reached rather than one up to a flush interval short of it.
      await this.writer.flush()
      this.openResumeGap('disconnected', 'stream disconnected')

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
      // B13: abort-aware, so a SIGTERM arriving during a five-minute backoff
      // does not outlast the shutdown timer and take the buffer with it.
      await wait(delay, this.ac.signal)
      if (this.stopped) break
    }
  }

  private async handle(evt: Evt): Promise<void> {
    const info = this.info(evt)
    if (info) {
      this.handleInfo(info)
      return
    }

    const seq = seqOf(evt)
    // frames without a sequence number carry no position to record
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

    if (this.resumeGap) {
      this.gaps.closeGap(this.resumeGap, time ?? Date.now())
      this.resumeGap = null
    }

    const fill = await this.prepare(evt)
    // still recorded even when there is nothing to store, so the cursor keeps up
    await this.writer.add(fill ?? noop, seq, time)
  }

  /**
   * `#info` is how the relay says the requested cursor was outside its
   * retention and the stream was moved forward to whatever it still had. That
   * is the one case in this file where data is definitely, unrecoverably
   * missing, so it is reclassified rather than merely logged.
   */
  private handleInfo(info: { name: string; message?: string }): void {
    const detail = `relay reported ${info.name}${info.message ? `: ${info.message}` : ''}`
    if (info.name !== 'OutdatedCursor') {
      log(`${this.name} subscription: ${detail}`)
      return
    }
    logError(`${this.name} subscription: ${detail}`)
    if (this.resumeGap) {
      this.gaps.reclassify(this.resumeGap, 'cursor_expired', detail)
    } else {
      this.resumeGap = this.gaps.openGap(
        'cursor_expired',
        this.writer.committedEventAt ?? Date.now(),
        { detail },
      )
    }
  }

  private openResumeGap(
    reason: 'restart' | 'disconnected',
    detail: string,
  ): void {
    if (this.resumeGap) return
    const startedAt =
      this.writer.committedEventAt ?? this.newestEventTime ?? Date.now()
    this.resumeGap = this.gaps.openGap(reason, startedAt, { detail })
  }

  /**
   * One `degraded` row per rung, so the `streams` array on each row is exactly
   * what was being collected for that interval -- which is the sentence the
   * methods section has to be able to write.
   */
  private onLadderChange(change: {
    to: LadderName
    lagMs: number
    streams: string[]
  }): void {
    const now = Date.now()
    if (this.degradedGap) {
      this.gaps.closeGap(this.degradedGap, now)
      this.degradedGap = null
    }
    if (change.to === 'normal') return
    this.degradedGap = this.gaps.openGap('degraded', now, {
      detail: `${change.to} (lag ${(change.lagMs / 1000).toFixed(1)}s)`,
      streams: change.streams,
    })
  }

  /** stop consuming, flush what is buffered, persist the cursor */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.ac.abort()
    if (this.ladderTimer) {
      clearInterval(this.ladderTimer)
      this.ladderTimer = null
    }
    if (this.running) await this.running.catch(() => {})
    await this.writer.close()
    // The shutdown itself is the start of the next gap; the run that comes back
    // closes it from its own watermark, so nothing is opened here.
    if (this.degradedGap) {
      this.gaps.closeGap(this.degradedGap, Date.now(), 'collector shut down')
      this.degradedGap = null
    }
    if (this.dbGap) {
      this.gaps.closeGap(this.dbGap, Date.now(), 'collector shut down')
      this.dbGap = null
    }
    if (this.resumeGap) {
      this.gaps.closeGap(this.resumeGap, Date.now(), 'collector shut down')
      this.resumeGap = null
    }
    await this.gaps.shutdown()
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
      mode: this.ladder?.name ?? 'normal',
      spilledRows: this.writer.spilledRows,
      dbUnavailable: this.writer.dbUnavailable,
      openGaps: this.gaps.open.map((gap) => ({
        reason: gap.reason,
        startedAt: new Date(gap.startedAt).toISOString(),
        detail: gap.detail,
      })),
    }
  }

  private async readSubState(): Promise<{
    cursor: number
    lastEventAt: number | null
  } | null> {
    const res = await this.db
      .selectFrom('sub_state')
      .selectAll()
      .where('service', '=', this.service)
      .executeTakeFirst()
    if (!res) return null
    const lastEventAt = res.lastEventAt ? new Date(res.lastEventAt).getTime() : null
    return {
      cursor: Number(res.cursor),
      lastEventAt: lastEventAt !== null && Number.isFinite(lastEventAt) ? lastEventAt : null,
    }
  }

  async getCursor(): Promise<{ cursor?: number }> {
    const state = await this.readSubState()
    if (!state) return {}
    log(`${this.name} subscription resuming from cursor ${state.cursor}`)
    return { cursor: state.cursor }
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

/**
 * Which record collections are worth decoding out of a commit.
 *
 * Part D sheds by *not decoding*, not by dropping rows after the fact: the CAR
 * lookup, the CBOR decode and the lexicon validation are where the CPU goes, and
 * Node has one thread to spend. Filtering here is what makes shedding likes an
 * actual throughput lever rather than a way to write fewer rows.
 */
export type WantedOps = {
  likes?: boolean
  reposts?: boolean
}

export const getOpsByType = async (
  evt: Commit,
  want: WantedOps = {},
): Promise<OperationsByType> => {
  const wantLikes = want.likes ?? true
  const wantReposts = want.reposts ?? true
  const car = await readCar(evt.blocks)
  const opsByType: OperationsByType = {
    posts: { creates: [], updates: [], deletes: [] },
    reposts: { creates: [], updates: [], deletes: [] },
    likes: { creates: [], updates: [], deletes: [] },
  }

  for (const op of evt.ops) {
    const uri = `at://${evt.repo}/${op.path}`
    const [collection] = op.path.split('/')

    if (collection === ids.AppBskyFeedLike && !wantLikes) continue
    if (collection === ids.AppBskyFeedRepost && !wantReposts) continue

    if (op.action === 'create' || op.action === 'update') {
      if (!op.cid) {
        if (isCollected(collection)) recordDrop(`${collection}: op without cid`)
        continue
      }
      const recordBytes = car.blocks.get(op.cid)
      if (!recordBytes) {
        if (isCollected(collection)) {
          recordDrop(`${collection}: record block missing from the commit`)
        }
        continue
      }
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

/** the three collections the project stores; everything else is out of scope, not dropped */
const isCollected = (collection: string): boolean =>
  collection === ids.AppBskyFeedPost ||
  collection === ids.AppBskyFeedRepost ||
  collection === ids.AppBskyFeedLike

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
    // A6: the collection has already been matched by the caller, so this is a
    // record the project wanted and could not use -- an exclusion from the
    // corpus, not a record of some other type passing by.
    if (recordDrop(dropReason(nsid, err))) {
      logError(`dropping invalid ${nsid} record`, err)
    }
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
