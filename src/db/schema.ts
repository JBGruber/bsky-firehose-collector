import { ColumnType, Generated } from 'kysely'

/**
 * Postgres hands back `Date` for timestamptz and `string` for bigint, while the
 * collector always inserts ISO strings and numbers. `ColumnType` records that
 * asymmetry rather than letting the select side quietly lie.
 */
type Timestamptz = ColumnType<Date, string, string>
type TimestamptzOrNull = ColumnType<Date | null, string | null, string | null>
type Bigint = ColumnType<string, number, number>

export type DatabaseSchema = {
  post: Post
  post_deletion: Deletion
  media: Media
  engagement: Engagement
  engagement_deletion: Deletion
  label: Label
  account_event: AccountEvent
  collection_gap: CollectionGap
  sub_state: SubState
}

/**
 * Partitioned monthly on `indexedAt`, which is therefore part of the primary
 * key `(uri, indexedAt)`. That only deduplicates a replayed event because
 * `indexedAt` is derived from the event's own timestamp rather than from the
 * wall clock -- see `eventIndexedAt` in util/common.ts.
 *
 * `uri` alone is therefore no longer unique, and deliberately so: this is a
 * version table. An edited post keeps both versions, one row per version,
 * ordered by `indexedAt` and distinguished by `isEdit`. The old single-column
 * key silently discarded the second version. Anything that wants one row per
 * post should take the earliest `indexedAt` per uri -- see scripts/get_data.R.
 */
export type Post = {
  uri: string
  cid: string
  /** when the event happened, per the relay -- not when this process wrote it */
  indexedAt: Timestamptz
  /** null when the record's own createdAt was missing or implausible */
  createdAt: TimestamptzOrNull
  /**
   * true when this row came from an `update` op -- the post was edited and this
   * is the replacing version. False for the original, and also for the ~0.03%
   * of edits some PDSes emit as a second `create`, which cannot be told apart
   * from an original on the wire.
   */
  isEdit: boolean
  author: string
  text: string
  rootUri: string
  rootCid: string
  parentUri: string
  parentCid: string
  linkUrl: string
  linkTitle: string
  linkDescription: string
}

/**
 * Deletions and engagement withdrawals, appended rather than written back over
 * the original row. Both `post_deletion` and `engagement_deletion` use this
 * shape. The primary key `(uri, deletedAt)` keeps the first deletion and turns
 * a replayed event into a no-op conflict.
 */
export type Deletion = {
  uri: string
  deletedAt: Timestamptz
}

/**
 * Metadata for embedded images and video -- never the blobs themselves.
 * `postUri` references post(uri) by convention only: no foreign key, because a
 * per-row constraint check on the ingest path is the kind of write cost this
 * schema exists to avoid, and because a partitioned parent cannot carry one.
 * `indexedAt` is copied from the parent post to serve as the partition key.
 */
export type Media = {
  postUri: string
  /** position within the embed; a post has at most one embed, so this is unique per post */
  idx: number
  indexedAt: Timestamptz
  mediaType: 'image' | 'video'
  blobCid: string | null
  mimeType: string | null
  size: ColumnType<string | null, number | null, number | null>
  /** null when the record carried no alt field at all, '' when it carried an empty one */
  alt: string | null
  aspectW: number | null
  aspectH: number | null
}

export type Engagement = {
  uri: string
  cid: string
  subjectUri: string
  subjectCid: string
  /** 1 = repost, 2 = like */
  type: number
  indexedAt: Timestamptz
  createdAt: TimestamptzOrNull
  author: string
}

export type Label = {
  src: string
  uri: string
  cid: string
  val: string
  neg: boolean
  cts: Timestamptz
  indexedAt: Timestamptz
}

/**
 * Account lifecycle events from the firehose. This is what separates "the user
 * deleted this post" from "every post by this account disappeared at once
 * because the account was suspended, taken down or deleted" -- without it the
 * second case reads as a burst of ordinary user deletions.
 *
 * Not partitioned: a few tens of thousands of rows a day, against millions for
 * post and engagement, so its indexes are never the constraint.
 */
export type AccountEvent = {
  did: string
  seq: Bigint
  eventType: 'account' | 'identity' | 'tombstone'
  active: boolean | null
  status: string | null
  time: Timestamptz
  indexedAt: Timestamptz
}

/**
 * A5 -- every interval in which collection was not running normally.
 *
 * Without this table an interruption leaves no trace, so a window with no
 * deletions in it is indistinguishable from a window the collector was not
 * watching. For a project whose dependent variable is a rate over time that is a
 * validity problem rather than an operational one, and it is not recoverable
 * after the fact.
 *
 * A row is opened when the stream stops receiving and closed by the timestamp of
 * the first event that arrives once it does again -- both bounds taken from
 * event time rather than the wall clock, so a restart whose cursor replay
 * actually worked closes as a near-zero interval, and one whose cursor had
 * expired closes as the real hole. The interval is the answer either way,
 * without the writer having to know which happened.
 */
export type CollectionGap = {
  id: Generated<string>
  /** the endpoint, so repo and label gaps stay separable */
  service: string
  startedAt: Timestamptz
  /** null while the gap is still open */
  endedAt: TimestamptzOrNull
  /** restart | disconnected | cursor_expired | degraded | db_unavailable */
  reason: string
  detail: string | null
  /** which data categories were still being collected during a degraded window */
  streams: string[] | null
}

export type SubState = {
  service: string
  cursor: bigint
  /**
   * Event timestamp of the newest event the committed cursor covers -- "the
   * corpus is complete through here". Written in the same transaction as the
   * cursor, so it cannot claim more than was durably stored. It is what lets a
   * restart gap start at the moment collection actually stopped rather than at
   * the moment the process happened to come back.
   */
  lastEventAt: TimestamptzOrNull
}
