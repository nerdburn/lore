import { createHash } from 'node:crypto'
import { slugify } from './document.js'
import { streamRelPath } from './streams.js'
import type { Doc } from './types.js'

/**
 * The `docs` stream: documents as raw material, one folder per document
 * slug, one entry per version of its content. Built here so `lore doc add`
 * (a person or agent filing a link) and the Gmail connector (a document a
 * client linked or attached in an email) write the identical shape.
 */

export const DOCS_SOURCE = 'docs'

export interface StreamDocInput {
  title: string
  body: string
  /** Who sent or authored it — the stream heading's author. */
  from: string
  /** YYYY-MM-DD the document belongs to. */
  date: string
  /** Where it lives — the permalink derived items cite. */
  source?: string
  /** Drive file id, when it came from Google — part of the doc id so versions of one file group. */
  gdocId?: string
  meta?: Record<string, string>
  /** Who filed it: an OS user, or `lore-sync` for the connector. */
  addedBy: string
}

export function buildStreamDoc(input: StreamDocInput): { doc: Doc; rel: string; slug: string; id: string } {
  const slug = slugify(input.title)
  const digest = createHash('sha256').update(input.body).digest('hex').slice(0, 12)
  const id = `doc-${input.gdocId ? `${input.gdocId}-` : ''}${digest}`
  const timestamp = `${input.date}T00:00:00.000Z`
  const doc: Doc = {
    id,
    source: DOCS_SOURCE,
    channel: slug,
    author: input.from,
    timestamp,
    ...(input.source ? { permalink: input.source } : {}),
    meta: { title: slug, ...(input.gdocId ? { gdoc: input.gdocId } : {}), ...(input.meta ?? {}), added_by: input.addedBy.replace(/\s+/g, '_') },
    text: `# ${input.title}\n\n${input.body.trim()}`,
  }
  return { doc, rel: streamRelPath(DOCS_SOURCE, slug, timestamp), slug, id }
}
