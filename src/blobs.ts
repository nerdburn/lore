import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { loreHome } from './context.js'

/**
 * Where attachment bytes live — never in git. Content-addressed by sha256,
 * so the same screenshot attached twice (or imported from Jira and pasted
 * on the board) is stored once.
 *
 * Two tiers:
 * - a local cache on the host, `<LORE_HOME>/assets/<ab>/<sha>` (or
 *   LORE_ASSETS_DIR), what the board serves from;
 * - the store of record, Cloudflare R2, reached through a small Worker
 *   (deploy/r2-worker) behind an exe.dev http-proxy integration that adds
 *   the Worker's bearer secret — so no key sits on the VM. LORE_ASSETS_API
 *   is that integration's URL. Unset (a laptop, tests), the cache is the store.
 *
 * Files are only ever reached through lore (the board checks who is
 * asking); nothing here is a public URL.
 */

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

export interface BlobStore {
  /** The cache directory; temp files for `put` belong under it (same filesystem). */
  readonly dir: string
  /** Local path of the blob, fetching it from the remote tier first if needed; undefined if it exists nowhere. */
  path(sha: string): Promise<string | undefined>
  /** Store a finished temp file under its sha (moves it). Uploads to the remote tier before resolving. */
  put(tmp: string, sha: string, type: string): Promise<void>
}

export interface BlobStoreOptions {
  dir?: string
  /** The R2 Worker, through the exe.dev integration. */
  api?: string
  fetchImpl?: typeof fetch
}

const SHA_RE = /^[a-f0-9]{64}$/

export function blobStoreFromEnv(env = process.env): BlobStore {
  return createBlobStore({ dir: env.LORE_ASSETS_DIR, api: env.LORE_ASSETS_API })
}

export function createBlobStore(opts: BlobStoreOptions = {}): BlobStore {
  const dir = opts.dir ?? join(loreHome(), 'assets')
  const api = opts.api?.replace(/\/+$/, '')
  const f = opts.fetchImpl ?? fetch
  const local = (sha: string) => join(dir, sha.slice(0, 2), sha)

  return {
    dir,
    async path(sha) {
      if (!SHA_RE.test(sha)) return undefined
      const p = local(sha)
      if (existsSync(p)) return p
      if (!api) return undefined
      const res = await f(`${api}/b/${sha}`)
      if (res.status === 404) return undefined
      if (!res.ok || !res.body) throw new Error(`asset store: GET ${sha.slice(0, 12)} → ${res.status}`)
      // Verify on the way in: the cache must only ever hold what the name says.
      const got = await writeHashed(Readable.fromWeb(res.body as never), dir, Infinity)
      if (got.sha !== sha) {
        rmSync(got.tmp, { force: true })
        throw new Error(`asset store: ${sha.slice(0, 12)} came back with different content`)
      }
      settle(got.tmp, p)
      return p
    },
    async put(tmp, sha, type) {
      if (!SHA_RE.test(sha)) throw new Error('asset store: bad sha')
      const p = local(sha)
      if (api) {
        const head = await f(`${api}/b/${sha}`, { method: 'HEAD' })
        if (head.status === 404) {
          const size = statSync(tmp).size
          const res = await f(`${api}/b/${sha}`, {
            method: 'PUT',
            headers: { 'content-type': type || 'application/octet-stream', 'content-length': String(size) },
            body: Readable.toWeb(createReadStream(tmp)) as never,
            duplex: 'half',
          } as RequestInit)
          if (!res.ok) throw new Error(`asset store: PUT ${sha.slice(0, 12)} → ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`)
        } else if (!head.ok) {
          throw new Error(`asset store: HEAD ${sha.slice(0, 12)} → ${head.status}`)
        }
      }
      if (existsSync(p)) rmSync(tmp, { force: true })
      else settle(tmp, p)
    },
  }
}

/**
 * Stream bytes to a temp file under `dir`, hashing as they go, and give up
 * past `max` bytes (the temp file is removed). The caller moves the file
 * into place with the store once it knows it wants it.
 */
export async function writeHashed(input: Readable | AsyncIterable<Uint8Array>, dir: string, max = MAX_ATTACHMENT_BYTES): Promise<{ tmp: string; sha: string; size: number }> {
  mkdirSync(join(dir, 'tmp'), { recursive: true })
  const tmp = join(dir, 'tmp', `${Date.now()}-${randomBytes(6).toString('hex')}`)
  const hash = createHash('sha256')
  let size = 0
  try {
    await pipeline(
      input,
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          size += chunk.length
          if (size > max) throw new TooLarge(max)
          hash.update(chunk)
          yield chunk
        }
      },
      createWriteStream(tmp),
    )
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
  return { tmp, sha: hash.digest('hex'), size }
}

export class TooLarge extends Error {
  constructor(max: number) {
    super(`file is larger than ${Math.round(max / 1024 / 1024)} MB`)
  }
}

/** The directory temp files for a store's `put` should be written in (same filesystem, so the move is a rename). */
export function assetsDir(env = process.env): string {
  return env.LORE_ASSETS_DIR ?? join(loreHome(), 'assets')
}

function settle(tmp: string, dest: string): void {
  mkdirSync(join(dest, '..'), { recursive: true })
  renameSync(tmp, dest)
}
