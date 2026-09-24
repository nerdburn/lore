/**
 * lore asset store — a thin, authenticated front for one R2 bucket.
 *
 *   HEAD/GET /b/<sha256>     (GET honours Range)
 *   PUT      /b/<sha256>     body = the bytes
 *
 * Only the lore host talks to it, through an exe.dev http-proxy integration
 * that adds `Authorization: Bearer <LORE_ASSETS_SECRET>` — so the secret
 * lives in the integration and in this Worker, never on the VM. Objects are
 * content-addressed: a PUT is refused unless the bytes hash to the name.
 */
const SHA = /^\/b\/([a-f0-9]{64})$/

export default {
  async fetch(request, env) {
    const auth = request.headers.get('authorization') ?? ''
    if (!env.LORE_ASSETS_SECRET || !timingSafeEqual(auth, `Bearer ${env.LORE_ASSETS_SECRET}`)) return new Response('unauthorized\n', { status: 401 })
    const m = SHA.exec(new URL(request.url).pathname)
    if (!m) return new Response('not found\n', { status: 404 })
    const key = m[1]

    if (request.method === 'HEAD') {
      const head = await env.ASSETS.head(key)
      return new Response(null, { status: head ? 200 : 404, headers: head ? { 'content-length': String(head.size) } : {} })
    }
    if (request.method === 'GET') {
      const obj = await env.ASSETS.get(key, { range: request.headers, onlyIf: request.headers })
      if (!obj) return new Response('not found\n', { status: 404 })
      const headers = new Headers()
      obj.writeHttpMetadata(headers)
      headers.set('etag', obj.httpEtag)
      headers.set('accept-ranges', 'bytes')
      if (!('body' in obj)) return new Response(null, { status: 304, headers })
      if (obj.range && request.headers.has('range')) {
        const start = obj.range.offset ?? 0
        const len = obj.range.length ?? obj.size - start
        headers.set('content-range', `bytes ${start}-${start + len - 1}/${obj.size}`)
        return new Response(obj.body, { status: 206, headers })
      }
      return new Response(obj.body, { headers })
    }
    if (request.method === 'PUT') {
      if (await env.ASSETS.head(key)) return new Response(null, { status: 200 })
      const length = Number(request.headers.get('content-length'))
      if (!length || !request.body) return new Response('content-length required\n', { status: 411 })
      // Stream once: one branch into R2, the other through a digest. Nothing is buffered whole.
      const [toStore, toHash] = request.body.tee()
      const digest = new crypto.DigestStream('SHA-256')
      const fixed = new FixedLengthStream(length)
      await Promise.all([
        toHash.pipeTo(digest),
        toStore.pipeTo(fixed.writable),
        env.ASSETS.put(key, fixed.readable, { httpMetadata: { contentType: request.headers.get('content-type') ?? 'application/octet-stream' } }),
      ])
      const hex = [...new Uint8Array(await digest.digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
      if (hex !== key) {
        // The key did not exist before this request (HEAD above), so removing it loses nothing.
        await env.ASSETS.delete(key)
        return new Response('content does not match its sha256\n', { status: 400 })
      }
      return new Response(null, { status: 201 })
    }
    return new Response('method not allowed\n', { status: 405 })
  },
}

function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  if (x.length !== y.length) return false
  let d = 0
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]
  return d === 0
}
