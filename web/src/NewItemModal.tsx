import { Button, Input, Label, Modal, TextArea, TextField } from '@heroui/react'
import { useState, type FormEvent } from 'react'
import { BOARD_COLUMNS, PRIORITIES, STATUS_LABEL, type Board, type Item, type Priority, type Status } from './api'
import { ChoiceSelect, splitLabels } from './fields'

type NewFields = Partial<Pick<Item, 'title' | 'description' | 'status' | 'priority' | 'assignee' | 'labels'>>

export function NewItemModal({ isOpen, onOpenChange, board, onCreate }: { isOpen: boolean; onOpenChange: (open: boolean) => void; board: Board; onCreate: (f: NewFields) => Promise<boolean> }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<Status>('todo')
  const [priority, setPriority] = useState<Priority>()
  const [assignee, setAssignee] = useState('')
  const [labels, setLabels] = useState('')
  const [busy, setBusy] = useState(false)

  const reset = () => {
    setTitle('')
    setDescription('')
    setStatus('todo')
    setPriority(undefined)
    setAssignee('')
    setLabels('')
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    if (!title.trim()) return
    setBusy(true)
    const ok = await onCreate({
      title: title.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      status,
      ...(priority ? { priority } : {}),
      ...(assignee.trim() ? { assignee: assignee.trim() } : {}),
      labels: splitLabels(labels),
    })
    setBusy(false)
    if (ok) {
      reset()
      onOpenChange(false)
    }
  }

  return (
    <Modal>
      <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
        <Modal.Container size="lg">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>New ticket</Modal.Heading>
            </Modal.Header>
            <form onSubmit={submit}>
              <Modal.Body className="flex flex-col gap-4">
                <TextField isRequired value={title} onChange={setTitle} autoFocus>
                  <Label>Title</Label>
                  <Input placeholder="What needs doing" />
                </TextField>
                <TextField>
                  <Label>Description</Label>
                  <TextArea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Markdown works" />
                </TextField>
                <div className="grid grid-cols-2 gap-3">
                  <ChoiceSelect label="Status" value={status} options={BOARD_COLUMNS} render={(s) => STATUS_LABEL[s]} onChange={setStatus} />
                  <ChoiceSelect label="Priority" value={priority} options={PRIORITIES} render={(p) => p} onChange={setPriority} />
                  <TextField value={assignee} onChange={setAssignee}>
                    <Label>Assignee</Label>
                    <Input placeholder="Unassigned" list="lore-assignees" />
                  </TextField>
                  <TextField value={labels} onChange={setLabels}>
                    <Label>Labels</Label>
                    <Input placeholder={board.labels.slice(0, 2).join(', ') || 'comma, separated'} />
                  </TextField>
                  <datalist id="lore-assignees">
                    {board.assignees.map((a) => (
                      <option key={a} value={a} />
                    ))}
                  </datalist>
                </div>
              </Modal.Body>
              <Modal.Footer>
                <Button slot="close" variant="secondary">
                  Cancel
                </Button>
                <Button type="submit" isPending={busy} isDisabled={!title.trim()}>
                  Create {board.prefix}-…
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
