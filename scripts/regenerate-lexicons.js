/**
 * Regenerates src/lexicon/lexicons.ts from the current AT Protocol lexicons.
 *
 * Usage, from the repo root:
 *
 *   mkdir -p .lexgen && cd .lexgen && npm init -y && npm i @atproto/api@latest && cd ..
 *   node scripts/regenerate-lexicons.js   # run from the repo root
 *   rm -rf .lexgen
 *
 * @atproto/api is not a project dependency -- it is only the source of truth for
 * lexicon documents, so it is installed for the duration and thrown away.
 *
 * What this does:
 *   - walks the transitive ref closure from the five entry points the collector
 *     actually validates against, and keeps nothing else;
 *   - drops any string `format` the pinned @atproto/lexicon cannot parse, since
 *     a document using an unknown format fails to load outright;
 *   - constructs `new Lexicons(...)` over the result before writing, so a broken
 *     regeneration fails here rather than at collector startup.
 *
 * After running: re-check src/lexicon/types/ by hand. The type files are not
 * generated, so a new def or union member has to be mirrored there.
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { schemaDict } from './.lexgen/node_modules/@atproto/api/dist/client/lexicons.js'
import { Lexicons } from '@atproto/lexicon'

const require = createRequire(import.meta.url)
const API_VERSION = require('./.lexgen/node_modules/@atproto/api/package.json').version
const LEX_VERSION = require('@atproto/lexicon/package.json').version
const OUT = './src/lexicon/lexicons.ts'

const byId = {}
for (const [key, doc] of Object.entries(schemaDict)) byId[doc.id] = { key, doc }

const entries = [
  'com.atproto.sync.subscribeRepos#main',
  'com.atproto.label.subscribeLabels#main',
  'app.bsky.feed.post#main',
  'app.bsky.feed.repost#main',
  'app.bsky.feed.like#main',
]

const resolve = (ref, ctxNsid) => {
  let r = ref.startsWith('lex:') ? ref.slice(4) : ref
  if (r.startsWith('#')) r = ctxNsid + r
  if (!r.includes('#')) r = r + '#main'
  return r
}
const collectRefs = (node, ctxNsid, out) => {
  if (Array.isArray(node)) return node.forEach((n) => collectRefs(n, ctxNsid, out))
  if (!node || typeof node !== 'object') return
  if (typeof node.ref === 'string') out.push(resolve(node.ref, ctxNsid))
  if (Array.isArray(node.refs))
    for (const r of node.refs) if (typeof r === 'string') out.push(resolve(r, ctxNsid))
  for (const v of Object.values(node)) collectRefs(v, ctxNsid, out)
}

const seen = new Set()
const queue = [...entries]
while (queue.length) {
  const cur = queue.pop()
  if (seen.has(cur)) continue
  const [nsid, defName] = cur.split('#')
  const entry = byId[nsid]
  if (!entry || !entry.doc.defs[defName]) throw new Error('unresolved ref: ' + cur)
  seen.add(cur)
  const refs = []
  collectRefs(entry.doc.defs[defName], nsid, refs)
  queue.push(...refs)
}

const keptDefs = {}
for (const d of seen) {
  const [nsid, def] = d.split('#')
  ;(keptDefs[nsid] ||= new Set()).add(def)
}

const nsids = Object.keys(keptDefs).sort((a, b) => {
  const rank = (n) => (n.startsWith('com.atproto.') ? 0 : 1)
  return rank(a) - rank(b) || a.localeCompare(b)
})

// Which string formats can the pinned @atproto/lexicon actually parse? Anything
// newer has to be dropped to a plain string, or `new Lexicons()` throws on load.
const formatSupported = (f) => {
  try {
    new Lexicons([
      { lexicon: 1, id: 'probe.format.check', defs: { main: { type: 'object', properties: { p: { type: 'string', format: f } } } } },
    ])
    return true
  } catch {
    return false
  }
}
const supported = new Map()
const stripped = new Set()
const stripFormats = (node, path) => {
  if (Array.isArray(node)) return node.forEach((n, i) => stripFormats(n, path))
  if (!node || typeof node !== 'object') return
  if (typeof node.format === 'string') {
    const f = node.format
    if (!supported.has(f)) supported.set(f, formatSupported(f))
    if (!supported.get(f)) {
      stripped.add(f)
      delete node.format
    }
  }
  for (const v of Object.values(node)) stripFormats(v, path)
}

const trimmed = {}
for (const nsid of nsids) {
  const { key, doc } = byId[nsid]
  const defs = {}
  for (const name of Object.keys(doc.defs)) {
    if (keptDefs[nsid].has(name)) defs[name] = JSON.parse(JSON.stringify(doc.defs[name]))
  }
  stripFormats(defs)
  const out = { lexicon: doc.lexicon, id: doc.id }
  if (doc.description) out.description = doc.description
  out.defs = defs
  trimmed[key] = out
}

// prove the result loads under the pinned validator before writing it
new Lexicons(Object.values(trimmed))

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const quote = (s) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
const ser = (v, indent) => {
  const pad = '  '.repeat(indent)
  const padIn = '  '.repeat(indent + 1)
  if (typeof v === 'string') return quote(v)
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v)
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    return '[\n' + v.map((x) => padIn + ser(x, indent + 1)).join(',\n') + ',\n' + pad + ']'
  }
  const keys = Object.keys(v)
  if (keys.length === 0) return '{}'
  return (
    '{\n' +
    keys.map((k) => padIn + (IDENT.test(k) ? k : quote(k)) + ': ' + ser(v[k], indent + 1)).join(',\n') +
    ',\n' + pad + '}'
  )
}

const strippedNote = stripped.size
  ? ` * One deliberate divergence from upstream: string format${stripped.size > 1 ? 's' : ''} ${[...stripped]
      .map((f) => `\`${f}\``)
      .join(', ')} ${stripped.size > 1 ? 'are' : 'is'} stripped, because
 * @atproto/lexicon ${LEX_VERSION} does not know ${stripped.size > 1 ? 'them' : 'it'} and refuses to load a document that
 * uses ${stripped.size > 1 ? 'them' : 'it'}. Those fields validate as plain strings here. Nothing is dropped
 * from the data as a result -- it only means one fewer shape check on a field
 * the collector does not read.
 *
`
  : ''

const header = `/**
 * Vendored AT Protocol lexicons.
 *
 * Hand-maintained and deliberately minimal: only the definitions this collector
 * validates against, plus everything they transitively reference. ${nsids.length} NSIDs,
 * where the previous copy was a 131-file feed-generator dump.
 *
 * That size was the problem, not just clutter. The old copy had drifted years
 * behind the protocol: it predated #account and #identity on subscribeRepos, so
 * account lifecycle events passed validation as unknown frames and were then
 * silently discarded, and it predated app.bsky.embed.video and
 * app.bsky.embed.gallery, so posts carrying either looked embed-less.
 *
 * Taken from @atproto/api ${API_VERSION} and pruned to that closure. The package is
 * not a dependency -- regenerating means installing it again for the duration.
 *
${strippedNote} * To add a stream or record type: add its NSID here along with every def its
 * refs reach, or validation throws on an unresolvable ref at runtime.
 */
import { LexiconDoc, Lexicons } from '@atproto/lexicon'

export const schemaDict = ${ser(trimmed, 0)}
export const schemas: LexiconDoc[] = Object.values(schemaDict) as LexiconDoc[]
export const lexicons: Lexicons = new Lexicons(schemas)
export const ids = {
${nsids.map((n) => `  ${byId[n].key}: ${quote(n)},`).join('\n')}
}
`

fs.writeFileSync(OUT, header)
console.log('wrote', OUT)
console.log('nsids:', nsids.length, '| stripped formats:', [...stripped].join(', ') || 'none')
