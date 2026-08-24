import {
  OutputSchema as LabelEvent,
  isLabels,
} from './lexicon/types/com/atproto/label/subscribeLabels'
import { ids } from './lexicon/lexicons'
import { Database } from './db'
import { Label } from './db/schema'
import { BatchSpec } from './util/batchWriter'
import { chunk } from './util/common'
import { StreamSubscriptionBase } from './util/subscription'

export type LabelBuffer = {
  labels: Label[]
}

const labelBatchSpec: BatchSpec<LabelBuffer> = {
  empty: () => ({ labels: [] }),
  size: (buf) => buf.labels.length,
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
  constructor(db: Database, service: string) {
    super(db, service, {
      name: 'label',
      method: ids.ComAtprotoLabelSubscribeLabels,
      spec: labelBatchSpec,
      // labels arrive far more sparsely than repo commits, so a lower
      // high-water mark keeps them from sitting in the buffer
      writer: { highWater: 200 },
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

    const indexedAt = new Date().toISOString()
    const labels = evt.labels.map((label) => ({
      src: label.src,
      uri: label.uri,
      cid: label.cid ?? '',
      val: label.val,
      neg: label.neg ?? false,
      cts: label.cts,
      indexedAt,
    }))

    if (labels.length === 0) return null

    return (buf: LabelBuffer) => {
      buf.labels.push(...labels)
    }
  }
}
