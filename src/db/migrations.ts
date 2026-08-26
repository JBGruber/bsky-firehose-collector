import { Kysely, Migration, MigrationProvider, sql } from 'kysely'

const migrations: Record<string, Migration> = {}

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations
  },
}

migrations['001'] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('post')
      .addColumn('uri', 'varchar', (col) => col.primaryKey())
      .addColumn('cid', 'varchar', (col) => col.notNull())
      .addColumn('indexedAt', 'varchar', (col) => col.notNull())
      .addColumn('createdAt', 'varchar', (col) => col.notNull())
      .addColumn('deletedAt', 'varchar')
      .addColumn('author', 'varchar', (col) => col.notNull())
      .addColumn('text', 'text', (col) => col.notNull())
      .addColumn('rootUri', 'varchar', (col) => col.notNull())
      .addColumn('rootCid', 'varchar', (col) => col.notNull())
      .addColumn('linkUrl', 'varchar', (col) => col.notNull())
      .addColumn('linkTitle', 'varchar', (col) => col.notNull())
      .addColumn('linkDescription', 'varchar', (col) => col.notNull())
      .addColumn('likes_count', 'integer', (col) => col.defaultTo(0))
      .addColumn('repost_count', 'integer', (col) => col.defaultTo(0))
      .addColumn('comments_count', 'integer', (col) => col.defaultTo(0))
      .execute()
    await db.schema
      .createTable('engagement')
      .addColumn('uri', 'varchar', (col) => col.primaryKey())
      .addColumn('cid', 'varchar', (col) => col.notNull())
      .addColumn('subjectUri', 'varchar', (col) => col.notNull())
      .addColumn('subjectCid', 'varchar', (col) => col.notNull())
      .addColumn('type', 'integer', (col) => col.notNull())
      .addColumn('indexedAt', 'varchar', (col) => col.notNull())
      .addColumn('createdAt', 'varchar', (col) => col.notNull())
      .addColumn('author', 'varchar', (col) => col.notNull())
      .execute()

    await db.schema
      .createTable('sub_state')
      .addColumn('service', 'varchar', (col) => col.primaryKey())
      .addColumn('cursor', 'bigint', (col) => col.notNull())
      .execute()
    
    await db.schema
      .createIndex('engagement_subject_uri_index')
      .on('engagement')
      .column('subjectUri')
      .execute()

    await db.schema
      .createIndex('engagement_subjectUri_type_index')
      .on('engagement')
      .columns(['subjectUri', 'type'])
      .execute()

    await db.schema
      .createIndex('post_createdAt_index')
      .on('post')
      .column('createdAt')
      .execute()

    await db.schema
      .createIndex('post_deletedAt_index')
      .on('post')
      .column('deletedAt')
      .execute()

    await db.schema
      .createIndex('post_createdAt_deletedAt_index')
      .on('post')
      .columns(['createdAt', 'deletedAt'])
      .execute()

    await db.schema
      .createIndex('post_author_index')
      .on('post')
      .column('author')
      .execute()

    await db.schema
      .createIndex('post_indexedAt_index')
      .on('post')
      .column('indexedAt')
      .execute()

    await db.schema
      .createIndex('post_rootUri_index')
      .on('post')
      .column('rootUri')
      .execute()

  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('post').execute()
    await db.schema.dropTable('sub_state').execute()
  },
}

migrations['002'] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('label')
      .addColumn('src', 'varchar', (col) => col.notNull())
      .addColumn('uri', 'varchar', (col) => col.notNull())
      .addColumn('cid', 'varchar', (col) => col.notNull())
      .addColumn('val', 'varchar', (col) => col.notNull())
      .addColumn('neg', 'boolean', (col) => col.notNull().defaultTo(false))
      .addColumn('cts', 'varchar', (col) => col.notNull())
      .addColumn('indexedAt', 'varchar', (col) => col.notNull())
      .execute()

    await db.schema
      .createIndex('label_uri_index')
      .on('label')
      .column('uri')
      .execute()

    // unique constraint used by onConflict().doNothing() to deduplicate replayed events
    await db.schema
      .createIndex('label_src_uri_val_cts_unique')
      .on('label')
      .columns(['src', 'uri', 'val', 'cts'])
      .unique()
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('label').execute()
  },
}

migrations['003'] = {
  async up(db: Kysely<unknown>) {
    // Both are leading-column prefixes of a wider index, so the planner can
    // always use the wider one instead. They cost a random B-tree write on
    // every insert and buy nothing back.
    await db.schema.dropIndex('post_createdAt_index').ifExists().execute()
    await db.schema
      .dropIndex('engagement_subject_uri_index')
      .ifExists()
      .execute()

    // Never written by the collector: 0 in every row since 001, which invites
    // anyone querying the table to read a real count into them. The A7 rollup
    // reintroduces them once there is something to put in them.
    await db.schema.alterTable('post').dropColumn('likes_count').execute()
    await db.schema.alterTable('post').dropColumn('repost_count').execute()
    await db.schema.alterTable('post').dropColumn('comments_count').execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema
      .alterTable('post')
      .addColumn('likes_count', 'integer', (col) => col.defaultTo(0))
      .execute()
    await db.schema
      .alterTable('post')
      .addColumn('repost_count', 'integer', (col) => col.defaultTo(0))
      .execute()
    await db.schema
      .alterTable('post')
      .addColumn('comments_count', 'integer', (col) => col.defaultTo(0))
      .execute()

    await db.schema
      .createIndex('post_createdAt_index')
      .on('post')
      .column('createdAt')
      .execute()
    await db.schema
      .createIndex('engagement_subject_uri_index')
      .on('engagement')
      .column('subjectUri')
      .execute()
  },
}

migrations['004'] = {
  async up(db: Kysely<unknown>) {
    // A3: only reply.root was stored, so direct replies to a post could not be
    // counted. Existing rows get '' -- the same "absent" convention rootUri
    // already uses -- and are not backfillable, since the records are gone.
    await db.schema
      .alterTable('post')
      .addColumn('parentUri', 'varchar', (col) => col.notNull().defaultTo(''))
      .execute()
    await db.schema
      .alterTable('post')
      .addColumn('parentCid', 'varchar', (col) => col.notNull().defaultTo(''))
      .execute()

    // A2: account lifecycle events. The firehose has been emitting these all
    // along; the collector discarded them because it only handled #commit and
    // because the vendored lexicon predated #account and #identity.
    await db.schema
      .createTable('account_event')
      .addColumn('did', 'varchar', (col) => col.notNull())
      .addColumn('seq', 'bigint', (col) => col.notNull())
      // 'account' | 'identity' | 'tombstone' -- which frame it came from
      .addColumn('eventType', 'varchar', (col) => col.notNull())
      // null for #identity, which says only that the identity changed
      .addColumn('active', 'boolean')
      // takendown | suspended | deactivated | deleted, per the relay
      .addColumn('status', 'varchar')
      .addColumn('time', 'timestamptz', (col) => col.notNull())
      .addColumn('indexedAt', 'timestamptz', (col) => col.notNull())
      // also deduplicates replayed events via onConflict().doNothing()
      .addPrimaryKeyConstraint('account_event_pkey', ['did', 'seq'])
      .execute()

    // A4: metadata for embedded images and video. Deliberately not the blobs --
    // see the note on Media in schema.ts. Cannot be reconstructed once a post is
    // deleted, which is why it lands before the next long collection run.
    await db.schema
      .createTable('media')
      .addColumn('postUri', 'varchar', (col) => col.notNull())
      .addColumn('idx', 'integer', (col) => col.notNull())
      // 'image' | 'video'
      .addColumn('mediaType', 'varchar', (col) => col.notNull())
      .addColumn('blobCid', 'varchar')
      .addColumn('mimeType', 'varchar')
      .addColumn('size', 'bigint')
      .addColumn('alt', 'text')
      .addColumn('aspectW', 'integer')
      .addColumn('aspectH', 'integer')
      .addPrimaryKeyConstraint('media_pkey', ['postUri', 'idx'])
      .execute()

    // No secondary indexes on either table on purpose: both are read through
    // their primary key's leading column (account_event by did, media by
    // postUri), so anything else would be the pure write cost 003 removed.
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('media').execute()
    await db.schema.dropTable('account_event').execute()
    await db.schema.alterTable('post').dropColumn('parentCid').execute()
    await db.schema.alterTable('post').dropColumn('parentUri').execute()
  },
}

/**
 * B8/B9/A8 -- the change that removes the two-month ceiling.
 *
 * Three things happen here, and they have to happen together because each one
 * needs a full table rewrite anyway:
 *
 *  1. `post`, `engagement` and `media` become monthly range partitions, so the
 *     indexes that ingest actually writes to stay bounded by one month of data
 *     instead of by everything ever collected. That is the mechanism behind the
 *     cliff: once the hot B-tree pages stop fitting in cache, every insert turns
 *     into random disk I/O.
 *  2. Every timestamp becomes `timestamptz` instead of `varchar` -- 8 bytes
 *     against ~25 plus header, on every row and in every index. It also makes
 *     the createdAt filter in scripts/make_snapshot.R indexable, which it was
 *     not while the script had to cast a string on every row.
 *  3. Deletion becomes append-only. `post.deletedAt` is gone; deletions are rows
 *     in `post_deletion`, and engagement withdrawals -- previously a hard DELETE
 *     that destroyed the evidence -- are rows in `engagement_deletion`.
 *
 * Point 3 is not just about write cost. Once `post` is partitioned, an UPDATE
 * that finds a row by `uri` cannot prune partitions (uri is not the partition
 * key), so it has to probe every monthly index. That cost grows linearly with
 * the life of the collection, which is exactly what this migration exists to
 * stop. An insert has no such lookup.
 *
 * Retention: decided 2026-08-25 -- raw per-event engagement rows are kept
 * indefinitely, so no partition is ever dropped. Partitioning here is purely
 * about keeping write cost independent of accumulated history.
 */
migrations['005'] = {
  async up(db: Kysely<unknown>) {
    // ---------------------------------------------------------------- helpers

    // Called by the migration below and, from then on, hourly by the collector
    // (src/util/partitions.ts). Lives in the database rather than in TypeScript
    // so that the existence check and the CREATE are one atomic step, and so a
    // race between two callers is a caught duplicate_table rather than a crash.
    await sql`
      create or replace function ensure_month_partition(parent text, month timestamptz)
      returns void language plpgsql as $fn$
      declare
        start_ts timestamptz := (date_trunc('month', month at time zone 'UTC')) at time zone 'UTC';
        end_ts   timestamptz := (date_trunc('month', month at time zone 'UTC') + interval '1 month') at time zone 'UTC';
        part     text := parent || '_' || to_char(start_ts at time zone 'UTC', 'YYYYMM');
      begin
        if to_regclass(part) is not null then return; end if;
        execute format(
          'create table %I partition of %I for values from (%L) to (%L)',
          part, parent, start_ts, end_ts);
      exception
        when duplicate_table then null;
      end $fn$;
    `.execute(db)

    // Timestamps in the varchar columns were written by the collector and are
    // well-formed, but `createdAt` comes straight off the record and is
    // whatever the posting client put there. A cast that raises would abort the
    // whole migration, so implausible values become null instead.
    await sql`
      create or replace function safe_timestamptz(t text)
      returns timestamptz language plpgsql immutable as $fn$
      declare ts timestamptz;
      begin
        ts := t::timestamptz;
        if ts < '1970-01-01Z'::timestamptz or ts > now() + interval '1 year' then
          return null;
        end if;
        return ts;
      exception when others then
        return null;
      end $fn$;
    `.execute(db)

    // ------------------------------------------------- move the old ones aside
    // Renaming a table does not rename its constraints, so the legacy primary
    // keys would collide with the ones the new tables declare.
    await sql`alter table "post" rename to "post_legacy"`.execute(db)
    await sql`alter table "post_legacy" rename constraint "post_pkey" to "post_legacy_pkey"`.execute(db)
    await sql`alter table "engagement" rename to "engagement_legacy"`.execute(db)
    await sql`alter table "engagement_legacy" rename constraint "engagement_pkey" to "engagement_legacy_pkey"`.execute(db)
    await sql`alter table "media" rename to "media_legacy"`.execute(db)
    await sql`alter table "media_legacy" rename constraint "media_pkey" to "media_legacy_pkey"`.execute(db)

    // ------------------------------------------------------------- new tables

    // `createdAt` is nullable now: it is the only timestamp the collector does
    // not generate itself, and a record whose stated creation time is unusable
    // is better recorded as unknown than as a fabricated value. `indexedAt` --
    // when the event happened, per the relay -- is always present.
    //
    // Keying on (uri, indexedAt) also turns `post` into a version table, which
    // is what lets edits be recorded: an edit is an appended row carrying the
    // replacing content, not an overwrite of the text it replaced.
    await sql`
      create table "post" (
        "uri"             varchar     not null,
        "cid"             varchar     not null,
        "indexedAt"       timestamptz not null,
        "createdAt"       timestamptz,
        -- true when the row came from an update op: the post was edited and
        -- this is the replacing version, appended beside the one it replaced
        "isEdit"          boolean     not null default false,
        "author"          varchar     not null,
        "text"            text        not null,
        "rootUri"         varchar     not null,
        "rootCid"         varchar     not null,
        "parentUri"       varchar     not null default '',
        "parentCid"       varchar     not null default '',
        "linkUrl"         varchar     not null,
        "linkTitle"       varchar     not null,
        "linkDescription" varchar     not null,
        primary key ("uri", "indexedAt")
      ) partition by range ("indexedAt")
    `.execute(db)

    await sql`
      create table "engagement" (
        "uri"        varchar     not null,
        "cid"        varchar     not null,
        "subjectUri" varchar     not null,
        "subjectCid" varchar     not null,
        "type"       integer     not null,
        "indexedAt"  timestamptz not null,
        "createdAt"  timestamptz,
        "author"     varchar     not null,
        primary key ("uri", "indexedAt")
      ) partition by range ("indexedAt")
    `.execute(db)

    // `indexedAt` is duplicated from the parent post purely to serve as the
    // partition key: media was added in 004 as a plain table and would have
    // grown into the same unbounded B-tree this migration exists to remove.
    await sql`
      create table "media" (
        "postUri"   varchar     not null,
        "idx"       integer     not null,
        "indexedAt" timestamptz not null,
        "mediaType" varchar     not null,
        "blobCid"   varchar,
        "mimeType"  varchar,
        "size"      bigint,
        "alt"       text,
        "aspectW"   integer,
        "aspectH"   integer,
        primary key ("postUri", "idx", "indexedAt")
      ) partition by range ("indexedAt")
    `.execute(db)

    // B9: the deletion record itself, rather than a mutation of the post row.
    // Append-only also means the *first* deletion survives -- a replayed event
    // is a primary-key conflict, not an overwrite -- which matters because
    // time_online in scripts/get_data.R is measured from it.
    await sql`
      create table "post_deletion" (
        "uri"       varchar     not null,
        "deletedAt" timestamptz not null,
        primary key ("uri", "deletedAt")
      ) partition by range ("deletedAt")
    `.execute(db)

    // A8: withdrawing a like or a repost is itself an ephemerality event and is
    // squarely within what the project studies. Until now it was a hard DELETE,
    // which destroyed the only evidence that it had ever happened.
    await sql`
      create table "engagement_deletion" (
        "uri"       varchar     not null,
        "deletedAt" timestamptz not null,
        primary key ("uri", "deletedAt")
      ) partition by range ("deletedAt")
    `.execute(db)

    // ---------------------------------------- partitions covering legacy data
    // Enough months to hold whatever the old tables contain, plus the current
    // month and two ahead so the collector can start writing immediately. On a
    // fresh volume the legacy tables are empty and this is three months.
    await sql`
      do $do$
      declare
        lo timestamptz;
        hi timestamptz;
        m  timestamptz;
        t  text;
      begin
        select least(
                 (select min(safe_timestamptz("indexedAt")) from "post_legacy"),
                 (select min(safe_timestamptz("indexedAt")) from "engagement_legacy")
               ),
               greatest(
                 (select max(safe_timestamptz("indexedAt")) from "post_legacy"),
                 (select max(safe_timestamptz("indexedAt")) from "engagement_legacy"),
                 (select max(safe_timestamptz("deletedAt")) from "post_legacy")
               )
          into lo, hi;

        lo := (date_trunc('month', coalesce(lo, now()) at time zone 'UTC')) at time zone 'UTC';
        hi := greatest(coalesce(hi, now()), now()) + interval '2 months';

        foreach t in array array['post','engagement','media','post_deletion','engagement_deletion'] loop
          m := lo;
          while m <= hi loop
            perform ensure_month_partition(t, m);
            m := m + interval '1 month';
          end loop;
        end loop;
      end $do$;
    `.execute(db)

    // ------------------------------------------------------------------- copy
    // A row whose indexedAt will not parse has no partition to go to. The
    // collector generates that column, so this should never exclude anything;
    // the guard is here so a corrupt row cannot abort the migration.
    await sql`
      insert into "post" ("uri", "cid", "indexedAt", "createdAt", "author", "text",
                          "rootUri", "rootCid", "parentUri", "parentCid",
                          "linkUrl", "linkTitle", "linkDescription")
      select "uri", "cid", safe_timestamptz("indexedAt"), safe_timestamptz("createdAt"),
             "author", "text", "rootUri", "rootCid", "parentUri", "parentCid",
             "linkUrl", "linkTitle", "linkDescription"
      from "post_legacy"
      where safe_timestamptz("indexedAt") is not null
      on conflict do nothing
    `.execute(db)

    await sql`
      insert into "engagement" ("uri", "cid", "subjectUri", "subjectCid", "type",
                                "indexedAt", "createdAt", "author")
      select "uri", "cid", "subjectUri", "subjectCid", "type",
             safe_timestamptz("indexedAt"), safe_timestamptz("createdAt"), "author"
      from "engagement_legacy"
      where safe_timestamptz("indexedAt") is not null
      on conflict do nothing
    `.execute(db)

    // media had no timestamp of its own, so it inherits the parent post's.
    // Orphans -- media whose post did not survive the indexedAt guard -- are
    // dropped rather than given a fabricated partition key.
    await sql`
      insert into "media" ("postUri", "idx", "indexedAt", "mediaType", "blobCid",
                           "mimeType", "size", "alt", "aspectW", "aspectH")
      select ml."postUri", ml."idx", p."indexedAt", ml."mediaType", ml."blobCid",
             ml."mimeType", ml."size", ml."alt", ml."aspectW", ml."aspectH"
      from "media_legacy" ml
      join "post" p on p."uri" = ml."postUri"
      on conflict do nothing
    `.execute(db)

    // post.deletedAt becomes rows in post_deletion. There is no engagement
    // equivalent to migrate: withdrawals were hard-deleted and are gone.
    await sql`
      insert into "post_deletion" ("uri", "deletedAt")
      select "uri", safe_timestamptz("deletedAt")
      from "post_legacy"
      where "deletedAt" is not null and safe_timestamptz("deletedAt") is not null
      on conflict do nothing
    `.execute(db)

    await sql`drop table "media_legacy"`.execute(db)
    await sql`drop table "post_legacy"`.execute(db)
    await sql`drop table "engagement_legacy"`.execute(db)

    // ---------------------------------------------------------------- indexes
    // Created after the copy, and on the parent, which propagates them to every
    // existing partition and to every one created later.
    //
    // post is down from seven indexes to four. Gone with post.deletedAt are
    // post_deletedAt_index and post_createdAt_deletedAt_index -- the pair that
    // made every deletion a non-HOT update rewriting all seven. createdAt comes
    // back as its own index (003 dropped it only because it was a prefix of the
    // composite that has now gone).
    await sql`create index "post_createdAt_index" on "post" ("createdAt")`.execute(db)
    // Partial, so it holds only the fraction of a percent of rows that are
    // edits: finding every edited post is cheap, and rows that are not edits
    // pay nothing but a predicate evaluation on insert.
    await sql`create index "post_isEdit_index" on "post" ("uri") where "isEdit"`.execute(db)
    await sql`create index "post_author_index" on "post" ("author")`.execute(db)
    await sql`create index "post_rootUri_index" on "post" ("rootUri")`.execute(db)
    await sql`create index "engagement_subjectUri_type_index" on "engagement" ("subjectUri", "type")`.execute(db)

    // BRIN rather than B-tree on the partition key: within a partition indexedAt
    // correlates almost perfectly with physical insertion order, so a BRIN is a
    // few kilobytes and costs essentially nothing to maintain, where the B-tree
    // it replaces (post_indexedAt_index) was 279 MB per 6M rows.
    await sql`create index "post_indexedAt_brin" on "post" using brin ("indexedAt")`.execute(db)
    await sql`create index "engagement_indexedAt_brin" on "engagement" using brin ("indexedAt")`.execute(db)
    await sql`create index "post_deletion_deletedAt_brin" on "post_deletion" using brin ("deletedAt")`.execute(db)
    await sql`create index "engagement_deletion_deletedAt_brin" on "engagement_deletion" using brin ("deletedAt")`.execute(db)

    // ----------------------------------------------------- default partitions
    // Last, because attaching a month partition has to check that the default
    // holds no rows belonging to it. Nothing should ever land here: event
    // timestamps are clamped into a window the maintainer keeps covered. A
    // non-empty default is a bug, and the collector says so at startup.
    for (const table of ['post', 'engagement', 'media', 'post_deletion', 'engagement_deletion']) {
      await sql`
        create table ${sql.table(`${table}_default`)}
        partition of ${sql.table(table)} default
      `.execute(db)
    }

    // ---------------------------------------------------------------- labels
    // Not partitioned: labels arrive orders of magnitude more sparsely than
    // commits, so the table stays small enough that its indexes are never the
    // constraint. The type conversion is worth having regardless.
    await sql`
      alter table "label"
        alter column "cts" type timestamptz
          using coalesce(safe_timestamptz("cts"), safe_timestamptz("indexedAt"), now()),
        alter column "indexedAt" type timestamptz
          using coalesce(safe_timestamptz("indexedAt"), now())
    `.execute(db)

    await sql`drop function safe_timestamptz(text)`.execute(db)
  },
  async down(db: Kysely<unknown>) {
    // Rebuilds the 004 shape: unpartitioned, varchar timestamps, deletedAt back
    // on post. Lossy in one direction that cannot be helped -- engagement
    // withdrawals have no column to go back to, so they are dropped.
    const iso = sql`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`

    await sql`alter table "post" rename to "post_new"`.execute(db)
    await sql`alter table "post_new" rename constraint "post_pkey" to "post_new_pkey"`.execute(db)
    await sql`alter table "engagement" rename to "engagement_new"`.execute(db)
    await sql`alter table "engagement_new" rename constraint "engagement_pkey" to "engagement_new_pkey"`.execute(db)
    await sql`alter table "media" rename to "media_new"`.execute(db)
    await sql`alter table "media_new" rename constraint "media_pkey" to "media_new_pkey"`.execute(db)

    await sql`
      create table "post" (
        "uri"             varchar not null primary key,
        "cid"             varchar not null,
        "indexedAt"       varchar not null,
        "createdAt"       varchar not null,
        "deletedAt"       varchar,
        "author"          varchar not null,
        "text"            text    not null,
        "rootUri"         varchar not null,
        "rootCid"         varchar not null,
        "parentUri"       varchar not null default '',
        "parentCid"       varchar not null default '',
        "linkUrl"         varchar not null,
        "linkTitle"       varchar not null,
        "linkDescription" varchar not null
      )
    `.execute(db)
    await sql`
      create table "engagement" (
        "uri"        varchar not null primary key,
        "cid"        varchar not null,
        "subjectUri" varchar not null,
        "subjectCid" varchar not null,
        "type"       integer not null,
        "indexedAt"  varchar not null,
        "createdAt"  varchar not null,
        "author"     varchar not null
      )
    `.execute(db)
    await sql`
      create table "media" (
        "postUri"   varchar not null,
        "idx"       integer not null,
        "mediaType" varchar not null,
        "blobCid"   varchar,
        "mimeType"  varchar,
        "size"      bigint,
        "alt"       text,
        "aspectW"   integer,
        "aspectH"   integer,
        constraint "media_pkey" primary key ("postUri", "idx")
      )
    `.execute(db)

    await sql`
      insert into "post" ("uri", "cid", "indexedAt", "createdAt", "deletedAt", "author",
                          "text", "rootUri", "rootCid", "parentUri", "parentCid",
                          "linkUrl", "linkTitle", "linkDescription")
      select distinct on (p."uri")
             p."uri", p."cid",
             to_char(p."indexedAt" at time zone 'UTC', ${iso}),
             coalesce(to_char(p."createdAt" at time zone 'UTC', ${iso}), ''),
             (select to_char(min(d."deletedAt") at time zone 'UTC', ${iso})
                from "post_deletion" d where d."uri" = p."uri"),
             p."author", p."text", p."rootUri", p."rootCid", p."parentUri", p."parentCid",
             p."linkUrl", p."linkTitle", p."linkDescription"
      from "post_new" p
      order by p."uri", p."indexedAt"
    `.execute(db)
    await sql`
      insert into "engagement" ("uri", "cid", "subjectUri", "subjectCid", "type",
                                "indexedAt", "createdAt", "author")
      select distinct on ("uri")
             "uri", "cid", "subjectUri", "subjectCid", "type",
             to_char("indexedAt" at time zone 'UTC', ${iso}),
             coalesce(to_char("createdAt" at time zone 'UTC', ${iso}), ''),
             "author"
      from "engagement_new"
      order by "uri", "indexedAt"
    `.execute(db)
    await sql`
      insert into "media" ("postUri", "idx", "mediaType", "blobCid", "mimeType",
                           "size", "alt", "aspectW", "aspectH")
      select distinct on ("postUri", "idx")
             "postUri", "idx", "mediaType", "blobCid", "mimeType",
             "size", "alt", "aspectW", "aspectH"
      from "media_new"
      order by "postUri", "idx", "indexedAt"
    `.execute(db)

    await sql`drop table "media_new"`.execute(db)
    await sql`drop table "post_new"`.execute(db)
    await sql`drop table "engagement_new"`.execute(db)
    await sql`drop table "post_deletion"`.execute(db)
    await sql`drop table "engagement_deletion"`.execute(db)

    await sql`create index "post_deletedAt_index" on "post" ("deletedAt")`.execute(db)
    await sql`create index "post_createdAt_deletedAt_index" on "post" ("createdAt", "deletedAt")`.execute(db)
    await sql`create index "post_author_index" on "post" ("author")`.execute(db)
    await sql`create index "post_indexedAt_index" on "post" ("indexedAt")`.execute(db)
    await sql`create index "post_rootUri_index" on "post" ("rootUri")`.execute(db)
    await sql`create index "engagement_subjectUri_type_index" on "engagement" ("subjectUri", "type")`.execute(db)

    await sql`
      alter table "label"
        alter column "cts" type varchar using to_char("cts" at time zone 'UTC', ${iso}),
        alter column "indexedAt" type varchar using to_char("indexedAt" at time zone 'UTC', ${iso})
    `.execute(db)

    await sql`drop function if exists ensure_month_partition(text, timestamptz)`.execute(db)
  },
}
