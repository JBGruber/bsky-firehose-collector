import { Kysely, Migration, MigrationProvider } from 'kysely'

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
