import { ArrowUpRightFromSquare, FileText, Paperclip, Play } from '@gravity-ui/icons'
import { Avatar, Button, Chip, Modal, ProgressBar, Spinner, TextArea } from '@heroui/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, SOURCE_NAME, type Attachment, type Comment } from './api'
import { ago, initials } from './bits'
import { renderMarkdown } from './md'

interface Props {
  context: string
  itemKey: string
  canEdit: boolean
  onError: (err: unknown) => void
  /** Something changed that the ticket's history shows (an attachment). */
  onChanged: () => void
}

interface Pending {
  id: number
  name: string
  progress: number
}

/**
 * The ticket's files and conversation: what was attached here or on the
 * linked Jira / GitHub / Linear issue, and the board's comments merged with
 * the issue's own. Files can be added by picking, dropping, or pasting.
 */
export function TicketThread({ context, itemKey, canEdit, onError, onChanged }: Props) {
  const [comments, setComments] = useState<Comment[]>()
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [pending, setPending] = useState<Pending[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [open, setOpen] = useState<Attachment>()
  const input = useRef<HTMLInputElement>(null)
  const seq = useRef(0)
  const errors = useRef(onError)
  errors.current = onError

  const load = useCallback(async () => {
    try {
      const t = await api.thread(context, itemKey)
      setComments(t.comments)
      setAttachments(t.attachments)
    } catch (err) {
      errors.current(err)
    }
  }, [context, itemKey])

  useEffect(() => {
    setComments(undefined)
    setAttachments([])
    void load()
  }, [load])

  const uploadAll = useCallback(
    async (files: File[]) => {
      if (!canEdit || files.length === 0) return
      await Promise.all(
        files.map(async (file) => {
          const id = ++seq.current
          setPending((p) => [...p, { id, name: file.name || 'pasted image', progress: 0 }])
          try {
            await api.upload(context, itemKey, file, (progress) => setPending((p) => p.map((x) => (x.id === id ? { ...x, progress } : x))))
          } catch (err) {
            errors.current(err)
          } finally {
            setPending((p) => p.filter((x) => x.id !== id))
          }
        }),
      )
      await load()
      onChanged()
    },
    [canEdit, context, itemKey, load, onChanged],
  )

  // Paste a screenshot anywhere in the drawer (outside a text field).
  useEffect(() => {
    if (!canEdit) return
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName) && !e.clipboardData?.files.length) return
      const files = [...(e.clipboardData?.files ?? [])]
      if (files.length) {
        e.preventDefault()
        void uploadAll(files)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [canEdit, uploadAll])

  return (
    <>
      <section
        onDragOver={(e) => {
          if (!canEdit || !e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          if (!canEdit) return
          e.preventDefault()
          setDragOver(false)
          void uploadAll([...e.dataTransfer.files])
        }}
        className={`-m-2 rounded-2xl p-2 transition-colors ${dragOver ? 'bg-accent/10 ring-2 ring-accent/50' : ''}`}
      >
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            Attachments{attachments.length ? <span className="ml-1 font-normal text-muted">{attachments.length}</span> : null}
          </h3>
          {canEdit && (
            <>
              <Button size="sm" variant="ghost" onPress={() => input.current?.click()}>
                <Paperclip />
                Add files
              </Button>
              <input
                ref={input}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  void uploadAll([...(e.target.files ?? [])])
                  e.target.value = ''
                }}
              />
            </>
          )}
        </div>
        {comments === undefined ? (
          <Spinner size="sm" />
        ) : attachments.length === 0 && pending.length === 0 ? (
          <p className="text-sm text-muted">{canEdit ? 'Drop, paste, or add screenshots, videos and files here.' : 'No attachments.'}</p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {attachments.map((a) => (
              <Tile key={`${a.sha256 ?? a.name}-${a.source}`} context={context} a={a} onOpen={() => setOpen(a)} />
            ))}
            {pending.map((p) => (
              <div key={p.id} className="flex aspect-square flex-col justify-end gap-1 rounded-xl border border-dashed border-border p-2">
                <span className="truncate text-xs text-muted">{p.name}</span>
                <ProgressBar aria-label={`Uploading ${p.name}`} value={Math.round(p.progress * 100)} size="sm">
                  <ProgressBar.Track>
                    <ProgressBar.Fill />
                  </ProgressBar.Track>
                </ProgressBar>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold">
          Comments{comments?.length ? <span className="ml-1 font-normal text-muted">{comments.length}</span> : null}
        </h3>
        {comments === undefined ? (
          <Spinner size="sm" />
        ) : (
          <div className="flex flex-col gap-4">
            {comments.length === 0 && <p className="text-sm text-muted">No comments yet.</p>}
            {comments.map((c) => (
              <CommentRow key={c.id} c={c} />
            ))}
            {canEdit && <Composer context={context} itemKey={itemKey} onPosted={load} onError={(e) => errors.current(e)} />}
          </div>
        )}
      </section>

      <Viewer context={context} a={open} onClose={() => setOpen(undefined)} />
    </>
  )
}

const isImage = (t: string) => t.startsWith('image/') && t !== 'image/svg+xml' && t !== 'image/heic'
const isVideo = (t: string) => t.startsWith('video/')

function Tile({ context, a, onOpen }: { context: string; a: Attachment; onOpen: () => void }) {
  const title = `${a.name}${a.size ? ` · ${size(a.size)}` : ''} · ${a.source === 'board' ? a.by : `from ${SOURCE_NAME[a.source]}`} · ${ago(a.at)}`
  if (!a.sha256) {
    // Recorded but not imported (too large): a link to where it lives.
    return (
      <a href={a.source_url} target="_blank" rel="noreferrer" title={`${title} — ${a.skipped}`} className="flex aspect-square flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border p-2 text-center hover:bg-default">
        <ArrowUpRightFromSquare className="text-muted" />
        <span className="line-clamp-2 text-xs">{a.name}</span>
        <span className="text-[10px] text-muted">{a.skipped} · open in {SOURCE_NAME[a.source]}</span>
      </a>
    )
  }
  const url = api.fileUrl(context, a.sha256)
  const media = isImage(a.type) || isVideo(a.type)
  const body = isImage(a.type) ? (
    <img src={url} alt={a.name} loading="lazy" className="size-full object-cover" />
  ) : isVideo(a.type) ? (
    <>
      <video src={`${url}#t=0.1`} preload="metadata" muted className="size-full object-cover" />
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="rounded-full bg-black/55 p-2 text-white">
          <Play />
        </span>
      </span>
    </>
  ) : (
    <span className="flex size-full flex-col items-center justify-center gap-1 p-2 text-center">
      <FileText className="text-muted" />
      <span className="line-clamp-2 text-xs">{a.name}</span>
    </span>
  )
  const badge = a.source !== 'board' && (
    <span className="absolute top-1 left-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white">{SOURCE_NAME[a.source]}</span>
  )
  return media ? (
    <button type="button" onClick={onOpen} title={title} className="relative aspect-square overflow-hidden rounded-xl border border-separator bg-default outline-none focus-visible:ring-2 focus-visible:ring-focus">
      {body}
      {badge}
    </button>
  ) : (
    <a href={url} target="_blank" rel="noreferrer" title={title} className="relative aspect-square overflow-hidden rounded-xl border border-separator bg-default hover:bg-default/70">
      {body}
      {badge}
    </a>
  )
}

function Viewer({ context, a, onClose }: { context: string; a?: Attachment; onClose: () => void }) {
  const url = a?.sha256 ? api.fileUrl(context, a.sha256) : ''
  return (
    <Modal>
      <Modal.Backdrop isOpen={Boolean(a)} onOpenChange={(o) => !o && onClose()} variant="blur">
        <Modal.Container size="lg">
          <Modal.Dialog aria-label={a?.name ?? 'Attachment'}>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading className="truncate pr-8">{a?.name}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              {a && isImage(a.type) && <img src={url} alt={a.name} className="max-h-[70vh] w-full rounded-lg object-contain" />}
              {a && isVideo(a.type) && <video src={url} controls autoPlay className="max-h-[70vh] w-full rounded-lg bg-black" />}
              {a && (
                <p className="mt-2 text-xs text-muted">
                  {a.size ? `${size(a.size)} · ` : ''}
                  {a.source === 'board' ? `added by ${a.by}` : `from ${SOURCE_NAME[a.source]}${a.by ? ` (${a.by})` : ''}`} · {ago(a.at)} ·{' '}
                  <a className="text-link hover:underline" href={url} download={a.name}>
                    download
                  </a>
                </p>
              )}
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

function CommentRow({ c }: { c: Comment }) {
  return (
    <div className="flex gap-3">
      <Avatar size="sm" className="mt-0.5 size-7 shrink-0 text-[10px]">
        <Avatar.Fallback>{initials(c.author)}</Avatar.Fallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 text-sm">
          <span className="font-medium">{c.author}</span>
          {c.source !== 'board' && (
            <Chip size="sm" variant="soft">
              {SOURCE_NAME[c.source]}
            </Chip>
          )}
          {c.url ? (
            <a href={c.url} target="_blank" rel="noreferrer" className="text-xs text-muted hover:underline" title={c.at}>
              {ago(c.at)}
            </a>
          ) : (
            <span className="text-xs text-muted" title={c.at}>
              {ago(c.at)}
            </span>
          )}
        </div>
        <div className="prose-lore mt-1 text-sm leading-relaxed break-words" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.body) }} />
      </div>
    </div>
  )
}

function Composer({ context, itemKey, onPosted, onError }: { context: string; itemKey: string; onPosted: () => Promise<void>; onError: (err: unknown) => void }) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const post = async () => {
    if (!draft.trim() || busy) return
    setBusy(true)
    try {
      await api.comment(context, itemKey, draft)
      setDraft('')
      await onPosted()
    } catch (err) {
      onError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <TextArea
        aria-label="Add a comment"
        rows={3}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void post()
        }}
        placeholder="Add a comment — markdown works. ⌘↵ to send."
        className="w-full"
      />
      <div className="flex justify-end">
        <Button size="sm" isPending={busy} isDisabled={!draft.trim()} onPress={() => void post()}>
          Comment
        </Button>
      </div>
    </div>
  )
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
