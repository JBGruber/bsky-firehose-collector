/**
 * GENERATED CODE - DO NOT MODIFY
 */
import { ValidationResult, BlobRef } from '@atproto/lexicon'
import { lexicons } from '../../../../lexicons'
import { isObj, hasProp } from '../../../../util'
import { CID } from 'multiformats/cid'
import * as ComAtprotoRepoStrongRef from '../../../com/atproto/repo/strongRef'

export interface Main {
  external: External
  [k: string]: unknown
}

export function isMain(v: unknown): v is Main {
  return (
    isObj(v) &&
    hasProp(v, '$type') &&
    (v.$type === 'app.bsky.embed.external#main' ||
      v.$type === 'app.bsky.embed.external')
  )
}

export function validateMain(v: unknown): ValidationResult {
  return lexicons.validate('app.bsky.embed.external#main', v)
}

export interface External {
  uri: string
  title: string
  description: string
  thumb?: BlobRef
  /** StrongRefs (uri+cid) of the Atmosphere records that backed this view. */
  associatedRefs?: ComAtprotoRepoStrongRef.Main[]
  [k: string]: unknown
}

export function isExternal(v: unknown): v is External {
  return (
    isObj(v) &&
    hasProp(v, '$type') &&
    v.$type === 'app.bsky.embed.external#external'
  )
}

export function validateExternal(v: unknown): ValidationResult {
  return lexicons.validate('app.bsky.embed.external#external', v)
}
