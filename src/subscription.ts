import { Insertable } from 'kysely'
import {
  OutputSchema as RepoEvent,
  isAccount,
  isCommit,
  isIdentity,
  isInfo,
  isTombstone,
} from './lexicon/types/com/atproto/sync/subscribeRepos.js'
import { ids } from './lexicon/lexicons.js'
import { Database } from './db/index.js'
import { AccountEvent, Deletion, Engagement, Media, Post } from './db/schema.js'
import { BatchSpec } from './util/batchWriter.js'
import { chunk, eventIndexedAt, recordTimestamp } from './util/common.js'
import { LadderOptions } from './util/ladder.js'
import { getOpsByType, StreamSubscriptionBase } from './util/subscription.js'

// for saving embedded preview cards
function isExternalEmbed(embed: any): embed is { external: { uri: string, title: string, description: string } } {
  return embed && embed.external && typeof embed.external.uri === 'string';
}

// Helper function to sanitize strings for PostgreSQL
function sanitizeForPostgres(text: string | null | undefined): string {
  if (text === null || text === undefined) return '';
  // Remove null bytes which cause PostgreSQL errors
  return text.replace(/\0/g, '');
}

// `Insertable` rather than the table types: the new tables use ColumnType, so
// what goes in (ISO strings, numbers) is not what comes back out (Date, string)
export type RepoBuffer = {
  posts: Insertable<Post>[]
  media: Insertable<Media>[]
  postDeletions: Insertable<Deletion>[]
  engagements: Insertable<Engagement>[]
  engagementDeletions: Insertable<Deletion>[]
  accountEvents: Insertable<AccountEvent>[]
}

const repoBatchSpec: BatchSpec<RepoBuffer> = {
  empty: () => ({
    posts: [],
    media: [],
    postDeletions: [],
    engagements: [],
    engagementDeletions: [],
    accountEvents: [],
  }),

  size: (buf) =>
    buf.posts.length +
    buf.media.length +
    buf.postDeletions.length +
    buf.engagements.length +
    buf.engagementDeletions.length +
    buf.accountEvents.length,

  // Table names for the disk fallback. Same rows, keyed by where they belong,
  // so backfill needs no knowledge of this buffer's shape.
  tables: (buf) => ({
    post: buf.posts,
    media: buf.media,
    post_deletion: buf.postDeletions,
    engagement: buf.engagements,
    engagement_deletion: buf.engagementDeletions,
    account_event: buf.accountEvents,
  }),

  // Every table here is append-only, so the order within a batch no longer
  // matters: a post created and deleted inside the same batch is one row in
  // `post` and one in `post_deletion`, neither depending on the other.
  write: async (trx, buf) => {
    for (const rows of chunk(buf.posts, 500)) {
      await trx
        .insertInto('post')
        .values(rows)
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
    for (const rows of chunk(buf.media, 500)) {
      await trx
        .insertInto('media')
        .values(rows)
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
    for (const rows of chunk(buf.engagements, 1000)) {
      await trx
        .insertInto('engagement')
        .values(rows)
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
    for (const rows of chunk(buf.accountEvents, 500)) {
      await trx
        .insertInto('account_event')
        .values(rows)
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
    for (const rows of chunk(buf.postDeletions, 1000)) {
      await trx
        .insertInto('post_deletion')
        .values(rows)
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
    for (const rows of chunk(buf.engagementDeletions, 1000)) {
      await trx
        .insertInto('engagement_deletion')
        .values(rows)
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
  },
}

/**
 * A post carries at most one embed, but `recordWithMedia` wraps a second one:
 * a quote post plus images, video or a link card. Reading through the wrapper
 * is what keeps media and link cards on quote posts from being missed -- the
 * link card was already being missed there before this.
 */
const innerEmbed = (embed: any): any => {
  if (!embed || typeof embed !== 'object') return null
  if (embed.$type === 'app.bsky.embed.recordWithMedia') return embed.media ?? null
  return embed
}

const blobFields = (blob: any) => ({
  blobCid: blob?.ref ? String(blob.ref) : null,
  mimeType: typeof blob?.mimeType === 'string' ? blob.mimeType : null,
  // legacy blob refs carry no size; BlobRef represents that absence as -1
  size: typeof blob?.size === 'number' && blob.size >= 0 ? blob.size : null,
})

const aspectFields = (aspect: any) => ({
  aspectW: typeof aspect?.width === 'number' ? aspect.width : null,
  aspectH: typeof aspect?.height === 'number' ? aspect.height : null,
})

// preserved as null when the record carried no alt at all, '' when it carried
// an empty one -- the two mean different things for accessibility
const altText = (alt: unknown): string | null =>
  typeof alt === 'string' ? sanitizeForPostgres(alt) : null

/**
 * Metadata only, never the blobs themselves: fetching the actual files would
 * mean a request per blob to the hosting PDS, orders of magnitude more storage,
 * and the re-identification risk the ethics application singles out. What the
 * firehose record already carries answers whether a post had media, how much,
 * and what the alt text said.
 */
const extractMedia = (
  postUri: string,
  indexedAt: string,
  embed: any,
): Insertable<Media>[] => {
  const inner = innerEmbed(embed)
  if (!inner || typeof inner !== 'object') return []

  if (inner.$type === 'app.bsky.embed.images' && Array.isArray(inner.images)) {
    return inner.images.map((image: any, idx: number) => ({
      postUri,
      idx,
      indexedAt,
      mediaType: 'image' as const,
      ...blobFields(image?.image),
      alt: altText(image?.alt),
      ...aspectFields(image?.aspectRatio),
    }))
  }

  // The successor to embed.images: same metadata, up to 20 items, and an item
  // union that is explicitly meant to grow. Keying off the blob the item
  // actually carries rather than its $type means a future item type still
  // lands in the table instead of vanishing, which is the failure mode this
  // whole pass exists to stop repeating.
  if (inner.$type === 'app.bsky.embed.gallery' && Array.isArray(inner.items)) {
    return inner.items.flatMap((item: any, idx: number) => {
      const video = item?.video
      const blob = video ?? item?.image
      if (!blob) return []
      return [
        {
          postUri,
          // the item's position in the gallery, held even if a neighbour is skipped
          idx,
          indexedAt,
          mediaType: (video ? 'video' : 'image') as 'image' | 'video',
          ...blobFields(blob),
          alt: altText(item?.alt),
          ...aspectFields(item?.aspectRatio),
        },
      ]
    })
  }

  if (inner.$type === 'app.bsky.embed.video' && inner.video) {
    return [
      {
        postUri,
        idx: 0,
        indexedAt,
        mediaType: 'video' as const,
        ...blobFields(inner.video),
        alt: altText(inner.alt),
        ...aspectFields(inner.aspectRatio),
      },
    ]
  }

  return []
}

/**
 * The firehose has always emitted these; the collector handled only #commit and
 * dropped the rest. They are the minimal sufficient signal for account removal:
 * one row per state change, rather than inferring it backwards from a burst of
 * post deletions or from the label stream.
 */
const accountEventFrom = (
  evt: RepoEvent,
  indexedAt: string,
): Insertable<AccountEvent> | null => {
  if (isAccount(evt)) {
    return {
      did: evt.did,
      seq: evt.seq,
      eventType: 'account',
      active: evt.active,
      status: evt.status ?? null,
      time: evt.time,
      indexedAt,
    }
  }
  if (isIdentity(evt)) {
    // The frame also carries the account's current handle. It is not stored:
    // the research question needs to know that the identity changed, not what
    // it changed to, and the handle is an identifier the project has no use for.
    return {
      did: evt.did,
      seq: evt.seq,
      eventType: 'identity',
      active: null,
      status: null,
      time: evt.time,
      indexedAt,
    }
  }
  if (isTombstone(evt)) {
    // #tombstone predates #account and means exactly one thing: the repo is
    // gone. Translating it into the #account shape keeps active/status
    // uniformly queryable, and eventType still records which frame it came from.
    return {
      did: evt.did,
      seq: evt.seq,
      eventType: 'tombstone',
      active: false,
      status: 'deleted',
      time: evt.time,
      indexedAt,
    }
  }
  return null
}

export class FirehoseSubscription extends StreamSubscriptionBase<
  RepoEvent,
  RepoBuffer
> {
  constructor(
    db: Database,
    service: string,
    opts: { dataDir?: string | null; ladder?: LadderOptions } = {},
  ) {
    super(db, service, {
      name: 'repo',
      method: ids.ComAtprotoSyncSubscribeRepos,
      spec: repoBatchSpec,
      // the only stream with a ladder: it is the one carrying the volume, and
      // the only one with anything worth shedding
      ladder: opts.ladder ?? {},
      dataDir: opts.dataDir ?? null,
    })
  }

  // `#info` carries no seq, so it never reaches the writer -- but OutdatedCursor
  // is how the relay says the resume point was outside its retention, which is
  // the one signal that always means data is missing. See handleInfo().
  protected info(evt: RepoEvent): { name: string; message?: string } | null {
    if (!isInfo(evt)) return null
    return { name: evt.name, message: evt.message }
  }

  // every frame type the collector stores carries `time`
  protected eventTime(evt: RepoEvent): number | null {
    const raw = (evt as { time?: unknown }).time
    if (typeof raw !== 'string') return null
    const time = Date.parse(raw)
    return Number.isFinite(time) ? time : null
  }

  protected async prepare(evt: RepoEvent) {
    // The event's own timestamp, not the wall clock: it is the partition key,
    // and it has to be identical every time the same event is seen for the
    // primary keys to keep deduplicating a cursor replay.
    const indexedAt = eventIndexedAt((evt as { time?: unknown }).time)

    if (!isCommit(evt)) {
      const accountEvent = accountEventFrom(evt, indexedAt)
      if (!accountEvent) return null
      return (buf: RepoBuffer) => {
        buf.accountEvents.push(accountEvent)
      }
    }

    // Part D: shedding happens before the records are decoded, not after they
    // are built -- see WantedOps. At rung 1 the like records in this commit are
    // never read out of the CAR at all.
    const ops = await getOpsByType(evt, {
      likes: this.ladder?.collectLikes ?? true,
      reposts: this.ladder?.collectReposts ?? true,
    })

    const postDeletions = ops.posts.deletes.map((del) => ({
      uri: del.uri,
      deletedAt: indexedAt,
    }))
    const media: Insertable<Media>[] = []
    // Creates and edits are the same row shape and differ only in `isEdit`.
    // Both are appended: `post` is keyed (uri, indexedAt), so an edit sits
    // beside the version it replaced instead of overwriting it, and the text
    // that stopped being publicly visible is still in the corpus.
    const postWrite = (write: (typeof ops.posts.creates)[number], isEdit: boolean) => {
      media.push(...extractMedia(write.uri, indexedAt, write.record.embed))
      const external = innerEmbed(write.record.embed)
      const card = isExternalEmbed(external) ? external.external : null
      return {
        uri: write.uri,
        cid: write.cid,
        indexedAt,
        createdAt: recordTimestamp(write.record.createdAt),
        isEdit,
        author: write.author,
        text: sanitizeForPostgres(write.record.text),
        rootUri: write.record.reply?.root?.uri || "",
        rootCid: write.record.reply?.root?.cid || "",
        parentUri: write.record.reply?.parent?.uri || "",
        parentCid: write.record.reply?.parent?.cid || "",
        // extract preview card info if present
        linkUrl: card ? card.uri : "",
        linkTitle: sanitizeForPostgres(card ? card.title : ""),
        linkDescription: sanitizeForPostgres(card ? card.description : ""),
      }
    }
    const posts = ops.posts.creates
      .map((create) => postWrite(create, false))
      .concat(ops.posts.updates.map((update) => postWrite(update, true)))

    // likes + reposts = engagement. A withdrawal is an appended row rather than
    // a DELETE: un-liking is itself an ephemerality event, and the old hard
    // delete destroyed the only record that it had happened.
    const engagementDeletions = ops.reposts.deletes
      .concat(ops.likes.deletes)
      .map((del) => ({ uri: del.uri, deletedAt: indexedAt }))
    const engagements = ops.reposts.creates
      .map((create) => {
        return {
          uri: create.uri,
          cid: create.cid,
          subjectUri: create.record.subject.uri,
          subjectCid: create.record.subject.cid,
          type: 1,
          indexedAt,
          createdAt: recordTimestamp(create.record.createdAt),
          author: create.author,
        }
      }).concat(
        ops.likes.creates
          .map((create) => {
            return {
              uri: create.uri,
              cid: create.cid,
              subjectUri: create.record.subject.uri,
              subjectCid: create.record.subject.cid,
              type: 2,
              indexedAt,
              createdAt: recordTimestamp(create.record.createdAt),
              author: create.author,
            }
          })
      )

    if (
      posts.length === 0 &&
      postDeletions.length === 0 &&
      engagements.length === 0 &&
      engagementDeletions.length === 0
    ) {
      return null
    }

    return (buf: RepoBuffer) => {
      buf.posts.push(...posts)
      buf.media.push(...media)
      buf.postDeletions.push(...postDeletions)
      buf.engagements.push(...engagements)
      buf.engagementDeletions.push(...engagementDeletions)
    }
  }
}
