/**
 * One write at a time per context, across every surface in this process.
 *
 * The hosted MCP sessions and the board both write through the host's one
 * cache clone of a context (`~/.lore/cache/<context>`), so two writers on the
 * same context must never run their pull/commit/push at once. Different
 * contexts run in parallel.
 */
const queues = new Map<string, Promise<unknown>>()

export type Serialize = <T>(fn: () => Promise<T>) => Promise<T>

export function serializeFor(context: string): Serialize {
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = queues.get(context) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    queues.set(context, next.catch(() => undefined))
    return next
  }
}
