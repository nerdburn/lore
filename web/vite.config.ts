import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// `lore www` serves these .br/.gz copies itself (board/http.ts); nothing in
// front of it compresses.
function precompress(): Plugin {
  let outDir = ''
  return {
    name: 'precompress',
    apply: 'build',
    configResolved(config) {
      outDir = join(config.root, config.build.outDir, 'assets')
    },
    closeBundle() {
      for (const name of readdirSync(outDir)) {
        if (!/\.(js|css|svg|json)$/.test(name)) continue
        const raw = readFileSync(join(outDir, name))
        writeFileSync(join(outDir, `${name}.br`), brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }))
        writeFileSync(join(outDir, `${name}.gz`), gzipSync(raw, { level: 9 }))
      }
    },
  }
}

// Served by `lore www` under /board. In dev, `lore www --board` runs on :8000
// and Vite proxies the API to it.
export default defineConfig({
  base: '/board/',
  plugins: [react(), tailwindcss(), precompress()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: { proxy: { '/api': 'http://localhost:8000' } },
})
