import { ColumnType } from 'kysely'

/**
 * Postgres hands back `Date` for timestamptz and `string` for bigint, while the
 * collector always inserts ISO strings and numbers. `ColumnType` records that
 * asymmetry rather than letting the select side quietly lie. The older columns
 * still store timestamps as varchar; B8 converts them in one pass.
 */
type Timestamptz = ColumnType<Date, string, string>
type Bigint = ColumnType<string, number, number>

export type DatabaseSchema = {
  post: Post
  media: Media
  engagement: Engagement
  label: Label
  account_event: AccountEvent
  sub_state: SubState
}

export type Post = {
  uri: string
  cid: string
  indexedAt: string
  createdAt: string
  deletedAt?: string
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
 * Metadata for embedded images and video -- never the blobs themselves.
 * `postUri` references post(uri) by convention only: no foreign key, because a
 * per-row constraint check on the ingest path is exactly the kind of write cost
 * B8 exists to remove, and because partitioning post would break it anyway.
 */
export type Media = {
  postUri: string
  /** position within the embed; a post has at most one embed, so this is unique per post */
  idx: number
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
  type: number
  indexedAt: string
  createdAt: string
  author: string
}

export type Label = {
  src: string
  uri: string
  cid: string
  val: string
  neg: boolean
  cts: string
  indexedAt: string
}

/**
 * Account lifecycle events from the firehose. This is what separates "the user
 * deleted this post" from "every post by this account disappeared at once
 * because the account was suspended, taken down or deleted" -- without it the
 * second case reads as a burst of ordinary user deletions.
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

export type SubState = {
  service: string
  cursor: bigint
}
