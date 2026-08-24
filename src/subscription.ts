import { Insertable, sql } from 'kysely'
import {
  OutputSchema as RepoEvent,
  isAccount,
  isCommit,
  isIdentity,
  isTombstone,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import { ids } from './lexicon/lexicons'
import { Database } from './db'
import { AccountEvent, Engagement, Media, Post } from './db/schema'
import { BatchSpec, Trx } from './util/batchWriter'
import { chunk } from './util/common'
import { getOpsByType, StreamSubscriptionBase } from './util/subscription'

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
  postDeletes: { uri: string; deletedAt: string }[]
  engagements: Insertable<Engagement>[]
  engagementDeletes: string[]
  accountEvents: Insertable<AccountEvent>[]
}

const repoBatchSpec: BatchSpec<RepoBuffer> = {
  empty: () => ({
    posts: [],
    media: [],
    postDeletes: [],
    engagements: [],
    engagementDeletes: [],
    accountEvents: [],
  }),

  size: (buf) =>
    buf.posts.length +
    buf.media.length +
    buf.postDeletes.length +
    buf.engagements.length +
    buf.engagementDeletes.length +
    buf.accountEvents.length,

  // creates before deletes: a post created and deleted inside the same batch
  // has to exist before it can be marked deleted
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
    for (const rows of chunk(buf.postDeletes, 500)) {
      await markPostsDeleted(trx, rows)
    }
    for (const uris of chunk(buf.engagementDeletes, 1000)) {
      await trx.deleteFrom('engagement').where('uri', 'in', uris).execute()
    }
  },
}

/**
 * One statement for the whole batch, keeping each post's own deletion time
 * rather than a single per-flush timestamp. The `deletedAt is null` guard keeps
 * the *first* deletion, so a replayed event cannot overwrite it -- `time_online`
 * in scripts/get_data.R is computed from it.
 */
const markPostsDeleted = async (
  trx: Trx,
  rows: { uri: string; deletedAt: string }[],
) => {
  const values = sql.join(
    rows.map((row) => sql`(${row.uri}::text, ${row.deletedAt}::text)`),
  )
  await sql`
    update "post" set "deletedAt" = v."deletedAt"
    from (values ${values}) as v("uri", "deletedAt")
    where "post"."uri" = v."uri" and "post"."deletedAt" is null
  `.execute(trx)
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
const extractMedia = (postUri: string, embed: any): Insertable<Media>[] => {
  const inner = innerEmbed(embed)
  if (!inner || typeof inner !== 'object') return []

  if (inner.$type === 'app.bsky.embed.images' && Array.isArray(inner.images)) {
    return inner.images.map((image: any, idx: number) => ({
      postUri,
      idx,
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
  constructor(db: Database, service: string) {
    super(db, service, {
      name: 'repo',
      method: ids.ComAtprotoSyncSubscribeRepos,
      spec: repoBatchSpec,
    })
  }

  // every frame type the collector stores carries `time`
  protected eventTime(evt: RepoEvent): number | null {
    const raw = (evt as { time?: unknown }).time
    if (typeof raw !== 'string') return null
    const time = Date.parse(raw)
    return Number.isFinite(time) ? time : null
  }

  protected async prepare(evt: RepoEvent) {
    const indexedAt = new Date().toISOString()

    if (!isCommit(evt)) {
      const accountEvent = accountEventFrom(evt, indexedAt)
      if (!accountEvent) return null
      return (buf: RepoBuffer) => {
        buf.accountEvents.push(accountEvent)
      }
    }

    const ops = await getOpsByType(evt)

    const postDeletes = ops.posts.deletes.map((del) => ({
      uri: del.uri,
      deletedAt: indexedAt,
    }))
    const media: Insertable<Media>[] = []
    const posts = ops.posts.creates.map((create) => {
      media.push(...extractMedia(create.uri, create.record.embed))
      const external = innerEmbed(create.record.embed)
      const card = isExternalEmbed(external) ? external.external : null
      return {
        uri: create.uri,
        cid: create.cid,
        indexedAt,
        createdAt: create.record.createdAt,
        author: create.author,
        text: sanitizeForPostgres(create.record.text),
        rootUri: create.record.reply?.root?.uri || "",
        rootCid: create.record.reply?.root?.cid || "",
        parentUri: create.record.reply?.parent?.uri || "",
        parentCid: create.record.reply?.parent?.cid || "",
        // extract preview card info if present
        linkUrl: card ? card.uri : "",
        linkTitle: sanitizeForPostgres(card ? card.title : ""),
        linkDescription: sanitizeForPostgres(card ? card.description : ""),
      }
    })

    // likes + reposts = engagement
    const engagementDeletes = ops.reposts.deletes
      .map((del) => del.uri)
      .concat(ops.likes.deletes.map((del) => del.uri))
    const engagements = ops.reposts.creates
      .map((create) => {
        return {
          uri: create.uri,
          cid: create.cid,
          subjectUri: create.record.subject.uri,
          subjectCid: create.record.subject.cid,
          type: 1,
          indexedAt,
          createdAt: create.record.createdAt,
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
              createdAt: create.record.createdAt,
              author: create.author,
            }
          })
      )

    if (
      posts.length === 0 &&
      postDeletes.length === 0 &&
      engagements.length === 0 &&
      engagementDeletes.length === 0
    ) {
      return null
    }

    return (buf: RepoBuffer) => {
      buf.posts.push(...posts)
      buf.media.push(...media)
      buf.postDeletes.push(...postDeletes)
      buf.engagements.push(...engagements)
      buf.engagementDeletes.push(...engagementDeletes)
    }
  }
}
