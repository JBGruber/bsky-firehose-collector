import { log } from './common.js'

/**
 * Part D -- the fallback ladder.
 *
 * Once the writer applies real backpressure, falling behind is a measurable,
 * recoverable condition rather than the prelude to an OOM kill. What is left is
 * a policy question: which data to stop collecting first, and when. Shed the
 * least valuable stream first, and record what was shed -- a documented gap is
 * recoverable science, a silent one is not.
 *
 *   lag < 60 s     everything
 *   lag > 60 s     shed likes    -- highest volume, least central to deletion
 *   lag > 300 s    shed reposts  -- posts, deletions and account events only
 *   lag > 900 s    spill to disk
 *   database down  spill to disk, shedding nothing
 *
 * The last two rungs are deliberately not the same condition. Reaching rung 3
 * through lag means rungs 1 and 2 are already in force and the stream still
 * cannot keep up. Reaching it because Postgres is unreachable says nothing about
 * volume: shedding likes there would throw away data that the disk could have
 * taken at no cost. So shedding follows lag alone, and spilling follows either.
 */
export const LADDER_NAMES = [
  'normal',
  'shed_likes',
  'shed_reposts',
  'spill',
] as const

export type LadderName = (typeof LADDER_NAMES)[number]

export type LadderOptions = {
  shedLikesLagMs?: number
  shedRepostsLagMs?: number
  spillLagMs?: number
  /** how long lag must stay down before stepping back up one rung */
  recoverAfterMs?: number
  /** how long to watch the trend before deciding to shed */
  probeMs?: number
  /** a backlog that will clear within this long is caught up, not shed */
  catchUpWithinMs?: number
  onChange?: (change: LadderChange) => void
}

export type LadderChange = {
  from: LadderName
  to: LadderName
  lagMs: number
  /** data categories still being collected at the new rung */
  streams: string[]
}

/** everything the repo stream collects, most valuable last to be shed */
const ALL_STREAMS = [
  'posts',
  'deletions',
  'media',
  'accounts',
  'reposts',
  'likes',
]

/**
 * Margin on the way back up. Leaving a rung needs lag below 80% of the threshold
 * that caused it, sustained -- without it a stream sitting exactly on 60 s would
 * transition every recovery interval and write a gap row each time.
 */
const RECOVER_MARGIN = 0.8

/** at most one "catching up, not shedding" line per minute */
const CATCH_UP_LOG_INTERVAL_MS = 60_000

export class FallbackLadder {
  /** the rung lag alone justifies, 0-3 */
  private lagRung = 0
  private dbDown = false
  /** when lag first dropped below the current rung's re-entry threshold */
  private belowSince: number | null = null
  private lastLagMs = 0
  /** start of the window in which the lag trend is being watched */
  private probeSince: number | null = null
  private probeLag = 0
  private lastCatchUpLog = 0

  private readonly thresholds: [number, number, number]
  private readonly recoverAfterMs: number
  private readonly probeMs: number
  private readonly catchUpWithinMs: number
  private readonly onChange: (change: LadderChange) => void

  constructor(opts: LadderOptions = {}) {
    this.thresholds = [
      opts.shedLikesLagMs ?? 60_000,
      opts.shedRepostsLagMs ?? 300_000,
      opts.spillLagMs ?? 900_000,
    ]
    this.recoverAfterMs = opts.recoverAfterMs ?? 120_000
    this.probeMs = opts.probeMs ?? 15_000
    this.catchUpWithinMs = opts.catchUpWithinMs ?? 1_800_000
    this.onChange = opts.onChange ?? (() => {})
  }

  get level(): number {
    return this.dbDown ? Math.max(this.lagRung, 3) : this.lagRung
  }

  /** the combined rung, for reporting */
  get name(): LadderName {
    return LADDER_NAMES[this.level]
  }

  /**
   * The rung lag alone accounts for. Transitions are announced against this
   * rather than against `name`, because the two conditions have to stay
   * separable: a database outage while lag already holds the stream on rung 3
   * would otherwise be invisible, and -- worse -- the recovery of the database
   * would be too, leaving a `db_unavailable` gap open long after the database
   * came back. The stream tracks that condition on its own.
   */
  get lagName(): LadderName {
    return LADDER_NAMES[this.lagRung]
  }

  /** likes and reposts are shed by lag only -- see the note at the top */
  get collectLikes(): boolean {
    return this.lagRung < 1
  }

  get collectReposts(): boolean {
    return this.lagRung < 2
  }

  get spilling(): boolean {
    return this.level >= 3
  }

  get streams(): string[] {
    return ALL_STREAMS.filter(
      (name) =>
        (name !== 'likes' || this.collectLikes) &&
        (name !== 'reposts' || this.collectReposts),
    )
  }

  /**
   * Escalate the moment lag crosses a threshold; de-escalate one rung at a time,
   * and only after lag has stayed down for a sustained interval. The asymmetry
   * is the point: falling behind compounds, so the response has to be immediate,
   * while stepping back up too eagerly just puts the load straight back on.
   */
  update(lagMs: number, dbUnavailable: boolean, now = Date.now()): void {
    this.lastLagMs = lagMs

    if (dbUnavailable !== this.dbDown) {
      this.dbDown = dbUnavailable
      log(
        dbUnavailable
          ? 'fallback ladder: database unavailable, batches are going to disk'
          : 'fallback ladder: database is back',
      )
    }

    const target = this.rungForLag(lagMs)
    if (target > this.lagRung) {
      if (this.shouldShed(lagMs, now)) {
        const from = this.lagName
        this.lagRung = target
        this.belowSince = null
        this.announce(from)
      }
      return
    }
    this.probeSince = null

    if (this.lagRung === 0) {
      this.belowSince = null
      return
    }

    // still above the re-entry threshold for the rung it is on
    if (lagMs >= this.thresholds[this.lagRung - 1] * RECOVER_MARGIN) {
      this.belowSince = null
      return
    }

    if (this.belowSince === null) {
      this.belowSince = now
      return
    }
    if (now - this.belowSince >= this.recoverAfterMs) {
      const from = this.lagName
      this.lagRung--
      this.belowSince = null
      this.announce(from)
    }
  }

  /**
   * Being behind is not the same as being unable to keep up, and shedding is
   * only the right answer to the second.
   *
   * Measured on a real restart: a 6m24s stop was fully covered by the cursor
   * replay, but the replay put lag at 388 s, the ladder read that as overload,
   * and ~121,000 likes and ~17,000 reposts were shed during the catch-up --
   * data the relay still held and would have handed over. Every post came back;
   * the engagement did not. Shedding traded away data that was not at risk.
   *
   * So the question is not "how far behind is it" but "will this clear". Watch
   * the trend for `probeMs`, project the current rate of improvement forward,
   * and shed only if the backlog would not clear within `catchUpWithinMs`. A
   * stream that is genuinely overloaded shows lag flat or rising and sheds a few
   * seconds later than it used to; a stream replaying a known gap sheds nothing.
   * A very deep backlog -- days rather than minutes -- still sheds, because
   * there the rate of improvement is what decides whether it ever catches up.
   */
  private shouldShed(lagMs: number, now: number): boolean {
    if (this.probeSince === null) {
      this.probeSince = now
      this.probeLag = lagMs
      return false
    }
    const elapsed = now - this.probeSince
    if (elapsed < this.probeMs) return false

    const dropPerMs = (this.probeLag - lagMs) / elapsed
    // either way the next tick starts a fresh window, so a stream whose
    // recovery stalls is re-evaluated rather than exempted indefinitely
    this.probeSince = null
    if (dropPerMs <= 0) return true

    const clearInMs = lagMs / dropPerMs
    if (clearInMs > this.catchUpWithinMs) return true

    if (now - this.lastCatchUpLog >= CATCH_UP_LOG_INTERVAL_MS) {
      this.lastCatchUpLog = now
      log(
        `fallback ladder: ${(lagMs / 1000).toFixed(0)}s behind but catching up ` +
          `(clear in ~${(clearInMs / 60_000).toFixed(1)} min); shedding nothing`,
      )
    }
    return false
  }

  private rungForLag(lagMs: number): number {
    if (lagMs > this.thresholds[2]) return 3
    if (lagMs > this.thresholds[1]) return 2
    if (lagMs > this.thresholds[0]) return 1
    return 0
  }

  private announce(from: LadderName): void {
    const to = this.lagName
    if (from === to) return
    log(
      `fallback ladder: ${from} -> ${to} (lag ${(this.lastLagMs / 1000).toFixed(1)}s); ` +
        `collecting ${this.streams.join(', ')}`,
    )
    this.onChange({ from, to, lagMs: this.lastLagMs, streams: this.streams })
  }
}
