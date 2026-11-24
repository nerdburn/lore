/**
 * A small, quiet "done" moment: the ticket glows once and a handful of
 * confetti flecks drift up from it. Plain DOM + Web Animations, no library.
 */

const COLORS = ['var(--accent)', 'oklch(0.72 0.14 150)', 'oklch(0.8 0.12 85)', 'oklch(0.7 0.1 250)']
const PIECES = 14

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** Pass the element to glow it too, or just where it was if it has already left the page. */
export function celebrate(target: Element | DOMRect | null | undefined) {
  if (!target || reducedMotion() || typeof document.body.animate !== 'function') return
  const rect = target instanceof Element ? target.getBoundingClientRect() : target
  if (rect.width === 0 && rect.height === 0) return

  if (target instanceof Element)
    target.animate(
      [
        { boxShadow: '0 0 0 0 color-mix(in oklch, var(--success, oklch(0.72 0.14 150)) 0%, transparent)', scale: '1' },
        { boxShadow: '0 0 0 4px color-mix(in oklch, var(--success, oklch(0.72 0.14 150)) 35%, transparent)', scale: '1.015', offset: 0.35 },
        { boxShadow: '0 0 0 10px color-mix(in oklch, var(--success, oklch(0.72 0.14 150)) 0%, transparent)', scale: '1' },
      ],
      { duration: 700, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    )

  const layer = document.createElement('div')
  layer.setAttribute('aria-hidden', 'true')
  Object.assign(layer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647', overflow: 'hidden' })
  document.body.appendChild(layer)

  const originX = rect.left + rect.width / 2
  const originY = rect.top + Math.min(rect.height / 2, 24)
  let remaining = PIECES

  for (let i = 0; i < PIECES; i++) {
    const piece = document.createElement('span')
    const w = 4 + Math.random() * 3
    const round = Math.random() < 0.4
    Object.assign(piece.style, {
      position: 'absolute',
      left: `${originX}px`,
      top: `${originY}px`,
      width: `${w}px`,
      height: `${round ? w : w * 1.8}px`,
      borderRadius: round ? '999px' : '1.5px',
      background: COLORS[i % COLORS.length],
    })
    layer.appendChild(piece)

    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9
    const dist = 40 + Math.random() * 50
    const dx = Math.cos(angle) * dist + (Math.random() - 0.5) * rect.width * 0.3
    const dy = Math.sin(angle) * dist
    const spin = (Math.random() - 0.5) * 540

    piece
      .animate(
        [
          { transform: 'translate(-50%, -50%) scale(0.6) rotate(0deg)', opacity: 0 },
          { transform: `translate(calc(-50% + ${dx * 0.6}px), calc(-50% + ${dy * 0.6}px)) scale(1) rotate(${spin * 0.5}deg)`, opacity: 1, offset: 0.3 },
          { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 36}px)) scale(0.9) rotate(${spin}deg)`, opacity: 0 },
        ],
        { duration: 900 + Math.random() * 400, delay: Math.random() * 60, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'forwards' },
      )
      .finished.catch(() => {})
      .finally(() => {
        if (--remaining === 0) layer.remove()
      })
  }
}

export const ticketElement = (key: string) => document.querySelector(`[data-ticket-key="${CSS.escape(key)}"]`)

/** Waits two frames so the card has rendered in its new column; `fallback` covers a row that is no longer shown. */
export function celebrateTicket(key: string, fallback?: DOMRect) {
  requestAnimationFrame(() => requestAnimationFrame(() => celebrate(ticketElement(key) ?? fallback)))
}
