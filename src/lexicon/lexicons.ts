/**
 * Vendored AT Protocol lexicons.
 *
 * Hand-maintained and deliberately minimal: only the definitions this collector
 * validates against, plus everything they transitively reference. 15 NSIDs,
 * where the previous copy was a 131-file feed-generator dump.
 *
 * That size was the problem, not just clutter. The old copy had drifted years
 * behind the protocol: it predated #account and #identity on subscribeRepos, so
 * account lifecycle events passed validation as unknown frames and were then
 * silently discarded, and it predated app.bsky.embed.video and
 * app.bsky.embed.gallery, so posts carrying either looked embed-less.
 *
 * Taken from @atproto/api 0.20.41 and pruned to that closure. The package is
 * not a dependency -- regenerating means installing it again for the duration.
 *
 * One deliberate divergence from upstream: string format `tid` is stripped, because
 * @atproto/lexicon 0.2.3 does not know it and refuses to load a document that
 * uses it. Those fields validate as plain strings here. Nothing is dropped
 * from the data as a result -- it only means one fewer shape check on a field
 * the collector does not read.
 *
 * To add a stream or record type: add its NSID here along with every def its
 * refs reach, or validation throws on an unresolvable ref at runtime.
 */
import { LexiconDoc, Lexicons } from '@atproto/lexicon'

export const schemaDict = {
  ComAtprotoLabelDefs: {
    lexicon: 1,
    id: 'com.atproto.label.defs',
    defs: {
      label: {
        type: 'object',
        description: 'Metadata tag on an atproto resource (eg, repo or record).',
        required: [
          'src',
          'uri',
          'val',
          'cts',
        ],
        properties: {
          ver: {
            type: 'integer',
            description: 'The AT Protocol version of the label object.',
          },
          src: {
            type: 'string',
            format: 'did',
            description: 'DID of the actor who created this label.',
          },
          uri: {
            type: 'string',
            format: 'uri',
            description: 'AT URI of the record, repository (account), or other resource that this label applies to.',
          },
          cid: {
            type: 'string',
            format: 'cid',
            description: 'Optionally, CID specifying the specific version of \'uri\' resource this label applies to.',
          },
          val: {
            type: 'string',
            maxLength: 128,
            description: 'The short string name of the value or type of this label.',
          },
          neg: {
            type: 'boolean',
            description: 'If true, this is a negation label, overwriting a previous label.',
          },
          cts: {
            type: 'string',
            format: 'datetime',
            description: 'Timestamp when this label was created.',
          },
          exp: {
            type: 'string',
            format: 'datetime',
            description: 'Timestamp at which this label expires (no longer applies).',
          },
          sig: {
            type: 'bytes',
            description: 'Signature of dag-cbor encoded label.',
          },
        },
      },
      selfLabels: {
        type: 'object',
        description: 'Metadata tags on an atproto record, published by the author within the record.',
        required: [
          'values',
        ],
        properties: {
          values: {
            type: 'array',
            items: {
              type: 'ref',
              ref: 'lex:com.atproto.label.defs#selfLabel',
            },
            maxLength: 10,
          },
        },
      },
      selfLabel: {
        type: 'object',
        description: 'Metadata tag on an atproto record, published by the author within the record. Note that schemas should use #selfLabels, not #selfLabel.',
        required: [
          'val',
        ],
        properties: {
          val: {
            type: 'string',
            maxLength: 128,
            description: 'The short string name of the value or type of this label.',
          },
        },
      },
    },
  },
  ComAtprotoLabelSubscribeLabels: {
    lexicon: 1,
    id: 'com.atproto.label.subscribeLabels',
    defs: {
      main: {
        type: 'subscription',
        description: 'Subscribe to stream of labels (and negations). Public endpoint implemented by mod services. Uses same sequencing scheme as repo event stream.',
        parameters: {
          type: 'params',
          properties: {
            cursor: {
              type: 'integer',
              description: 'The last known event seq number to backfill from.',
            },
          },
        },
        message: {
          schema: {
            type: 'union',
            refs: [
              'lex:com.atproto.label.subscribeLabels#labels',
              'lex:com.atproto.label.subscribeLabels#info',
            ],
          },
        },
        errors: [
          {
            name: 'FutureCursor',
          },
        ],
      },
      labels: {
        type: 'object',
        required: [
          'seq',
          'labels',
        ],
        properties: {
          seq: {
            type: 'integer',
          },
          labels: {
            type: 'array',
            items: {
              type: 'ref',
              ref: 'lex:com.atproto.label.defs#label',
            },
          },
        },
      },
      info: {
        type: 'object',
        required: [
          'name',
        ],
        properties: {
          name: {
            type: 'string',
            knownValues: [
              'OutdatedCursor',
            ],
          },
          message: {
            type: 'string',
          },
        },
      },
    },
  },
  ComAtprotoRepoStrongRef: {
    lexicon: 1,
    id: 'com.atproto.repo.strongRef',
    description: 'A URI with a content-hash fingerprint.',
    defs: {
      main: {
        type: 'object',
        required: [
          'uri',
          'cid',
        ],
        properties: {
          uri: {
            type: 'string',
            format: 'at-uri',
          },
          cid: {
            type: 'string',
            format: 'cid',
          },
        },
      },
    },
  },
  ComAtprotoSyncSubscribeRepos: {
    lexicon: 1,
    id: 'com.atproto.sync.subscribeRepos',
    defs: {
      main: {
        type: 'subscription',
        description: 'Repository event stream, aka Firehose endpoint. Outputs repo commits with diff data, and identity update events, for all repositories on the current server. See the atproto specifications for details around stream sequencing, repo versioning, CAR diff format, and more. Public and does not require auth; implemented by PDS and Relay.',
        parameters: {
          type: 'params',
          properties: {
            cursor: {
              type: 'integer',
              description: 'The last known event seq number to backfill from.',
            },
          },
        },
        message: {
          schema: {
            type: 'union',
            refs: [
              'lex:com.atproto.sync.subscribeRepos#commit',
              'lex:com.atproto.sync.subscribeRepos#sync',
              'lex:com.atproto.sync.subscribeRepos#identity',
              'lex:com.atproto.sync.subscribeRepos#account',
              'lex:com.atproto.sync.subscribeRepos#info',
            ],
          },
        },
        errors: [
          {
            name: 'FutureCursor',
          },
          {
            name: 'ConsumerTooSlow',
            description: 'If the consumer of the stream can not keep up with events, and a backlog gets too large, the server will drop the connection.',
          },
        ],
      },
      commit: {
        type: 'object',
        description: 'Represents an update of repository state. Note that empty commits are allowed, which include no repo data changes, but an update to rev and signature.',
        required: [
          'seq',
          'rebase',
          'tooBig',
          'repo',
          'commit',
          'rev',
          'since',
          'blocks',
          'ops',
          'blobs',
          'time',
        ],
        nullable: [
          'since',
        ],
        properties: {
          seq: {
            type: 'integer',
            description: 'The stream sequence number of this message.',
          },
          rebase: {
            type: 'boolean',
            description: 'DEPRECATED -- unused',
          },
          tooBig: {
            type: 'boolean',
            description: 'DEPRECATED -- replaced by #sync event and data limits. Indicates that this commit contained too many ops, or data size was too large. Consumers will need to make a separate request to get missing data.',
          },
          repo: {
            type: 'string',
            format: 'did',
            description: 'The repo this event comes from. Note that all other message types name this field \'did\'.',
          },
          commit: {
            type: 'cid-link',
            description: 'Repo commit object CID.',
          },
          rev: {
            type: 'string',
            description: 'The rev of the emitted commit. Note that this information is also in the commit object included in blocks, unless this is a tooBig event.',
          },
          since: {
            type: 'string',
            description: 'The rev of the last emitted commit from this repo (if any).',
          },
          blocks: {
            type: 'bytes',
            description: 'CAR file containing relevant blocks, as a diff since the previous repo state. The commit must be included as a block, and the commit block CID must be the first entry in the CAR header \'roots\' list.',
            maxLength: 2000000,
          },
          ops: {
            type: 'array',
            items: {
              type: 'ref',
              ref: 'lex:com.atproto.sync.subscribeRepos#repoOp',
              description: 'List of repo mutation operations in this commit (eg, records created, updated, or deleted).',
            },
            maxLength: 200,
          },
          blobs: {
            type: 'array',
            items: {
              type: 'cid-link',
              description: 'DEPRECATED -- will soon always be empty. List of new blobs (by CID) referenced by records in this commit.',
            },
          },
          prevData: {
            type: 'cid-link',
            description: 'The root CID of the MST tree for the previous commit from this repo (indicated by the \'since\' revision field in this message). Corresponds to the \'data\' field in the repo commit object. NOTE: this field is effectively required for the \'inductive\' version of firehose.',
          },
          time: {
            type: 'string',
            format: 'datetime',
            description: 'Timestamp of when this message was originally broadcast.',
          },
        },
      },
      sync: {
        type: 'object',
        description: 'Updates the repo to a new state, without necessarily including that state on the firehose. Used to recover from broken commit streams, data loss incidents, or in situations where upstream host does not know recent state of the repository.',
        required: [
          'seq',
          'did',
          'blocks',
          'rev',
          'time',
        ],
        properties: {
          seq: {
            type: 'integer',
            description: 'The stream sequence number of this message.',
          },
          did: {
            type: 'string',
            format: 'did',
            description: 'The account this repo event corresponds to. Must match that in the commit object.',
          },
          blocks: {
            type: 'bytes',
            description: 'CAR file containing the commit, as a block. The CAR header must include the commit block CID as the first \'root\'.',
            maxLength: 10000,
          },
          rev: {
            type: 'string',
            description: 'The rev of the commit. This value must match that in the commit object.',
          },
          time: {
            type: 'string',
            format: 'datetime',
            description: 'Timestamp of when this message was originally broadcast.',
          },
        },
      },
      identity: {
        type: 'object',
        description: 'Represents a change to an account\'s identity. Could be an updated handle, signing key, or pds hosting endpoint. Serves as a prod to all downstream services to refresh their identity cache.',
        required: [
          'seq',
          'did',
          'time',
        ],
        properties: {
          seq: {
            type: 'integer',
          },
          did: {
            type: 'string',
            format: 'did',
          },
          time: {
            type: 'string',
            format: 'datetime',
          },
          handle: {
            type: 'string',
            format: 'handle',
            description: 'The current handle for the account, or \'handle.invalid\' if validation fails. This field is optional, might have been validated or passed-through from an upstream source. Semantics and behaviors for PDS vs Relay may evolve in the future; see atproto specs for more details.',
          },
        },
      },
      account: {
        type: 'object',
        description: 'Represents a change to an account\'s status on a host (eg, PDS or Relay). The semantics of this event are that the status is at the host which emitted the event, not necessarily that at the currently active PDS. Eg, a Relay takedown would emit a takedown with active=false, even if the PDS is still active.',
        required: [
          'seq',
          'did',
          'time',
          'active',
        ],
        properties: {
          seq: {
            type: 'integer',
          },
          did: {
            type: 'string',
            format: 'did',
          },
          time: {
            type: 'string',
            format: 'datetime',
          },
          active: {
            type: 'boolean',
            description: 'Indicates that the account has a repository which can be fetched from the host that emitted this event.',
          },
          status: {
            type: 'string',
            description: 'If active=false, this optional field indicates a reason for why the account is not active.',
            knownValues: [
              'takendown',
              'suspended',
              'deleted',
              'deactivated',
              'desynchronized',
              'throttled',
            ],
          },
        },
      },
      info: {
        type: 'object',
        required: [
          'name',
        ],
        properties: {
          name: {
            type: 'string',
            knownValues: [
              'OutdatedCursor',
            ],
          },
          message: {
            type: 'string',
          },
        },
      },
      repoOp: {
        type: 'object',
        description: 'A repo operation, ie a mutation of a single record.',
        required: [
          'action',
          'path',
          'cid',
        ],
        nullable: [
          'cid',
        ],
        properties: {
          action: {
            type: 'string',
            knownValues: [
              'create',
              'update',
              'delete',
            ],
          },
          path: {
            type: 'string',
          },
          cid: {
            type: 'cid-link',
            description: 'For creates and updates, the new record CID. For deletions, null.',
          },
          prev: {
            type: 'cid-link',
            description: 'For updates and deletes, the previous record CID (required for inductive firehose). For creations, field should not be defined.',
          },
        },
      },
    },
  },
  AppBskyEmbedDefs: {
    lexicon: 1,
    id: 'app.bsky.embed.defs',
    defs: {
      aspectRatio: {
        type: 'object',
        description: 'width:height represents an aspect ratio. It may be approximate, and may not correspond to absolute dimensions in any given unit.',
        required: [
          'width',
          'height',
        ],
        properties: {
          width: {
            type: 'integer',
            minimum: 1,
          },
          height: {
            type: 'integer',
            minimum: 1,
          },
        },
      },
    },
  },
  AppBskyEmbedExternal: {
    lexicon: 1,
    id: 'app.bsky.embed.external',
    defs: {
      main: {
        type: 'object',
        description: 'A representation of some externally linked content (eg, a URL and \'card\'), embedded in a Bluesky record (eg, a post).',
        required: [
          'external',
        ],
        properties: {
          external: {
            type: 'ref',
            ref: 'lex:app.bsky.embed.external#external',
          },
        },
      },
      external: {
        type: 'object',
        required: [
          'uri',
          'title',
          'description',
        ],
        properties: {
          uri: {
            type: 'string',
            format: 'uri',
          },
          title: {
            type: 'string',
          },
          description: {
            type: 'string',
          },
          thumb: {
            type: 'blob',
            accept: [
              'image/*',
            ],
            maxSize: 1000000,
          },
          associatedRefs: {
            type: 'array',
            items: {
              type: 'ref',
              ref: 'lex:com.atproto.repo.strongRef',
            },
            description: 'StrongRefs (uri+cid) of the Atmosphere records that backed this view.',
          },
        },
      },
    },
  },
  AppBskyEmbedGallery: {
    lexicon: 1,
    id: 'app.bsky.embed.gallery',
    description: 'An assortment of media embedded in a Bluesky record (eg, a post).',
    defs: {
      main: {
        type: 'object',
        required: [
          'items',
        ],
        properties: {
          items: {
            type: 'array',
            maxLength: 20,
            description: 'The schema-level maxLength of 20 is a future-proof ceiling. Clients should currently enforce a soft limit of 10 items in authoring UIs.',
            items: {
              type: 'union',
              refs: [
                'lex:app.bsky.embed.gallery#image',
              ],
              description: 'The media items in the gallery. Each item may be of a different type, but all types must be supported by the client.',
            },
          },
        },
      },
      image: {
        type: 'object',
        required: [
          'image',
          'alt',
          'aspectRatio',
        ],
        properties: {
          image: {
            type: 'blob',
            accept: [
              'image/*',
            ],
            maxSize: 2000000,
          },
          alt: {
            type: 'string',
            description: 'Alt text description of the image, for accessibility.',
          },
          aspectRatio: {
            type: 'ref',
            ref: 'lex:app.bsky.embed.defs#aspectRatio',
          },
        },
      },
    },
  },
  AppBskyEmbedImages: {
    lexicon: 1,
    id: 'app.bsky.embed.images',
    description: 'A set of images embedded in a Bluesky record (eg, a post).',
    defs: {
      main: {
        type: 'object',
        required: [
          'images',
        ],
        properties: {
          images: {
            type: 'array',
            items: {
              type: 'ref',
              ref: 'lex:app.bsky.embed.images#image',
            },
            maxLength: 4,
          },
        },
      },
      image: {
        type: 'object',
        required: [
          'image',
          'alt',
        ],
        properties: {
          image: {
            type: 'blob',
            description: 'The raw image file. May be up to 2 MB, formerly limited to 1 MB.',
            accept: [
              'image/*',
            ],
            maxSize: 2000000,
          },
          alt: {
            type: 'string',
            description: 'Alt text description of the image, for accessibility.',
          },
          aspectRatio: {
            type: 'ref',
            ref: 'lex:app.bsky.embed.defs#aspectRatio',
          },
        },
      },
    },
  },
  AppBskyEmbedRecord: {
    lexicon: 1,
    id: 'app.bsky.embed.record',
    description: 'A representation of a record embedded in a Bluesky record (eg, a post). For example, a quote-post, or sharing a feed generator record.',
    defs: {
      main: {
        type: 'object',
        required: [
          'record',
        ],
        properties: {
          record: {
            type: 'ref',
            ref: 'lex:com.atproto.repo.strongRef',
          },
        },
      },
    },
  },
  AppBskyEmbedRecordWithMedia: {
    lexicon: 1,
    id: 'app.bsky.embed.recordWithMedia',
    description: 'A representation of a record embedded in a Bluesky record (eg, a post), alongside other compatible embeds. For example, a quote post and image, or a quote post and external URL card.',
    defs: {
      main: {
        type: 'object',
        required: [
          'record',
          'media',
        ],
        properties: {
          record: {
            type: 'ref',
            ref: 'lex:app.bsky.embed.record',
          },
          media: {
            type: 'union',
            refs: [
              'lex:app.bsky.embed.images',
              'lex:app.bsky.embed.video',
              'lex:app.bsky.embed.gallery',
              'lex:app.bsky.embed.external',
            ],
          },
        },
      },
    },
  },
  AppBskyEmbedVideo: {
    lexicon: 1,
    id: 'app.bsky.embed.video',
    description: 'A video embedded in a Bluesky record (eg, a post).',
    defs: {
      main: {
        type: 'object',
        required: [
          'video',
        ],
        properties: {
          video: {
            type: 'blob',
            description: 'The mp4 video file. May be up to 300mb, formerly limited to 100mb.',
            accept: [
              'video/mp4',
            ],
            maxSize: 300000000,
          },
          captions: {
            type: 'array',
            items: {
              type: 'ref',
              ref: 'lex:app.bsky.embed.video#caption',
            },
            maxLength: 20,
          },
          alt: {
            type: 'string',
            description: 'Alt text description of the video, for accessibility.',
          },
          aspectRatio: {
            type: 'ref',
            ref: 'lex:app.bsky.embed.defs#aspectRatio',
          },
          presentation: {
            type: 'string',
            description: 'A hint to the client about how to present the video.',
            knownValues: [
              'default',
              'gif',
            ],
          },
        },
      },
      caption: {
        type: 'object',
        required: [
          'lang',
          'file',
        ],
        properties: {
          lang: {
            type: 'string',
            format: 'language',
          },
          file: {
            type: 'blob',
            accept: [
              'text/vtt',
            ],
            maxSize: 20000,
          },
        },
      },
    },
  },
  AppBskyFeedLike: {
    lexicon: 1,
    id: 'app.bsky.feed.like',
    defs: {
      main: {
        type: 'record',
        description: 'Record declaring a \'like\' of a piece of subject content.',
        key: 'tid',
        record: {
          type: 'object',
          required: [
            'subject',
            'createdAt',
          ],
          properties: {
            subject: {
              type: 'ref',
              ref: 'lex:com.atproto.repo.strongRef',
            },
            createdAt: {
              type: 'string',
              format: 'datetime',
            },
            via: {
              type: 'ref',
              ref: 'lex:com.atproto.repo.strongRef',
            },
          },
        },
      },
    },
  },
  AppBskyFeedPost: {
    lexicon: 1,
    id: 'app.bsky.feed.post',
    defs: {
      main: {
        type: 'record',
        description: 'Record containing a Bluesky post.',
        key: 'tid',
        record: {
          type: 'object',
          required: [
            'text',
            'createdAt',
          ],
          properties: {
            text: {
              type: 'string',
              maxLength: 3000,
              maxGraphemes: 300,
              description: 'The primary post content. May be an empty string, if there are embeds.',
            },
            entities: {
              type: 'array',
              description: 'DEPRECATED: replaced by app.bsky.richtext.facet.',
              items: {
                type: 'ref',
                ref: 'lex:app.bsky.feed.post#entity',
              },
            },
            facets: {
              type: 'array',
              description: 'Annotations of text (mentions, URLs, hashtags, etc)',
              items: {
                type: 'ref',
                ref: 'lex:app.bsky.richtext.facet',
              },
            },
            reply: {
              type: 'ref',
              ref: 'lex:app.bsky.feed.post#replyRef',
            },
            embed: {
              type: 'union',
              refs: [
                'lex:app.bsky.embed.images',
                'lex:app.bsky.embed.video',
                'lex:app.bsky.embed.gallery',
                'lex:app.bsky.embed.external',
                'lex:app.bsky.embed.record',
                'lex:app.bsky.embed.recordWithMedia',
              ],
            },
            langs: {
              type: 'array',
              description: 'Indicates human language of post primary text content.',
              maxLength: 3,
              items: {
                type: 'string',
                format: 'language',
              },
            },
            labels: {
              type: 'union',
              description: 'Self-label values for this post. Effectively content warnings.',
              refs: [
                'lex:com.atproto.label.defs#selfLabels',
              ],
            },
            tags: {
              type: 'array',
              description: 'Additional hashtags, in addition to any included in post text and facets.',
              maxLength: 8,
              items: {
                type: 'string',
                maxLength: 640,
                maxGraphemes: 64,
              },
            },
            createdAt: {
              type: 'string',
              format: 'datetime',
              description: 'Client-declared timestamp when this post was originally created.',
            },
          },
        },
      },
      replyRef: {
        type: 'object',
        required: [
          'root',
          'parent',
        ],
        properties: {
          root: {
            type: 'ref',
            ref: 'lex:com.atproto.repo.strongRef',
          },
          parent: {
            type: 'ref',
            ref: 'lex:com.atproto.repo.strongRef',
          },
        },
      },
      entity: {
        type: 'object',
        description: 'Deprecated: use facets instead.',
        required: [
          'index',
          'type',
          'value',
        ],
        properties: {
          index: {
            type: 'ref',
            ref: 'lex:app.bsky.feed.post#textSlice',
          },
          type: {
            type: 'string',
            description: 'Expected values are \'mention\' and \'link\'.',
          },
          value: {
            type: 'string',
          },
        },
      },
      textSlice: {
        type: 'object',
        description: 'Deprecated. Use app.bsky.richtext instead -- A text segment. Start is inclusive, end is exclusive. Indices are for utf16-encoded strings.',
        required: [
          'start',
          'end',
        ],
        properties: {
          start: {
            type: 'integer',
            minimum: 0,
          },
          end: {
            type: 'integer',
            minimum: 0,
          },
        },
      },
    },
  },
  AppBskyFeedRepost: {
    lexicon: 1,
    id: 'app.bsky.feed.repost',
    defs: {
      main: {
        description: 'Record representing a \'repost\' of an existing Bluesky post.',
        type: 'record',
        key: 'tid',
        record: {
          type: 'object',
          required: [
            'subject',
            'createdAt',
          ],
          properties: {
            subject: {
              type: 'ref',
              ref: 'lex:com.atproto.repo.strongRef',
            },
            createdAt: {
              type: 'string',
              format: 'datetime',
            },
            via: {
              type: 'ref',
              ref: 'lex:com.atproto.repo.strongRef',
            },
          },
        },
      },
    },
  },
  AppBskyRichtextFacet: {
    lexicon: 1,
    id: 'app.bsky.richtext.facet',
    defs: {
      main: {
        type: 'object',
        description: 'Annotation of a sub-string within rich text.',
        required: [
          'index',
          'features',
        ],
        properties: {
          index: {
            type: 'ref',
            ref: 'lex:app.bsky.richtext.facet#byteSlice',
          },
          features: {
            type: 'array',
            items: {
              type: 'union',
              refs: [
                'lex:app.bsky.richtext.facet#mention',
                'lex:app.bsky.richtext.facet#link',
                'lex:app.bsky.richtext.facet#tag',
              ],
            },
          },
        },
      },
      mention: {
        type: 'object',
        description: 'Facet feature for mention of another account. The text is usually a handle, including a \'@\' prefix, but the facet reference is a DID.',
        required: [
          'did',
        ],
        properties: {
          did: {
            type: 'string',
            format: 'did',
          },
        },
      },
      link: {
        type: 'object',
        description: 'Facet feature for a URL. The text URL may have been simplified or truncated, but the facet reference should be a complete URL.',
        required: [
          'uri',
        ],
        properties: {
          uri: {
            type: 'string',
            format: 'uri',
          },
        },
      },
      tag: {
        type: 'object',
        description: 'Facet feature for a hashtag. The text usually includes a \'#\' prefix, but the facet reference should not (except in the case of \'double hash tags\').',
        required: [
          'tag',
        ],
        properties: {
          tag: {
            type: 'string',
            maxLength: 640,
            maxGraphemes: 64,
          },
        },
      },
      byteSlice: {
        type: 'object',
        description: 'Specifies the sub-string range a facet feature applies to. Start index is inclusive, end index is exclusive. Indices are zero-indexed, counting bytes of the UTF-8 encoded text. NOTE: some languages, like Javascript, use UTF-16 or Unicode codepoints for string slice indexing; in these languages, convert to byte arrays before working with facets.',
        required: [
          'byteStart',
          'byteEnd',
        ],
        properties: {
          byteStart: {
            type: 'integer',
            minimum: 0,
          },
          byteEnd: {
            type: 'integer',
            minimum: 0,
          },
        },
      },
    },
  },
}
export const schemas: LexiconDoc[] = Object.values(schemaDict) as LexiconDoc[]
export const lexicons: Lexicons = new Lexicons(schemas)
export const ids = {
  ComAtprotoLabelDefs: 'com.atproto.label.defs',
  ComAtprotoLabelSubscribeLabels: 'com.atproto.label.subscribeLabels',
  ComAtprotoRepoStrongRef: 'com.atproto.repo.strongRef',
  ComAtprotoSyncSubscribeRepos: 'com.atproto.sync.subscribeRepos',
  AppBskyEmbedDefs: 'app.bsky.embed.defs',
  AppBskyEmbedExternal: 'app.bsky.embed.external',
  AppBskyEmbedGallery: 'app.bsky.embed.gallery',
  AppBskyEmbedImages: 'app.bsky.embed.images',
  AppBskyEmbedRecord: 'app.bsky.embed.record',
  AppBskyEmbedRecordWithMedia: 'app.bsky.embed.recordWithMedia',
  AppBskyEmbedVideo: 'app.bsky.embed.video',
  AppBskyFeedLike: 'app.bsky.feed.like',
  AppBskyFeedPost: 'app.bsky.feed.post',
  AppBskyFeedRepost: 'app.bsky.feed.repost',
  AppBskyRichtextFacet: 'app.bsky.richtext.facet',
}
