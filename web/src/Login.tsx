import { Button, Card, FieldError, Input, InputOTP, Label, Spinner, TextField } from '@heroui/react'
import { useState, type FormEvent } from 'react'
import { api, type Me } from './api'
import { Logo } from './Logo'

/** Email → 6-digit code → signed in for 90 days. */
export function Login({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState(() => localStorageGet('lore-board-email') ?? '')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function sendCode(e?: FormEvent) {
    e?.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await api.login(email.trim())
      localStorageSet('lore-board-email', email.trim())
      setStep('code')
      setCode('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function verify(value = code) {
    if (value.length !== 6) return
    setBusy(true)
    setError(undefined)
    try {
      onSignedIn(await api.verify(email.trim(), value))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm p-2">
        <Card.Header className="gap-3">
          <div className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Logo className="size-7" />
            lore <span className="font-normal text-muted">board</span>
          </div>
          <Card.Title className="pt-2 text-xl">{step === 'email' ? 'Sign in' : 'Check your email'}</Card.Title>
          <Card.Description>
            {step === 'email' ? (
              "We'll email you a 6-digit code. No password."
            ) : (
              <>
                If <span className="font-medium text-foreground">{email.trim()}</span> has access to a board, a code is on its way. It expires in 10 minutes.
              </>
            )}
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {step === 'email' ? (
            <form onSubmit={sendCode} className="flex flex-col gap-4">
              <TextField isRequired type="email" name="email" value={email} onChange={setEmail} isInvalid={Boolean(error)} autoFocus>
                <Label>Work email</Label>
                <Input placeholder="you@company.com" autoComplete="email" />
                {error && <FieldError>{error}</FieldError>}
              </TextField>
              <Button type="submit" isPending={busy} isDisabled={!email.trim()} fullWidth>
                {busy ? <Spinner color="current" size="sm" /> : null}
                Email me a code
              </Button>
            </form>
          ) : (
            <div className="flex flex-col gap-4">
              <InputOTP maxLength={6} value={code} onChange={setCode} onComplete={(v) => void verify(v)} isInvalid={Boolean(error)} isDisabled={busy} autoFocus>
                <InputOTP.Group>
                  <InputOTP.Slot index={0} />
                  <InputOTP.Slot index={1} />
                  <InputOTP.Slot index={2} />
                </InputOTP.Group>
                <InputOTP.Separator />
                <InputOTP.Group>
                  <InputOTP.Slot index={3} />
                  <InputOTP.Slot index={4} />
                  <InputOTP.Slot index={5} />
                </InputOTP.Group>
              </InputOTP>
              {error && <p className="text-sm text-danger">{error}</p>}
              <Button onPress={() => void verify()} isPending={busy} isDisabled={code.length !== 6} fullWidth>
                {busy ? <Spinner color="current" size="sm" /> : null}
                Sign in
              </Button>
              <div className="flex justify-between text-sm">
                <button type="button" className="text-muted hover:text-foreground" onClick={() => (setStep('email'), setError(undefined))}>
                  Use another email
                </button>
                <button type="button" className="text-muted hover:text-foreground disabled:opacity-50" disabled={busy} onClick={() => void sendCode()}>
                  Send a new code
                </button>
              </div>
            </div>
          )}
        </Card.Content>
      </Card>
    </div>
  )
}

function localStorageGet(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

function localStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode */
  }
}
