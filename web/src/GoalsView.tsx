import { Button, Chip, Input, Label, Spinner, TextArea, TextField, toast } from '@heroui/react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, type Goal, type GoalFields, type GoalsPage, type GoalStatus, type Item } from './api'
import { ChoiceSelect } from './fields'
import { href, NO_FILTERS } from './router'

const statuses: Record<GoalStatus, string> = { planned: 'Planned', in_progress: 'In progress', done: 'Achieved', retired: 'Retired' }
const priorities = { '': 'Unspecified', P1: 'High', P2: 'Medium', P3: 'Low' }

function timingLabel(value: string): string {
  if (value === 'long_term') return 'Long term'
  if (value === 'short_term') return 'Short term'
  if (value === 'unspecified') return 'Timing open'
  const [year, part] = value.split('-')
  if (!part) return year
  if (part.startsWith('Q')) return `${part} ${year}`
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}-01T00:00:00Z`))
}

function periodOptions(current: string) {
  const today = new Date()
  const latest = new Date(today)
  latest.setUTCFullYear(latest.getUTCFullYear() + 1)
  const periods = new Set(['unspecified', 'long_term', String(today.getUTCFullYear())])
  for (let offset = 0; offset <= 12; offset++) {
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + offset + 1, 0))
    if (end > latest) break
    periods.add(end.toISOString().slice(0, 7))
    if (end.getUTCMonth() % 3 === 2) periods.add(`${end.getUTCFullYear()}-Q${(end.getUTCMonth() + 1) / 3}`)
  }
  periods.add(current)
  return [...periods]
}

function GoalEditor({ goal, managed, context, onCancel, onSaved, onConflict }: {
  goal?: Goal; managed: boolean; context: string; onCancel: () => void; onSaved: (goal: Goal) => void; onConflict: () => void
}) {
  const [draft, setDraft] = useState<GoalFields>(() => ({
    item: goal?.item ?? '', why: goal?.why ?? '', success: goal?.success ?? '', priority_reason: goal?.priority_reason ?? '',
    timing: goal?.timeframe?.period ?? goal?.horizon ?? 'unspecified', priority: goal?.priority ?? '',
    status: goal?.status ?? 'planned', source: goal?.source ?? '', revision: goal?.revision ?? null,
  }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  function field<K extends keyof GoalFields>(name: K, value: GoalFields[K]) { setDraft(d => ({ ...d, [name]: value })) }
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || conflict || !draft.item.trim()) return
    setBusy(true)
    setError('')
    try {
      const { goal: saved } = await api.saveGoal(context, goal?.id, draft)
      onSaved({ ...saved, requests: goal?.requests })
      toast.success('Goal saved')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the goal.')
      setConflict(err instanceof ApiError && err.status === 409)
    } finally { setBusy(false) }
  }
  return (
    <form onSubmit={submit} className="max-w-3xl space-y-5 rounded-xl border border-border bg-surface p-5 sm:p-7">
      <h2 className="text-xl font-semibold">{goal ? 'Edit goal' : 'New goal'}</h2>
      <TextField autoFocus isRequired value={draft.item} onChange={v => field('item', v)}>
        <Label>Outcome</Label><TextArea rows={2} maxLength={5000} placeholder="What should change for the client?" />
      </TextField>
      <div className="grid gap-3 sm:grid-cols-3">
        <ChoiceSelect label="Target period" value={draft.timing} options={periodOptions(draft.timing)} render={timingLabel} onChange={v => field('timing', v)} />
        <ChoiceSelect label="Priority" value={draft.priority || 'unset'} options={['unset', 'P1', 'P2', 'P3'] as const}
          render={v => priorities[v === 'unset' ? '' : v]} onChange={v => field('priority', v === 'unset' ? '' : v)} />
        <ChoiceSelect label="Status" value={draft.status} options={Object.keys(statuses) as GoalStatus[]} render={v => statuses[v]} onChange={v => field('status', v)} />
      </div>
      {([['why', 'Why it matters'], ['success', 'How we’ll measure success'], ['priority_reason', 'What should take priority']] as const).map(([name, label]) => (
        <TextField key={name} value={draft[name]} onChange={v => field(name, v)}>
          <Label>{label}</Label><TextArea rows={2} maxLength={5000} />
        </TextField>
      ))}
      <TextField value={draft.source} onChange={v => field('source', v)}>
        <Label>Meeting notes or source link</Label><Input maxLength={2000} placeholder="https://" />
      </TextField>
      {!managed && <p className="text-sm text-muted">Saving keeps the current roadmap and gives your team control of future goal changes.</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" isPending={busy} isDisabled={busy || conflict || !draft.item.trim()}>Save goal</Button>
        <Button type="button" variant="secondary" isDisabled={busy} onPress={conflict ? onConflict : onCancel}>{conflict ? 'Reload goals' : 'Cancel'}</Button>
      </div>
    </form>
  )
}

export function GoalsView({ context, items, editor, setEditor, onOpen, onError }: {
  context: string; items: Item[]; editor?: { goal?: Goal }; setEditor: (editor?: { goal?: Goal }) => void
  onOpen: (key: string) => void; onError: (err: unknown) => void
}) {
  const [page, setPage] = useState<GoalsPage>()
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    setError('')
    try { setPage(await api.goals(context)) }
    catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load goals.')
      if (err instanceof ApiError && err.status === 401) onError(err)
    }
  }, [context, onError])
  useEffect(() => { void load() }, [load])
  if (error) return <div role="alert" className="space-y-3 py-6"><p>{error}</p><Button variant="secondary" onPress={() => void load()}>Retry</Button></div>
  if (!page) return <div className="flex justify-center p-12"><Spinner aria-label="Loading goals" /></div>
  if (editor) return <GoalEditor goal={editor.goal} managed={page.managed} context={context} onCancel={() => setEditor(undefined)}
    onConflict={() => { setEditor(undefined); void load() }}
    onSaved={goal => {
      setPage({ ...page, managed: true, goals: editor.goal ? page.goals.map(g => g.id === goal.id ? goal : g) : [...page.goals, goal] })
      setEditor(undefined)
    }} />

  const active = page.goals.filter(g => g.status !== 'retired' && g.status !== 'done').sort((a, b) => (a.priority || 'Z').localeCompare(b.priority || 'Z'))
  const past = page.goals.filter(g => g.status === 'retired' || g.status === 'done')
  function row(goal: Goal) {
    const ticketKeys = new Set(goal.requests?.map(r => r.ticket))
    const tickets = items.filter(i => i.status !== 'archived' && (goal.work_items?.includes(i.key) || ticketKeys.has(i.key)))
    const intake = goal.requests?.filter(r => !r.ticket && (!r.status || r.status === 'open')) ?? []
    return (
      <article key={goal.id} className="grid gap-x-8 gap-y-3 border-t border-separator py-5 sm:grid-cols-[9rem_minmax(0,1fr)_auto]">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 sm:flex-col">
          <span className="font-medium">{timingLabel(goal.timeframe?.period ?? goal.horizon ?? 'unspecified')}</span>
          {goal.priority && <span className="text-sm text-muted">{priorities[goal.priority]} priority</span>}
        </div>
        <div className="min-w-0 max-w-prose space-y-2">
          <Chip size="sm" variant="soft" color={goal.status === 'in_progress' ? 'accent' : 'default'}>{statuses[goal.status] ?? goal.status}</Chip>
          <h3 className="whitespace-pre-line break-words text-lg font-semibold">{goal.item}</h3>
          {goal.why && <p className="whitespace-pre-line break-words">{goal.why}</p>}
          {goal.success && <p className="whitespace-pre-line break-words text-sm"><strong>Success</strong> · {goal.success}</p>}
          {goal.priority_reason && <p className="whitespace-pre-line break-words text-sm"><strong>Priority guidance</strong> · {goal.priority_reason}</p>}
          {(tickets.length + intake.length > 0) && <details className="text-sm">
            <summary className="cursor-pointer text-link">Related work ({tickets.length + intake.length})</summary>
            <ul className="mt-2 space-y-1">
              {tickets.map(i => <li key={i.key}><button className="text-left text-link hover:underline" onClick={() => onOpen(i.key)}>{i.title} [{i.key}]</button></li>)}
              {intake.map(r => <li key={r.id}><a className="text-link hover:underline" href={href({ name: 'board', context, view: 'requests', filters: { ...NO_FILTERS, q: r.id } })}>{r.request} [{r.id}]</a></li>)}
            </ul>
          </details>}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
            {goal.source && /^https?:\/\//i.test(goal.source) && <a className="text-link hover:underline" href={goal.source} target="_blank" rel="noreferrer">Source notes</a>}
            {goal.edited_by && <span>Edited by {goal.edited_by}{goal.edited_at && ` · ${goal.edited_at.slice(0, 10)}`}</span>}
          </div>
        </div>
        {page?.canEdit && <Button size="sm" variant="ghost" aria-label={`Edit goal: ${goal.item}`} className="justify-self-start" onPress={() => setEditor({ goal })}>Edit</Button>}
      </article>
    )
  }

  return (
    <section className="max-w-5xl py-3">
      <h2 className="mb-5 text-xl font-semibold">Project goals</h2>
      {active.length ? active.map(row) : <p className="border-t border-separator py-6 text-muted">No active goals yet.{page.canEdit && ' Add an outcome from your next planning meeting.'}</p>}
      {past.length > 0 && <details className="border-t border-separator pt-4">
        <summary className="mb-3 cursor-pointer font-medium">Past goals ({past.length})</summary>
        {past.map(row)}
      </details>}
    </section>
  )
}
