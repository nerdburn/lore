import { Card, Spinner } from '@heroui/react'
import { useEffect, useState } from 'react'
import { api, type Me } from './api'
import { href, navigate } from './router'

/** How the board works — and, for host admins, the client onboarding playbook. */
export function HelpPage({ me }: { me: Me }) {
  const [playbook, setPlaybook] = useState<string | null>()
  useEffect(() => {
    api.help().then((r) => setPlaybook(r.playbook), () => setPlaybook(null))
  }, [])
  const link = (to: Parameters<typeof navigate>[0], label: string) => (
    <a
      href={href(to)}
      onClick={(e) => {
        e.preventDefault()
        navigate(to)
      }}
      className="text-link hover:underline"
    >
      {label}
    </a>
  )
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Help</h1>

      <Card className="p-6">
        <div className="prose-lore host-playbook max-w-[70ch]">
          <h2 style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>Using the board</h2>
          <p>Each project's tickets live in lore — the tracker of record — and every change here is saved with who made it and when, alongside moves from Jira, GitHub, Linear and the team's agents.</p>
          <ul>
            <li>
              <strong>Board and List.</strong> Drag a card between columns to change its status, or within a column to reorder it. The list sorts by any column. Search and the label/assignee filters are part of the page
              address, so a filtered view can be bookmarked.
            </li>
            <li>
              <strong>A ticket.</strong> Click a card to open it: change status, priority, assignee and labels in place; write a description (markdown works); see its full history.
            </li>
            <li>
              <strong>Files.</strong> Drop, paste or pick screenshots, videos and documents onto a ticket. Files on the linked Jira, GitHub or Linear issue appear here too.
            </li>
            <li>
              <strong>Comments.</strong> One thread per ticket — comments made here together with the linked issue's own. Comments made here stay in lore.
            </li>
            <li>
              <strong>Your profile.</strong> Set your name and photo under {link({ name: 'profile' }, 'Profile')}.
            </li>
            <li>
              <strong>Claude Code.</strong> Give your own Claude Code the project's memory: {link({ name: 'connect' }, 'Connect Claude Code')} has the command for each project you can open.
            </li>
          </ul>
          <p>
            Viewers can see everything but change nothing; members can do all of the above. Access is per project — ask your project lead to add you. Signed in as {me.email}.
          </p>
        </div>
      </Card>

      {playbook === undefined ? (
        me.admin ? <Spinner /> : null
      ) : playbook ? (
        <Card className="p-6">
          <div className="prose-lore host-playbook max-w-[75ch]" dangerouslySetInnerHTML={{ __html: playbook }} />
        </Card>
      ) : null}
    </div>
  )
}
