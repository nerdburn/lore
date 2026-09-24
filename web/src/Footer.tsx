import { href, navigate } from './router'

export function Footer() {
  return (
    <footer className="mt-12 border-t border-separator">
      <div className="mx-auto flex h-12 max-w-[1400px] items-center justify-between px-4 text-xs text-muted">
        <span>lore · project memory</span>
        <a
          href={href({ name: 'help' })}
          onClick={(e) => {
            e.preventDefault()
            navigate({ name: 'help' })
          }}
          className="hover:text-foreground"
        >
          Help
        </a>
      </div>
    </footer>
  )
}
