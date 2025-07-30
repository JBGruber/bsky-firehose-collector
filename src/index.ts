import { createDb, migrateToLatest } from './db'
import { FirehoseSubscription } from './subscription'

const run = async () => {
  const pgHost = process.env.COLLECTOR_DB_HOST || 'localhost'
  const pgPort = parseInt(process.env.COLLECTOR_DB_PORT || '5432', 10)
  const pgUser = process.env.COLLECTOR_DB_USER || 'collector'
  const pgPassword = process.env.COLLECTOR_DB_PASSWORD || 'collector'
  const pgDatabase = process.env.COLLECTOR_DB_DATABASE || 'collector-db'
  
  const connectionString = process.env.COLLECTOR_POSTGRES_URL || 
    `postgres://${pgUser}:${pgPassword}@${pgHost}:${pgPort}/${pgDatabase}`
  
  console.log(`[${new Date().toISOString()}] - Connecting to database: ${pgHost}:${pgPort}/${pgDatabase}`)
  
  const db = createDb(connectionString)
  
  await migrateToLatest(db)
  
  const firehose = new FirehoseSubscription(
    db, 
    process.env.COLLECTOR_SUBSCRIPTION_ENDPOINT || 'wss://bsky.network'
  )
  
  firehose.run(
    parseInt(process.env.COLLECTOR_SUBSCRIPTION_RECONNECT_DELAY || '3000', 10)
  )
  
  console.log(`[${new Date().toISOString()}] - 🔥 Firehose collection started`)
}

run().catch(console.error)