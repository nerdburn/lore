import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './app.css'

// Follow the OS theme as it changes (index.html sets the first one before paint).
const media = window.matchMedia('(prefers-color-scheme: dark)')
media.addEventListener('change', (e) => {
  const el = document.documentElement
  el.classList.toggle('dark', e.matches)
  el.classList.toggle('light', !e.matches)
  el.dataset.theme = e.matches ? 'dark' : 'light'
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
