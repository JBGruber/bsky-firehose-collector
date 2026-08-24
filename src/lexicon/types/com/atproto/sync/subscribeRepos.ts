/**
 * Generated, then hand-maintained alongside ../../../../lexicons.
 *
 * #handle and #migrate were retired from the message union upstream and are
 * gone. #tombstone was retired too, but its guard is kept: it costs nothing and
 * a non-Bluesky host may still emit one.
 */
import { ValidationResult, BlobRef } from '@atproto/lexicon'
import { lexicons } from '../../../../lexicons'
import { isObj, hasProp } from '../../../../util'
import { CID } from 'multiformats/cid'
import { HandlerAuth, ErrorFrame } from '@atproto/xrpc-server'
import { IncomingMessage } from 'http'

export interface QueryParams {
  /** The last known event to backfill from. */
  cursor?: number
}

export type OutputSchema =
  | Commit
  | Sync
  | Identity
  | Account
  | Tombstone
  | Info
  | { $type: string; [k: string]: unknown }
export type HandlerError = ErrorFrame<'FutureCursor' | 'ConsumerTooSlow'>
export type HandlerOutput = HandlerError | OutputSchema
export type HandlerReqCtx<HA extends HandlerAuth = never> = {
  auth: HA
  params: QueryParams
  req: IncomingMessage
  signal: AbortSignal
}
export type Handler<HA extends HandlerAuth = never> = (
  ctx: HandlerReqCtx<HA>,
) => AsyncIterable<HandlerOutput>

export interface Commit {
  seq: number
  rebase: boolean
  tooBig: boolean
  repo: string
  commit: CID
  prev?: CID | null
  /** The rev of the emitted commit */
  rev: string
  /** The rev of the last emitted commit from this repo */
  since: string | null
  /** CAR file containing relevant blocks */
  blocks: Uint8Array
  ops: RepoOp[]
  blobs: CID[]
  time: string
  [k: string]: unknown
}

export function isCommit(v: unknown): v is Commit {
  return (
    isObj(v) &&
    hasProp(v, '$type') &&
    v.$type === 'com.atproto.sync.subscribeRepos#commit'
  )
}

export function validateCommit(v: unknown): ValidationResult {
  return lexicons.validate('com.atproto.sync.subscribeRepos#commit', v)
}

/** Updates the repo to a new state, without necessarily including that state on the firehose. Used to recover from broken commit streams, data loss incidents, or in situations where upstream host does not know recent state of the repository. */
export interface Sync {
  /** The stream sequence number of this message. */
  seq: number
  /** The account this repo event corresponds to. Must match that in the commit object. */
  did: string
  /** CAR file containing the commit, as a block. The CAR header must include the commit block CID as the first 'root'. */
  blocks: Uint8Array
  /** The rev of the commit. This value must match that in the commit object. */
  rev: string
  /** Timestamp of when this message was originally broadcast. */
  time: string
  [k: string]: unknown
}

export function isSync(v: unknown): v is Sync {
  return (
    isObj(v) &&
    hasProp(v, '$type') &&
    v.$type === 'com.atproto.sync.subscribeRepos#sync'
  )
}

export function validateSync(v: unknown): ValidationResult {
  return lexicons.validate('com.atproto.sync.subscribeRepos#sync', v)
}

/** Represents a change to an account's identity. Could be an updated handle, signing key, or pds hosting endpoint. Serves as a prod to all downstream services to refresh their identity cache. */
export interface Identity {
  seq: number
  did: string
  time: string
  /** The current handle for the account, or 'handle.invalid' if validation fails. This field is optional, might have been validated or passed-through from an upstream source. Semantics and behaviors for PDS vs Relay may evolve in the future; see atproto specs for more details. */
  handle?: string
  [k: string]: unknown
}

export function isIdentity(v: unknown): v is Identity {
  return (
    isObj(v) &&
    hasProp(v, '$type') &&
    v.$type === 'com.atproto.sync.subscribeRepos#identity'
  )
}

export function validateIdentity(v: unknown): ValidationResult {
  return lexicons.validate('com.atproto.sync.subscribeRepos#identity', v)
}

/** Represents a change to an account's status on a host (eg, PDS or Relay). The semantics of this event are that the status is at the host which emitted the event, not necessarily that at the currently active PDS. Eg, a Relay takedown would emit a takedown with active=false, even if the PDS is still active. */
export interface Account {
  seq: number
  did: string
  time: string
  /** Indicates that the account has a repository which can be fetched from the host that emitted this event. */
  active: boolean
  /** If active=false, this optional field indicates a reason for why the account is not active. */
  status?: 'takendown' | 'suspended' | 'deleted' | 'deactivated' | (string & {})
  [k: string]: unknown
}

export function isAccount(v: unknown): v is Account {
  return (
    isObj(v) &&
    hasProp(v, '$type') &&
    v.$type === 'com.atproto.sync.subscribeRepos#account'
  )
}

export function validateAccount(v: unknown): ValidationResult {
  return lexicons.validate('com.atproto.sync.subscribeRepos#account', v)
}

/** Retired from the message union upstream in favour of #account with status 'deleted'. */
export interface Tombstone {
  seq: number
  did: string
  time: string
  [k: string]: unknown
}

export function isTombstone(v: unknown): v is Tombstone {
  return (
    isObj(v) &&
    hasProp(v, '$type') &&
    v.$type === 'com.atproto.sync.subscribeRepos#tombstone'
  )
}

export interface Info {
  name: 'OutdatedCursor' | (string & {})
  message?: string
  [k: string]: unknown
}

export function isInfo(v: unknown): v is Info {
  return (
    isObj(v) &&
    hasProp(v, '$type') &&
    v.$type === 'com.atproto.sync.subscribeRepos#info'
  )
}

export function validateInfo(v: unknown): ValidationResult {
  return lexicons.validate('com.atproto.sync.subscribeRepos#info', v)
}

/** A repo operation, ie a write of a single record. For creates and updates, cid is the record's CID as of this operation. For deletes, it's null. */
export interface RepoOp {
  action: 'create' | 'update' | 'delete' | (string & {})
  path: string
  cid: CID | null
  [k: string]: unknown
}

export function isRepoOp(v: unknown): v is RepoOp {
  return (
    isObj(v) &&
    hasProp(v, '$type') &&
    v.$type === 'com.atproto.sync.subscribeRepos#repoOp'
  )
}

export function validateRepoOp(v: unknown): ValidationResult {
  return lexicons.validate('com.atproto.sync.subscribeRepos#repoOp', v)
}
