import { Avatar, Button, Dropdown, Label } from '@heroui/react'
import type { Me } from './api'
import { Logo } from './Logo'
import { href, navigate } from './router'

export function Header({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  return (
    <header className="sticky top-0 z-20 border-b border-separator bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-4">
        <a
          href={href({ name: 'projects' })}
          onClick={(e) => {
            e.preventDefault()
            navigate({ name: 'projects' })
          }}
          className="flex items-center gap-2 font-semibold tracking-tight"
        >
          <Logo />
          <span>lore</span>
          <span className="font-normal text-muted">board</span>
        </a>
        <div className="flex-1" />
        {me.admin && (
          <a href="/" className="hidden text-sm text-muted hover:text-foreground sm:inline">
            Host status
          </a>
        )}
        <Dropdown>
          <Button variant="ghost" size="sm" aria-label="Account">
            <Avatar size="sm">
              <Avatar.Fallback>{me.email.slice(0, 2).toUpperCase()}</Avatar.Fallback>
            </Avatar>
          </Button>
          <Dropdown.Popover placement="bottom end">
            <div className="px-3 pt-3 pb-1 text-sm">
              <div className="text-muted">Signed in as</div>
              <div className="font-medium">{me.email}</div>
            </div>
            <Dropdown.Menu onAction={(k) => k === 'signout' && onSignOut()}>
              <Dropdown.Item id="signout" textValue="Sign out">
                <Label>Sign out</Label>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>
    </header>
  )
}
