import { existsSync, readFileSync } from 'node:fs'
import { defaultKeyFile, signJwt } from './connectors/gmail.js'

/**
 * Google Docs as SOW input. A pasted docs.google.com link is resolved on a
 * machine holding the Workspace service-account key (the same one the Gmail
 * connector uses — domain-wide delegation must include `drive.readonly`):
 * the account acts as a teammate (`as`, default `client.owner`) and asks the
 * Drive API to export the document as Markdown. Contracts are never made
 * link-shareable for this; the account only sees what that teammate can.
 */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

export interface GoogleDoc {
  id: string
  name: string
  markdown: string
  url: string
}

export interface GdocDeps {
  fetch?: typeof fetch
  keyFile?: string
  now?: () => number
}

/** docs.google.com/document/d/<id>/… or drive.google.com/file/d/<id>/… → id; anything else → undefined. */
export function googleDocId(url: string): string | undefined {
  const m = /^https?:\/\/(?:docs|drive)\.google\.com\/(?:document|file)\/d\/([A-Za-z0-9_-]{20,})(?:[/?#]|$)/.exec(url.trim())
  return m?.[1]
}

export function hasServiceAccountKey(keyFile = defaultKeyFile()): boolean {
  return existsSync(keyFile)
}

export async function exportGoogleDoc(url: string, as: string, deps: GdocDeps = {}): Promise<GoogleDoc> {
  const id = googleDocId(url)
  if (!id) throw new Error(`not a Google Doc link: ${url}`)
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
  const headers = { Authorization: `Bearer ${token.access_token}` }

  const metaRes = await fetchFn(`${DRIVE_API}/files/${id}?fields=name,mimeType&supportsAllDrives=true`, { headers })
  if (!metaRes.ok) throw new Error(await driveError(metaRes, id, as))
  const meta = (await metaRes.json()) as { name: string; mimeType: string }
  if (meta.mimeType !== 'application/vnd.google-apps.document') {
    throw new Error(`google: ${meta.name} is ${meta.mimeType}, not a Google Doc — download it and pass the file instead`)
  }

  const exportRes = await fetchFn(`${DRIVE_API}/files/${id}/export?mimeType=text/markdown`, { headers })
  if (!exportRes.ok) throw new Error(await driveError(exportRes, id, as))
  return { id, name: meta.name, markdown: tidyExport(await exportRes.text()), url: `https://docs.google.com/document/d/${id}` }
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
