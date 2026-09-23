import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Served by `lore www` under /board. In dev, `lore www --board` runs on :8000
// and Vite proxies the API to it.
export default defineConfig({
  base: '/board/',
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: { proxy: { '/api': 'http://localhost:8000' } },
})
