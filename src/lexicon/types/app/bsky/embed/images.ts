/**
 * GENERATED CODE - DO NOT MODIFY
 */
import { ValidationResult, BlobRef } from '@atproto/lexicon'
import { lexicons } from '../../../../lexicons.js'
import { isObj, hasProp } from '../../../../util.js'
import { CID } from 'multiformats/cid'
import * as AppBskyEmbedDefs from './defs.js'

export interface Main {
  images: Image[]
  [k: string]: unknown
}

export function isMain(v: unknown): v is Main {
  return (
    isObj(v) &&
    hasProp(v, '$type') &&
    (v.$type === 'app.bsky.embed.images#main' ||
      v.$type === 'app.bsky.embed.images')
  )
}

export function validateMain(v: unknown): ValidationResult {
  return lexicons.validate('app.bsky.embed.images#main', v)
}

export interface Image {
  image: BlobRef
  /** Alt text description of the image, for accessibility. */
  alt: string
  aspectRatio?: AppBskyEmbedDefs.AspectRatio
  [k: string]: unknown
}

export function isImage(v: unknown): v is Image {
  return (
    isObj(v) && hasProp(v, '$type') && v.$type === 'app.bsky.embed.images#image'
  )
}

export function validateImage(v: unknown): ValidationResult {
  return lexicons.validate('app.bsky.embed.images#image', v)
}
