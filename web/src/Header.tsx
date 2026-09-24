import { Button, Dropdown, Label } from '@heroui/react'
import { PersonAvatar } from './people'
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
          <a
            href={href({ name: 'host' })}
            onClick={(e) => {
              e.preventDefault()
              navigate({ name: 'host' })
            }}
            className="hidden text-sm text-muted hover:text-foreground sm:inline"
          >
            Host status
          </a>
        )}
        <Dropdown>
          <Button aria-label="Account" className="h-auto min-w-0 rounded-full border-0 bg-transparent p-0 shadow-none ring-2 ring-transparent ring-offset-2 ring-offset-background transition-[box-shadow] outline-none hover:bg-transparent hover:ring-accent/70 focus-visible:ring-accent data-[hovered=true]:bg-transparent data-[pressed=true]:scale-100">
            <PersonAvatar email={me.email} px={32} tooltip={false} />
          </Button>
          <Dropdown.Popover placement="bottom end">
            <div className="px-3 pt-3 pb-1 text-sm">
              <div className="text-muted">Signed in as</div>
              <div className="font-medium">{me.name ?? me.email}</div>
              {me.name && <div className="text-xs text-muted">{me.email}</div>}
            </div>
            <Dropdown.Menu onAction={(k) => (k === 'signout' ? onSignOut() : k === 'connect' ? navigate({ name: 'connect' }) : k === 'profile' ? navigate({ name: 'profile' }) : undefined)}>
              <Dropdown.Item id="profile" textValue="Profile">
                <Label>Profile</Label>
              </Dropdown.Item>
              <Dropdown.Item id="connect" textValue="Connect Claude Code">
                <Label>Connect Claude Code</Label>
              </Dropdown.Item>
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
