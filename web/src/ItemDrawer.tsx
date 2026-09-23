import { ArrowUpRightFromSquare } from '@gravity-ui/icons'
import { Button, Drawer, Input, Label, Spinner, TextArea, TextField } from '@heroui/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, PRIORITIES, STATUS_LABEL, WORK_ORDER, type Board, type HistoryEntry, type Item, type Priority, type Status } from './api'
import { ago, StatusChip } from './bits'
import { ChoiceSelect, splitLabels } from './fields'
import { renderMarkdown } from './md'

interface Props {
  context: string
  itemKey?: string
  board: Board
  canEdit: boolean
  onClose: () => void
  onChanged: () => Promise<void> | void
  onError: (err: unknown) => void
}

/** The ticket, Jira-style: fields you can change in place, the description, and every move with who and why. */
export function ItemDrawer({ context, itemKey, board, canEdit, onClose, onChanged, onError }: Props) {
  const [item, setItem] = useState<Item>()
  const [saving, setSaving] = useState(false)

  // The parent re-renders on every poll; keep its callbacks out of the
  // effect's deps so a refresh never resets an edit in progress.
  const parent = useRef({ onError, onClose })
  parent.current = { onError, onClose }

  const refresh = useCallback(async () => {
    if (!itemKey) return
    try {
      setItem((await api.item(context, itemKey)).item)
    } catch (err) {
      parent.current.onError(err)
      parent.current.onClose()
    }
  }, [context, itemKey])

  useEffect(() => {
    setItem(undefined)
    void refresh()
  }, [refresh])

  const save = async (send: () => Promise<unknown>) => {
    setSaving(true)
    try {
      await send()
      await Promise.all([refresh(), onChanged()])
    } catch (err) {
      onError(err)
      await refresh()
    } finally {
      setSaving(false)
    }
  }

  const update = (fields: Parameters<typeof api.update>[2]) => save(() => api.update(context, item!.key, fields))
  const moveTo = (status: Status) => status !== item?.status && save(() => api.move(context, item!.key, { status }))

  return (
    <Drawer>
      <Drawer.Backdrop isOpen={Boolean(itemKey)} onOpenChange={(open) => !open && onClose()}>
        <Drawer.Content placement="right">
          <Drawer.Dialog aria-label={item ? `${item.key} ${item.title}` : 'Ticket'} className="w-full max-w-full sm:w-[36rem]">
            <Drawer.CloseTrigger />
            {!item ? (
              <div className="flex flex-1 items-center justify-center">
                <Spinner />
              </div>
            ) : (
              <>
                <Drawer.Header className="gap-2">
                  <div className="flex items-center gap-2 text-sm text-muted">
                    <span className="mono">{item.key}</span>
                    {item.external && (
                      <a href={item.external.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
                        {item.external.system === 'jira' ? 'Jira' : 'GitHub'} {item.external.key} · {item.external.status}
                        <ArrowUpRightFromSquare className="size-3" />
                      </a>
                    )}
                    {saving && <Spinner size="sm" />}
                  </div>
                  <Drawer.Heading className="sr-only">{item.title}</Drawer.Heading>
                  {canEdit ? (
                    <EditableTitle key={item.title} value={item.title} onSave={(title) => update({ title })} />
                  ) : (
                    <h2 className="text-xl font-semibold tracking-tight">{item.title}</h2>
                  )}
                </Drawer.Header>
                <Drawer.Body className="flex flex-col gap-6">
                  <div className="grid grid-cols-2 gap-3">
                    {canEdit ? (
                      <>
                        <ChoiceSelect label="Status" value={item.status} options={WORK_ORDER} render={(s) => STATUS_LABEL[s]} onChange={(s) => void moveTo(s)} isDisabled={saving} />
                        <ChoiceSelect label="Priority" value={item.priority} options={PRIORITIES} render={(p) => p} onChange={(p: Priority) => void update({ priority: p })} isDisabled={saving} />
                        <InlineText key={`a-${item.assignee}`} label="Assignee" value={item.assignee ?? ''} placeholder="Unassigned" onSave={(assignee) => update({ assignee })} />
                        <InlineText key={`l-${item.labels.join()}`} label="Labels" value={item.labels.join(', ')} placeholder="comma, separated" onSave={(l) => update({ labels: splitLabels(l) })} />
                      </>
                    ) : (
                      <>
                        <Field label="Status">
                          <StatusChip status={item.status} />
                        </Field>
                        <Field label="Priority">{item.priority ?? '—'}</Field>
                        <Field label="Assignee">{item.assignee ?? '—'}</Field>
                        <Field label="Labels">{item.labels.join(', ') || '—'}</Field>
                      </>
                    )}
                  </div>

                  <Description key={item.description ?? ''} value={item.description ?? ''} canEdit={canEdit} saving={saving} onSave={(description) => update({ description })} />

                  {item.sources.length > 0 && (
                    <section>
                      <h3 className="mb-2 text-sm font-semibold">Evidence</h3>
                      <ul className="flex flex-col gap-1 text-sm">
                        {item.sources.map((s) => (
                          <li key={s} className="truncate">
                            <a href={s} target="_blank" rel="noreferrer" className="text-link hover:underline">
                              {prettySource(s)}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  <section>
                    <h3 className="mb-3 text-sm font-semibold">Activity</h3>
                    <ol className="flex flex-col gap-3 border-l border-separator pl-4">
                      {[...(item.history ?? [])].reverse().map((h, n) => (
                        <HistoryRow key={`${h.at}-${n}`} h={h} />
                      ))}
                    </ol>
                  </section>
                  {board.role === 'viewer' && <p className="text-xs text-muted">You have view-only access to this board.</p>}
                </Drawer.Body>
              </>
            )}
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      <div className="text-sm">{children}</div>
    </div>
  )
}

function EditableTitle({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  const commit = () => {
    const v = draft.trim()
    if (v && v !== value) onSave(v)
    else setDraft(value)
  }
  return (
    <TextField aria-label="Title" value={draft} onChange={setDraft} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}>
      <Input className="w-full border-transparent bg-transparent px-1 text-xl font-semibold tracking-tight shadow-none hover:bg-default focus:bg-field" />
    </TextField>
  )
}

function InlineText({ label, value, placeholder, onSave }: { label: string; value: string; placeholder?: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  const commit = () => draft.trim() !== value.trim() && onSave(draft.trim())
  return (
    <TextField value={draft} onChange={setDraft} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}>
      <Label>{label}</Label>
      <Input placeholder={placeholder} />
    </TextField>
  )
}

function Description({ value, canEdit, saving, onSave }: { value: string; canEdit: boolean; saving: boolean; onSave: (v: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Description</h3>
        {canEdit && !editing && (
          <Button size="sm" variant="ghost" onPress={() => setEditing(true)}>
            {value ? 'Edit' : 'Add'}
          </Button>
        )}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <TextArea aria-label="Description" rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="What is this ticket? Markdown works." autoFocus className="w-full" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onPress={() => (setDraft(value), setEditing(false))}>
              Cancel
            </Button>
            <Button
              size="sm"
              isPending={saving}
              onPress={async () => {
                if (draft.trim() !== value.trim()) await onSave(draft)
                setEditing(false)
              }}
            >
              Save
            </Button>
          </div>
        </div>
      ) : value ? (
        <div className="prose-lore text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }} />
      ) : (
        <p className="text-sm text-muted">No description.</p>
      )}
    </section>
  )
}

const VIA: Record<HistoryEntry['via'], string> = { cli: 'CLI', mcp: 'agent', web: 'board', sync: 'tracker sync', fold: 'lore (inferred)' }

function HistoryRow({ h }: { h: HistoryEntry }) {
  return (
    <li className="relative text-sm">
      <span className="absolute top-1.5 -left-[21px] size-2 rounded-full bg-border" />
      <div>
        <span className="font-medium">{h.by}</span> <span className="text-muted">{describeChange(h.change)}</span>
      </div>
      <div className="text-muted">{h.reason}</div>
      <div className="text-xs text-muted" title={h.at}>
        {ago(h.at)} · via {VIA[h.via] ?? h.via}
        {h.confidence ? ` · ${h.confidence} confidence` : ''}
      </div>
    </li>
  )
}

function describeChange(change: Record<string, unknown>): string {
  if (change.created) return 'created this ticket'
  const parts = Object.entries(change).map(([field, v]) => {
    if (!Array.isArray(v)) return field
    const [from, to] = v as [unknown, unknown]
    const show = (x: unknown) => (x === null || x === undefined || x === '' ? '—' : Array.isArray(x) ? x.join(', ') || '—' : field === 'status' ? (STATUS_LABEL[x as Status] ?? String(x)) : String(x))
    if (field === 'description') return 'edited the description'
    if (field === 'rank') return `ranked ${from} → ${to}`
    if (field === 'sources') return 'added evidence'
    return `${field.replace('_', ' ')} ${show(from)} → ${show(to)}`
  })
  return parts.join(', ')
}

function prettySource(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.length > 1 ? u.pathname : ''}`
  } catch {
    return url
  }
}
