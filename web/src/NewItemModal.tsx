import { Button, Input, Label, Modal, TextArea, TextField } from '@heroui/react'
import { useState, type FormEvent } from 'react'
import { BOARD_COLUMNS, PRIORITIES, STATUS_LABEL, UNASSIGNED, type Board, type Item, type Priority, type Status } from './api'
import { AssignToMe, ChoiceSelect, LabelPicker } from './fields'

type NewFields = Partial<Pick<Item, 'title' | 'description' | 'status' | 'priority' | 'assignee' | 'labels'>>

export function NewItemModal({ isOpen, onOpenChange, board, onCreate }: { isOpen: boolean; onOpenChange: (open: boolean) => void; board: Board; onCreate: (f: NewFields) => Promise<boolean> }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<Status>('todo')
  const [priority, setPriority] = useState<Priority>()
  const [assignee, setAssignee] = useState('')
  const [labels, setLabels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const reset = () => {
    setTitle('')
    setDescription('')
    setStatus('todo')
    setPriority(undefined)
    setAssignee('')
    setLabels([])
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
      labels,
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
                  <div className="flex items-end gap-2">
                    <ChoiceSelect
                      label="Assignee"
                      value={assignee || UNASSIGNED}
                      options={[UNASSIGNED, ...new Set([...board.assignees, board.me_assignee])]}
                      render={(a) => (a === UNASSIGNED ? 'Unassigned' : a)}
                      onChange={(a) => setAssignee(a === UNASSIGNED ? '' : a)}
                    />
                    <AssignToMe me={board.me_assignee} current={assignee} onAssign={setAssignee} />
                  </div>
                  <LabelPicker value={labels} options={board.labels} onChange={setLabels} />
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
