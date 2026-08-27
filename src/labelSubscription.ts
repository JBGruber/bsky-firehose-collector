import { Insertable } from 'kysely'
import {
  OutputSchema as LabelEvent,
  isLabels,
} from './lexicon/types/com/atproto/label/subscribeLabels.js'
import { ids } from './lexicon/lexicons.js'
import { Database } from './db/index.js'
import { Label } from './db/schema.js'
import { BatchSpec } from './util/batchWriter.js'
import { chunk, recordTimestamp } from './util/common.js'
import { StreamSubscriptionBase } from './util/subscription.js'

export type LabelBuffer = {
  labels: Insertable<Label>[]
}

const labelBatchSpec: BatchSpec<LabelBuffer> = {
  empty: () => ({ labels: [] }),
  size: (buf) => buf.labels.length,
  tables: (buf) => ({ label: buf.labels }),
  write: async (trx, buf) => {
    for (const rows of chunk(buf.labels, 1000)) {
      await trx
        .insertInto('label')
        .values(rows)
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
  },
}

export class LabelSubscription extends StreamSubscriptionBase<
  LabelEvent,
  LabelBuffer
> {
  constructor(db: Database, service: string, opts: { dataDir?: string | null } = {}) {
    super(db, service, {
      name: 'label',
      method: ids.ComAtprotoLabelSubscribeLabels,
      spec: labelBatchSpec,
      // labels arrive far more sparsely than repo commits, so a lower
      // high-water mark keeps them from sitting in the buffer
      writer: { highWater: 200 },
      // No ladder. There is nothing here worth shedding, and lag on a sparse
      // stream is measured against whenever the last label happened to be
      // issued, so it would escalate on quiet periods rather than on load. The
      // disk fallback still applies: it is driven by write failures, not by the
      // ladder.
      dataDir: opts.dataDir ?? null,
    })
  }

  protected eventTime(evt: LabelEvent): number | null {
    if (!isLabels(evt)) return null
    let latest: number | null = null
    for (const label of evt.labels) {
      const cts = Date.parse(label.cts)
      if (Number.isFinite(cts) && (latest === null || cts > latest)) {
        latest = cts
      }
    }
    return latest
  }

  protected async prepare(evt: LabelEvent) {
    if (!isLabels(evt)) return null

    // Wall clock rather than an event timestamp: the label frame carries no
    // `time` of its own, and `label` is not partitioned, so nothing depends on
    // this value being reproducible across a replay.
    const indexedAt = new Date().toISOString()
    const labels = evt.labels.map((label) => ({
      src: label.src,
      uri: label.uri,
      cid: label.cid ?? '',
      val: label.val,
      neg: label.neg ?? false,
      // `cts` is part of the unique key that deduplicates replayed labels, so
      // it cannot be null; the lexicon validates it as a datetime, and the
      // fallback only exists so an unparseable one cannot fail the batch.
      cts: recordTimestamp(label.cts) ?? indexedAt,
      indexedAt,
    }))

    if (labels.length === 0) return null

    return (buf: LabelBuffer) => {
      buf.labels.push(...labels)
    }
  }
}
