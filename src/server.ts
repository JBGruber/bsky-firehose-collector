import http from 'http'
import events from 'events'
import express from 'express'
import { didResolver, MemoryCache } from '@atproto/identity'
import { createServer } from './lexicon'
import { createDb, Database, migrateToLatest } from './db'
import { FirehoseSubscription } from './subscription'
import { AppContext, Config } from './config'

export class FeedGenerator {
  public app: express.Application
  public server?: http.Server
  public db: Database
  public firehose: FirehoseSubscription
  public cfg: Config
  private followsUpdateTimer?: NodeJS.Timeout

  constructor(
    app: express.Application,
    db: Database,
    firehose: FirehoseSubscription,
    cfg: Config,
  ) {
    this.app = app
    this.db = db
    this.firehose = firehose
    this.cfg = cfg
  }

  static create(cfg: Config) {
    const app = express()
    const db = createDb(cfg.postgresUrl ||
      `postgres://${cfg.pgUser}:${cfg.pgPassword}@${cfg.pgHost}:${cfg.pgPort}/${cfg.pgDatabase}`)
    const firehose = new FirehoseSubscription(db, cfg.subscriptionEndpoint)

    const didCache = new MemoryCache()
    const didResolver = new didResolver({
      plcUrl: 'https://plc.directory',
      didCache,
    })

    const server = createServer({
      validateResponse: true,
      payload: {
        jsonLimit: 100 * 1024, // 100kb
        textLimit: 100 * 1024, // 100kb
        blobLimit: 5 * 1024 * 1024, // 5mb
      },
    })
    const ctx: AppContext = {
      db,
      didResolver,
      cfg,
    }

    return new FeedGenerator(app, db, firehose, cfg)
  }

  async start(): Promise<http.Server> {
    await migrateToLatest(this.db)
    this.firehose.run(this.cfg.subscriptionReconnectDelay)
    this.server = this.app.listen(this.cfg.port, this.cfg.listenhost)
    await events.once(this.server, 'listening')

    // Set up the scheduler to update follows
    // Run once every hour by default (or override with env var)
    const updateInterval = parseInt(process.env.FOLLOWS_UPDATE_INTERVAL_MS || '', 10) || 60 * 60 * 1000;
    console.log(`[${new Date().toISOString()}] - Setting up follows updater to run every ${updateInterval / 1000} seconds`);
    
    return this.server
  }

  async stop(): Promise<void> {
    
    if (this.db) {
      await this.db.destroy();
    }
    
    // Close the server if it's running
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }
}

export default FeedGenerator
