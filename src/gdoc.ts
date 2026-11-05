import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { sshTargetFromRemote } from './commands/refresh.js'
import { defaultKeyFile, signJwt } from './connectors/gmail.js'
import { readGlobalConfig } from './context.js'
import { pdfText } from './document.js'
import { officeKind, officeText } from './office.js'

/**
 * Google Docs and Drive files as text. A pasted docs.google.com or
 * drive.google.com link is resolved on a machine holding the Workspace
 * service-account key (the same one the Gmail connector uses — domain-wide
 * delegation must include `drive.readonly`): the account acts as a teammate
 * (`as`, default `client.owner`) and asks the Drive API for the content.
 * Documents are never made link-shareable for this; the account only sees
 * what that teammate can.
 *
 * What comes back as text: a Google Doc as Markdown, Slides as plain text,
 * a Sheet as CSV, and a Drive-hosted PDF, Markdown, or text file as-is
 * (PDFs through the same extraction `sow add` uses for local files). A
 * folder link is walked (subfolders too) and each of those files read.
 */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

const GOOGLE_EXPORTS: Record<string, { mime: string; kind: string; path: string }> = {
  'application/vnd.google-apps.document': { mime: 'text/markdown', kind: 'Google Doc', path: 'document' },
  'application/vnd.google-apps.presentation': { mime: 'text/plain', kind: 'Google Slides', path: 'presentation' },
  'application/vnd.google-apps.spreadsheet': { mime: 'text/csv', kind: 'Google Sheet', path: 'spreadsheets' },
}
const TEXT_MIMES = /^text\/(?:markdown|plain|x-markdown|csv)\b|^application\/json\b/

export interface GoogleDoc {
  id: string
  name: string
  /** The document as text — Markdown for Docs; see the module comment for other types. */
  markdown: string
  url: string
  /** Drive MIME type — `application/vnd.google-apps.document` for a Doc. */
  mimeType?: string
  /** Drive `modifiedTime`, ISO 8601. */
  modified?: string
  /** Display name of the Drive owner, when Drive reports one. */
  owner?: string
}

export interface GdocDeps {
  fetch?: typeof fetch
  keyFile?: string
  now?: () => number
}

/** docs.google.com/{document,spreadsheets,presentation}/d/<id>/… or drive.google.com/file/d/<id>/… → id; anything else → undefined. */
export function googleDocId(url: string): string | undefined {
  const m = /^https?:\/\/(?:docs|drive)\.google\.com\/(?:document|spreadsheets|presentation|file)\/d\/([A-Za-z0-9_-]{20,})(?:[/?#]|$)/.exec(url.trim())
  return m?.[1]
}

export function hasServiceAccountKey(keyFile = defaultKeyFile()): boolean {
  return existsSync(keyFile)
}

/** drive.google.com/drive/folders/<id> (any `/u/N/` or `/my-drive` prefix, any query) → folder id; anything else → undefined. */
export function googleFolderId(url: string): string | undefined {
  const m = /^https?:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})(?:[/?#]|$)/.exec(url.trim())
  return m?.[1]
}

export interface GoogleFolder {
  id: string
  name: string
  url: string
  /** Every readable file under the folder (subfolders included), each as text. */
  docs: (GoogleDoc & { path: string })[]
  /** Files that are not documents (images, video, …) or could not be read — `path: reason`. */
  skipped: string[]
}

/** How many files one folder link may pull in; past this, link the subfolders you want instead. */
export const FOLDER_FILE_LIMIT = 200
const FOLDER_DEPTH_LIMIT = 8
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'

interface DriveSession {
  as: string
  fetchFn: typeof fetch
  headers: Record<string, string>
}

async function driveSession(as: string, deps: GdocDeps): Promise<DriveSession> {
  const keyFile = deps.keyFile ?? defaultKeyFile()
  if (!existsSync(keyFile)) throw new Error(`no service account key at ${keyFile} — run this where the key lives, or pass the document as a file`)
  const key = JSON.parse(readFileSync(keyFile, 'utf8')) as { client_email: string; private_key: string; token_uri?: string }
  const fetchFn = deps.fetch ?? fetch
  const tokenUrl = key.token_uri ?? TOKEN_URL

  const tokenRes = await fetchFn(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(key, as, tokenUrl, deps.now?.() ?? Date.now(), DRIVE_SCOPE) }).toString(),
  })
  const token = (await tokenRes.json()) as { access_token?: string; error?: string }
  if (!token.access_token) {
    throw new Error(
      `google: token for ${as}: ${token.error ?? tokenRes.status}${
        token.error === 'unauthorized_client'
          ? ` — domain-wide delegation for the service account lacks ${DRIVE_SCOPE} (Workspace Admin → Security → API controls → Domain-wide delegation), or ${as} is not a Workspace user`
          : ''
      }`,
    )
  }
  return { as, fetchFn, headers: { Authorization: `Bearer ${token.access_token}` } }
}

export async function exportGoogleDoc(url: string, as: string, deps: GdocDeps = {}): Promise<GoogleDoc> {
  const id = googleDocId(url)
  if (!id) throw new Error(`not a Google Doc link: ${url}`)
  return exportFile(await driveSession(as, deps), id)
}

/** Whether a Drive MIME type is one `exportFile` can turn into text. */
function readableMime(mime: string): boolean {
  return Boolean(GOOGLE_EXPORTS[mime] || officeKind(mime) || mime === 'application/pdf' || TEXT_MIMES.test(mime))
}

async function exportFile(s: DriveSession, id: string): Promise<GoogleDoc> {
  const { fetchFn, headers, as } = s
  const metaRes = await fetchFn(`${DRIVE_API}/files/${id}?fields=name,mimeType,modifiedTime,owners(displayName,emailAddress)&supportsAllDrives=true`, { headers })
  if (!metaRes.ok) throw new Error(await driveError(metaRes, id, as))
  const meta = (await metaRes.json()) as { name: string; mimeType: string; modifiedTime?: string; owners?: { displayName?: string; emailAddress?: string }[] }
  const common = {
    id,
    name: meta.name,
    mimeType: meta.mimeType,
    ...(meta.modifiedTime ? { modified: meta.modifiedTime } : {}),
    ...(meta.owners?.[0]?.displayName || meta.owners?.[0]?.emailAddress ? { owner: meta.owners[0].displayName || meta.owners[0].emailAddress } : {}),
  }

  if (meta.mimeType === FOLDER_MIME) throw new Error(`google: ${meta.name} is a Drive folder — pass its drive.google.com/drive/folders/… link to read every file in it`)

  const native = GOOGLE_EXPORTS[meta.mimeType]
  if (native) {
    const exportRes = await fetchFn(`${DRIVE_API}/files/${id}/export?mimeType=${encodeURIComponent(native.mime)}`, { headers })
    if (!exportRes.ok) throw new Error(await driveError(exportRes, id, as))
    const text = await exportRes.text()
    return { ...common, markdown: native.mime === 'text/markdown' ? tidyExport(text) : text.trim(), url: `https://docs.google.com/${native.path}/d/${id}` }
  }

  const office = officeKind(meta.mimeType)
  if (office) {
    // An uploaded .docx/.pptx/.xlsx: Drive opens it under docs.google.com but cannot export it — download and read the archive.
    const dl = await fetchFn(`${DRIVE_API}/files/${id}?alt=media&supportsAllDrives=true`, { headers })
    if (!dl.ok) throw new Error(await driveError(dl, id, as))
    const text = officeText(office, new Uint8Array(await dl.arrayBuffer()))
    const path = office === 'docx' ? 'document' : office === 'pptx' ? 'presentation' : 'spreadsheets'
    return { ...common, markdown: text.trim(), url: `https://docs.google.com/${path}/d/${id}` }
  }

  const fileUrl = `https://drive.google.com/file/d/${id}`
  if (meta.mimeType === 'application/pdf' || TEXT_MIMES.test(meta.mimeType)) {
    const dl = await fetchFn(`${DRIVE_API}/files/${id}?alt=media&supportsAllDrives=true`, { headers })
    if (!dl.ok) throw new Error(await driveError(dl, id, as))
    const body = meta.mimeType === 'application/pdf' ? await pdfText(new Uint8Array(await dl.arrayBuffer())) : await dl.text()
    return { ...common, markdown: body.trim(), url: fileUrl }
  }
  throw new Error(`google: ${meta.name} is ${meta.mimeType}, not a readable document — download it and pass the file instead (Docs, Slides, Sheets, Word, PowerPoint, Excel, PDF, Markdown, and text are read from Drive directly)`)
}

interface DriveChild {
  id: string
  name: string
  mimeType: string
  shortcutDetails?: { targetId?: string; targetMimeType?: string }
}

async function listChildren(s: DriveSession, folderId: string): Promise<DriveChild[]> {
  const out: DriveChild[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType,shortcutDetails)',
      pageSize: '1000',
      orderBy: 'name',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      ...(pageToken ? { pageToken } : {}),
    })
    const res = await s.fetchFn(`${DRIVE_API}/files?${params}`, { headers: s.headers })
    if (!res.ok) throw new Error(await driveError(res, folderId, s.as))
    const page = (await res.json()) as { files?: DriveChild[]; nextPageToken?: string }
    out.push(...(page.files ?? []))
    pageToken = page.nextPageToken
  } while (pageToken)
  return out
}

/**
 * A Drive folder link → every readable file under it as text, subfolders
 * included (shortcuts followed). Files that are not documents are listed in
 * `skipped` rather than failing the folder; so is a file that fails to read.
 */
export async function exportGoogleFolder(url: string, as: string, deps: GdocDeps = {}): Promise<GoogleFolder> {
  const id = googleFolderId(url)
  if (!id) throw new Error(`not a Google Drive folder link: ${url}`)
  const s = await driveSession(as, deps)
  const metaRes = await s.fetchFn(`${DRIVE_API}/files/${id}?fields=name,mimeType&supportsAllDrives=true`, { headers: s.headers })
  if (!metaRes.ok) throw new Error(await driveError(metaRes, id, as))
  const meta = (await metaRes.json()) as { name: string; mimeType: string }
  if (meta.mimeType !== FOLDER_MIME) throw new Error(`google: ${meta.name} is not a folder (${meta.mimeType})`)

  // Walk first, read after: the file limit is checked before any content is downloaded.
  const files: { id: string; path: string }[] = []
  const skipped: string[] = []
  const seenFolders = new Set([id])
  const seenFiles = new Set<string>()
  // A folder's own files before its subfolders', so a file linked in both places keeps its shallower path.
  const walk = async (folderId: string, prefix: string, depth: number): Promise<void> => {
    const subfolders: { id: string; path: string }[] = []
    for (const child of await listChildren(s, folderId)) {
      const path = prefix ? `${prefix}/${child.name}` : child.name
      const targetId = child.mimeType === SHORTCUT_MIME ? child.shortcutDetails?.targetId : child.id
      const mime = child.mimeType === SHORTCUT_MIME ? child.shortcutDetails?.targetMimeType ?? '' : child.mimeType
      if (!targetId) continue
      if (mime === FOLDER_MIME) {
        if (seenFolders.has(targetId)) continue
        seenFolders.add(targetId)
        if (depth >= FOLDER_DEPTH_LIMIT) skipped.push(`${path}/: nested deeper than ${FOLDER_DEPTH_LIMIT} folders`)
        else subfolders.push({ id: targetId, path })
      } else if (!readableMime(mime)) {
        skipped.push(`${path}: ${mime || 'unknown type'}, not a document`)
      } else if (!seenFiles.has(targetId)) {
        seenFiles.add(targetId)
        files.push({ id: targetId, path })
      }
    }
    for (const sub of subfolders) await walk(sub.id, sub.path, depth + 1)
  }
  await walk(id, '', 1)
  if (files.length > FOLDER_FILE_LIMIT) {
    throw new Error(`google: ${meta.name} holds ${files.length} readable files (limit ${FOLDER_FILE_LIMIT}) — add its subfolders, or the files you need, one link at a time`)
  }

  const docs: GoogleFolder['docs'] = []
  for (const f of files) {
    try {
      docs.push({ ...(await exportFile(s, f.id)), path: f.path })
    } catch (err) {
      skipped.push(`${f.path}: ${err instanceof Error ? err.message.split('\n')[0] : err}`)
    }
  }
  return { id, name: meta.name, url: `https://drive.google.com/drive/folders/${id}`, docs, skipped }
}

/**
 * A Google link → text: locally when this machine holds the service
 * account key, otherwise over SSH on the lore host (which does), the same
 * way `lore refresh --trigger` reaches it.
 */
export async function resolveGoogleDoc(url: string, as: string): Promise<GoogleDoc> {
  if (hasServiceAccountKey()) return exportGoogleDoc(url, as)
  const target = sshTargetFromRemote(readGlobalConfig().remote)
  if (!target) throw new Error('no service account key here and no SSH lore host configured — export the doc as Markdown and pass the file')
  const out = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', target, `lore gdoc export ${JSON.stringify(url)} --as ${JSON.stringify(as)} --json`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return JSON.parse(out) as GoogleDoc
}

/** A Drive folder link → its documents as text: locally with the key, otherwise on the lore host over SSH. */
export async function resolveGoogleFolder(url: string, as: string): Promise<GoogleFolder> {
  if (hasServiceAccountKey()) return exportGoogleFolder(url, as)
  const target = sshTargetFromRemote(readGlobalConfig().remote)
  if (!target) throw new Error('no service account key here and no SSH lore host configured — download the folder and add its files one by one')
  const out = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', target, `lore gdoc export ${JSON.stringify(url)} --as ${JSON.stringify(as)} --json`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60_000,
    maxBuffer: 256 * 1024 * 1024,
  })
  return JSON.parse(out) as GoogleFolder
}

async function driveError(res: Response, id: string, as: string): Promise<string> {
  const body = (await res.text()).slice(0, 300)
  if (res.status === 404) return `google: document ${id} not found, or ${as} cannot see it — share it with them, or pass --as someone who can`
  if (/has not been used|is disabled/.test(body)) return `google: the Drive API is not enabled in the service account's Cloud project — enable drive.googleapis.com there`
  return `google: drive ${res.status} for ${id}: ${body}`
}

/** Drop the inline image references Docs emits and collapse blank runs. */
function tidyExport(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\[image\d+\]/g, '')
    .replace(/^\[image\d+\]: <data:[^\n]*$/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
