import { Kysely, Migrator, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import { connectionStringFromEnv } from './src/db/index.js'
import { migrationProvider } from './src/db/migrations.js'

const db = new Kysely<any>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: connectionStringFromEnv(), max: 2 }) }),
})
const migrator = new Migrator({ db, provider: migrationProvider })

const show = async (label: string) => {
  const { rows: tables } = await sql<{ table_name: string }>`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name in ('collection_gap','sub_state')
    order by table_name`.execute(db)
  const { rows: cols } = await sql<{ column_name: string; data_type: string }>`
    select column_name, data_type from information_schema.columns
    where table_schema = 'public' and table_name = 'collection_gap' order by ordinal_position`.execute(db)
  const { rows: subcols } = await sql<{ column_name: string }>`
    select column_name from information_schema.columns
    where table_schema='public' and table_name='sub_state' order by ordinal_position`.execute(db)
  const { rows: idx } = await sql<{ indexdef: string }>`
    select indexdef from pg_indexes where tablename = 'collection_gap' order by indexname`.execute(db)
  console.log(`\n--- ${label} ---`)
  console.log('tables:', tables.map((t) => t.table_name).join(', ') || '(none)')
  console.log('collection_gap columns:', cols.map((c) => `${c.column_name}:${c.data_type}`).join(', ') || '(none)')
  console.log('sub_state columns:', subcols.map((c) => c.column_name).join(', '))
  for (const i of idx) console.log('index:', i.indexdef)
}

const { error: upErr, results: upRes } = await migrator.migrateToLatest()
if (upErr) throw upErr
console.log('applied:', upRes?.map((r) => `${r.migrationName}=${r.status}`).join(' '))
await show('after migrateToLatest')

const { error: downErr, results: downRes } = await migrator.migrateDown()
if (downErr) throw downErr
console.log('\nreverted:', downRes?.map((r) => `${r.migrationName}=${r.status}`).join(' '))
await show('after migrateDown (006 reverted)')

const { error: up2 } = await migrator.migrateToLatest()
if (up2) throw up2
await show('after re-applying 006')
await db.destroy()
