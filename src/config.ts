import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const backfillSchema = z
  .object({ months: z.number().int().min(0).default(0) })
  .catchall(z.number().int().min(0))

export const configSchema = z.object({
  project: z.string(),
  sources: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  backfill: backfillSchema.default({ months: 0 }),
  extract: z.array(z.string()).default([]),
  report: z
    .object({ post_to: z.string(), day: z.string().default('friday') })
    .optional(),
})

export type LoreConfig = z.infer<typeof configSchema>

export const CONFIG_FILE = 'lore.json'

export function loadConfig(root: string): LoreConfig {
  const raw = readFileSync(join(root, CONFIG_FILE), 'utf8')
  return configSchema.parse(JSON.parse(raw))
}

/**
 * Resolve "env:VAR_NAME" string values against process.env.
 * Keys never live in lore.json — only references.
 */
export function resolveEnvRefs(
  obj: Record<string, unknown>,
): { resolved: Record<string, unknown>; missing: string[] } {
  const resolved: Record<string, unknown> = {}
  const missing: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && value.startsWith('env:')) {
      const name = value.slice(4)
      const env = process.env[name]
      if (env === undefined) missing.push(name)
      resolved[key] = env
    } else {
      resolved[key] = value
    }
  }
  return { resolved, missing }
}

/** Months of backfill for a source: per-source override, else global default. */
export function backfillMonths(config: LoreConfig, source: string): number {
  const override = config.backfill[source]
  return typeof override === 'number' ? override : config.backfill.months
}

export function backfillSince(config: LoreConfig, source: string, now = Date.now()): number {
  const months = backfillMonths(config, source)
  if (months === 0) return now
  const d = new Date(now)
  d.setMonth(d.getMonth() - months)
  return d.getTime()
}
