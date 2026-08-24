import { sql } from 'kysely'
import {
  OutputSchema as RepoEvent,
  isCommit,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import { ids } from './lexicon/lexicons'
import { Database } from './db'
import { Engagement, Post } from './db/schema'
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

export type RepoBuffer = {
  posts: Post[]
  postDeletes: { uri: string; deletedAt: string }[]
  engagements: Engagement[]
  engagementDeletes: string[]
}

const repoBatchSpec: BatchSpec<RepoBuffer> = {
  empty: () => ({
    posts: [],
    postDeletes: [],
    engagements: [],
    engagementDeletes: [],
  }),

  size: (buf) =>
    buf.posts.length +
    buf.postDeletes.length +
    buf.engagements.length +
    buf.engagementDeletes.length,

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
    for (const rows of chunk(buf.engagements, 1000)) {
      await trx
        .insertInto('engagement')
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
 * in scripts/get_data.R is computed from this column.
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

  protected eventTime(evt: RepoEvent): number | null {
    if (!isCommit(evt)) return null
    const time = Date.parse(evt.time)
    return Number.isFinite(time) ? time : null
  }

  protected async prepare(evt: RepoEvent) {
    if (!isCommit(evt)) return null

    const ops = await getOpsByType(evt)
    const indexedAt = new Date().toISOString()

    const postDeletes = ops.posts.deletes.map((del) => ({
      uri: del.uri,
      deletedAt: indexedAt,
    }))
    const posts = ops.posts.creates.map((create) => {
      return {
        uri: create.uri,
        cid: create.cid,
        indexedAt,
        createdAt: create.record.createdAt,
        author: create.author,
        text: sanitizeForPostgres(create.record.text),
        rootUri: create.record.reply?.root?.uri || "",
        rootCid: create.record.reply?.root?.cid || "",
        // extract preview card info if present
        linkUrl: create.record.embed && isExternalEmbed(create.record.embed) ? create.record.embed.external.uri : "",
        linkTitle: sanitizeForPostgres(
          create.record.embed && isExternalEmbed(create.record.embed) ? create.record.embed.external.title : ""
        ),
        linkDescription: sanitizeForPostgres(
          create.record.embed && isExternalEmbed(create.record.embed) ? create.record.embed.external.description : ""
        ),
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
      buf.postDeletes.push(...postDeletes)
      buf.engagements.push(...engagements)
      buf.engagementDeletes.push(...engagementDeletes)
    }
  }
}
