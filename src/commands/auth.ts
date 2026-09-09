import { defaultAuthFile, deviceFlow } from '../granola-auth.js'

/**
 * `lore auth <source>` — obtain a long-lived grant for a source that needs
 * OAuth. Only granola today. Run it on the machine that syncs (the VM): the
 * token file is written there and refreshed in place.
 */
export async function auth(source: string, opts: { file?: string }): Promise<void> {
  if (source !== 'granola') throw new Error(`lore auth: unknown source "${source}" (supported: granola)`)
  const path = opts.file ?? defaultAuthFile()
  await deviceFlow(path, {
    prompt: (uri, code, expiresIn) => {
      console.log(`\nOpen this URL in any browser, signed in to Granola as the account whose meetings lore should read:\n\n  ${uri}\n\nCode: ${code}   (expires in ${Math.round(expiresIn / 60)} min)\n\nWaiting for approval…`)
    },
  })
  console.log(`✓ granola authorised — tokens saved to ${path} (refreshes automatically)`)
}
