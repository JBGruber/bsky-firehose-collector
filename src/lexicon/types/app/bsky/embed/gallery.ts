/**
 * GENERATED CODE - DO NOT MODIFY
 */
import { ValidationResult, BlobRef } from '@atproto/lexicon'
import { lexicons } from '../../../../lexicons'
import { isObj, hasProp } from '../../../../util'
import { CID } from 'multiformats/cid'
import * as AppBskyEmbedDefs from './defs'

export interface Main {
  /** The media items in the gallery. Each item may be of a different type, but all types must be supported by the client. */
  items: (Image | { $type: string; [k: string]: unknown })[]
  [k: string]: unknown
}

export function isMain(v: unknown): v is Main {
  return (
    isObj(v) &&
    hasProp(v, '$type') &&
    (v.$type === 'app.bsky.embed.gallery#main' ||
      v.$type === 'app.bsky.embed.gallery')
  )
}

export function validateMain(v: unknown): ValidationResult {
  return lexicons.validate('app.bsky.embed.gallery#main', v)
}

export interface Image {
  image: BlobRef
  /** Alt text description of the image, for accessibility. */
  alt: string
  aspectRatio: AppBskyEmbedDefs.AspectRatio
  [k: string]: unknown
}

export function isImage(v: unknown): v is Image {
  return (
    isObj(v) && hasProp(v, '$type') && v.$type === 'app.bsky.embed.gallery#image'
  )
}

export function validateImage(v: unknown): ValidationResult {
  return lexicons.validate('app.bsky.embed.gallery#image', v)
}
