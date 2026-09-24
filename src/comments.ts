import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { appendAudit } from './audit.js'
import { gitGrepFiles, gitLsFiles, gitShow } from './bare.js'
import { commitWork, type WorkWriteOptions } from './commands/work.js'
import { resolveContext } from './context.js'
import { streamRelPath, writeDocs } from './streams.js'
import { authorizeWrite } from './write.js'
import { findItem, readWorkItems, workPrefix, type LoreWorkItem } from './work.js'

/**
 * Comments on tickets. A comment made on the board (or by an agent, or with
 * `lore work comment`) is a stream doc — `context/streams/board/<KEY>/` —
 * so it is searchable, the fold reads it as evidence like any conversation,
 * and nothing about the tracker file changes. The linked issue's own
 * comments are already streamed by its connector (Jira, GitHub, Linear);
 * `ticketThread` merges the two for the board. Lore never posts back.
 */

export const COMMENT_SOURCE = 'board'
const MAX_COMMENT = 20_000

export interface TicketComment {
  id: string
  author: string
  at: string
  body: string
  /** "board", or the tracker the comment was mirrored from. */
  source: string
  url?: string
}

export function addComment(cwd: string, key: string, body: string, opts: WorkWriteOptions = {}): TicketComment {
  const text = body.replace(/\r\n/g, '\n').trim()
  if (!text) throw new Error('comment: say something')
  if (text.length > MAX_COMMENT) throw new Error(`comment: keep it under ${MAX_COMMENT} characters`)
  const ctx = resolveContext(cwd, opts)
  const actor = authorizeWrite(ctx, opts, 'comment')
  const item = findItem(readWorkItems(ctx.root, workPrefix(ctx.config)), key)
  if (!item) throw new Error(`work: no item ${key}`)
  const at = new Date().toISOString()
  const id = `board-${item.key}-${at.replace(/[-:.TZ]/g, '')}-${randomBytes(3).toString('hex')}`
  writeDocs(ctx.root, [{ id, source: COMMENT_SOURCE, channel: item.key, author: actor, timestamp: at, thread: item.key, meta: { ticket: item.key, by: actor, via: opts.via ?? 'cli' }, text }])
  appendAudit(ctx.root, { at, action: 'comment', actor, via: opts.via ?? 'cli', id: item.key })
  commitWork(ctx, streamRelPath(COMMENT_SOURCE, item.key, at), `lore: comment on ${item.key}`)
  return { id, author: actor, at, body: text, source: COMMENT_SOURCE }
}

// ---- reading, from a bare repo at HEAD ----

export interface StreamDoc {
  author: string
  at: string
  fields: Record<string, string>
  permalink?: string
  text: string
}

/** The docs in one stream file (the format streams.ts writes). */
export function parseStreamFile(text: string): StreamDoc[] {
  const out: StreamDoc[] = []
  const re = /^### (.+?) — (\S+)\n<!-- (.*?) -->\n/gm
  const heads = [...text.matchAll(re)]
  heads.forEach((m, n) => {
    const start = m.index! + m[0].length
    const end = n + 1 < heads.length ? heads[n + 1].index! : text.length
    let body = text.slice(start, end)
    let permalink: string | undefined
    const link = /^\[permalink\]\(([^)]+)\)\n/.exec(body)
    if (link) {
      permalink = link[1]
      body = body.slice(link[0].length)
    }
    const fields: Record<string, string> = {}
    for (const tok of m[3].matchAll(/(\w+): (\S+)/g)) fields[tok[1]] = tok[2]
    out.push({ author: m[1], at: m[2], fields, ...(permalink ? { permalink } : {}), text: body.trim() })
  })
  return out
}

/**
 * Every comment on a ticket, oldest first: the board's, plus the linked
 * issue's comments as its connector streamed them (Jira: thread = issue
 * key; GitHub: thread = issue-<n> in the repo's channel; Linear: thread =
 * identifier). State-change events are not comments and are left out.
 */
export function ticketThread(bareDir: string, item: Pick<LoreWorkItem, 'key' | 'external'>): TicketComment[] {
  const out: TicketComment[] = []
  const read = (path: string) => parseStreamFile(gitShow(bareDir, path, true))
  for (const path of gitLsFiles(bareDir, `context/streams/${COMMENT_SOURCE}/${item.key.replace(/[^a-zA-Z0-9#@_-]/g, '_')}`)) {
    for (const d of read(path)) out.push({ id: d.fields.id, author: d.author, at: d.at, body: d.text, source: COMMENT_SOURCE })
  }
  const ext = item.external
  if (ext) {
    let dir: string
    let thread: string
    let isComment: (d: StreamDoc) => boolean
    if (ext.system === 'jira') {
      dir = 'context/streams/jira'
      thread = ext.key
      isComment = (d) => Boolean(d.fields.comment)
    } else if (ext.system === 'linear') {
      dir = 'context/streams/linear'
      thread = ext.key
      isComment = (d) => d.fields.id?.startsWith('linear-comment-') ?? false
    } else {
      const m = /^github:([^/#]+\/[^/#]+)#(\d+)$/.exec(ext.id)
      if (!m) return sortThread(out)
      dir = join('context/streams/github', m[1].replace(/[^a-zA-Z0-9#@_-]/g, '_'))
      thread = `issue-${m[2]}`
      isComment = (d) => /-comment-/.test(d.fields.id ?? '') && d.fields.repo === m[1]
    }
    for (const path of gitGrepFiles(bareDir, `thread: ${thread} `, dir)) {
      for (const d of read(path)) {
        if (d.fields.thread !== thread || !isComment(d)) continue
        out.push({ id: d.fields.id, author: d.author, at: d.at, body: d.text, source: ext.system, ...(d.permalink ? { url: d.permalink } : {}) })
      }
    }
  }
  return sortThread(out)
}

function sortThread(list: TicketComment[]): TicketComment[] {
  const seen = new Set<string>()
  return list.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true))).sort((a, b) => a.at.localeCompare(b.at))
}
