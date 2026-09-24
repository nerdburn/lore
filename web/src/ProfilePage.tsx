import { Button, Card, Input, Label, TextField, toast } from '@heroui/react'
import { useRef, useState } from 'react'
import { api, type Me } from './api'
import { PersonAvatar, usePeople } from './people'

/** Your name and photo, as everyone on your boards sees them. */
export function ProfilePage({ me, onChanged }: { me: Me; onChanged: (me: Me) => void }) {
  const people = usePeople()
  const [name, setName] = useState(me.name ?? '')
  const [busy, setBusy] = useState<'name' | 'photo' | 'remove'>()
  const input = useRef<HTMLInputElement>(null)

  const run = async (kind: 'name' | 'photo' | 'remove', fn: () => Promise<{ name: string | null; avatar: string | null }>, done: string) => {
    setBusy(kind)
    try {
      const p = await fn()
      onChanged({ ...me, name: p.name, avatar: p.avatar })
      people.reload()
      toast.success(done)
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Profile</h1>
      <Card className="flex flex-col gap-6 p-6">
        <div className="flex items-center gap-5">
          <PersonAvatar email={me.email} className="size-20 text-xl" size="lg" />
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <Button size="sm" isPending={busy === 'photo'} onPress={() => input.current?.click()}>
                {me.avatar ? 'Change photo' : 'Upload photo'}
              </Button>
              {me.avatar && (
                <Button size="sm" variant="secondary" isPending={busy === 'remove'} onPress={() => void run('remove', api.removeAvatar, 'Photo removed')}>
                  Remove
                </Button>
              )}
            </div>
            <p className="text-xs text-muted">Square-cropped to 256 px. PNG, JPEG, WebP or GIF.</p>
          </div>
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void run('photo', async () => api.setAvatar(await squareAvatar(file)), 'Photo updated')
            }}
          />
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void run('name', () => api.setName(name), 'Name saved')
          }}
        >
          <TextField className="flex-1" value={name} onChange={setName}>
            <Label>Display name</Label>
            <Input placeholder={me.email} maxLength={60} />
          </TextField>
          <Button type="submit" variant="secondary" isPending={busy === 'name'} isDisabled={name.trim() === (me.name ?? '')}>
            Save
          </Button>
        </form>
        <p className="text-xs text-muted">Signed in as {me.email}. Your name and photo show on every board you're on.</p>
      </Card>
    </div>
  )
}

/** Center-crop to a square and scale to 256 px, in the browser — small uploads, no originals kept. */
async function squareAvatar(file: File): Promise<Blob> {
  if (file.type === 'image/gif') return file // keep animation; the server caps size
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256)
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.9))
  if (blob && blob.type === 'image/webp') return blob
  return new Promise((r, reject) => canvas.toBlob((b) => (b ? r(b) : reject(new Error('could not read that image'))), 'image/png'))
}
