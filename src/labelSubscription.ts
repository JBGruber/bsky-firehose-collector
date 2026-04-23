import {
  OutputSchema as LabelEvent,
  isLabels,
} from './lexicon/types/com/atproto/label/subscribeLabels'
import { LabelSubscriptionBase } from './util/subscription'

export class LabelSubscription extends LabelSubscriptionBase {
  async handleEvent(evt: LabelEvent) {
    if (!isLabels(evt)) return

    const labelsToCreate = evt.labels.map((label) => ({
      src: label.src,
      uri: label.uri,
      cid: label.cid ?? '',
      val: label.val,
      neg: label.neg ?? false,
      cts: label.cts,
      indexedAt: new Date().toISOString(),
    }))

    if (labelsToCreate.length > 0) {
      await this.db
        .insertInto('label')
        .values(labelsToCreate)
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
  }
}
