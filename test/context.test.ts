import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { cachePath, resolveContext } from '../src/context.js'
import { makeContextRepo } from './helpers.js'

test('context: a context repo resolves in local mode from itself and from a subdirectory', () => {
  const root = makeContextRepo()
  const r = resolveContext(root)
  assert.equal(r.mode, 'local')
  assert.equal(r.root, root)
  assert.equal(r.config.project, 'acme')
  mkdirSync(join(root, 'context/streams/slack'), { recursive: true })
  assert.equal(resolveContext(join(root, 'context/streams/slack')).root, root)
})

test('context: --context with a filesystem path wins over cwd', () => {
  const a = makeContextRepo({}, { project: 'a' })
  const b = makeContextRepo({}, { project: 'b' })
  assert.equal(resolveContext(a, { context: b }).config.project, 'b')
})

test('context: a pointer to a local path follows it', () => {
  const target = makeContextRepo({}, { project: 'target' })
  const pointer = makeContextRepo({ 'lore.json': JSON.stringify({ context: target }) })
  const r = resolveContext(pointer)
  assert.equal(r.config.project, 'target')
  assert.equal(r.root, target)
})

test('context: a pointer to a pointer is an error', () => {
  const target = makeContextRepo({}, { project: 'target' })
  const middle = makeContextRepo({ 'lore.json': JSON.stringify({ context: target }) })
  const outer = makeContextRepo({ 'lore.json': JSON.stringify({ context: middle }) })
  assert.throws(() => resolveContext(outer), /itself a pointer/)
})

test('context: malformed pointers are rejected', () => {
  const bad = makeContextRepo({ 'lore.json': JSON.stringify({ context: 'not a repo or path' }) })
  assert.throws(() => resolveContext(bad), /must be "owner\/repo", a repo name on the configured remote, or an absolute path/)
})

test('context: no lore.json anywhere is a clear error', () => {
  const empty = makeContextRepo()
  const nested = join(empty, 'nowhere')
  mkdirSync(nested)
  writeFileSync(join(empty, 'lore.json'), '') // make it unreadable as JSON
  assert.throws(() => resolveContext(nested))
})

test('context: cache paths are namespaced by owner__repo under ~/.lore', () => {
  assert.match(cachePath('inputlogic/lore-acme'), /\.lore\/cache\/inputlogic__lore-acme$/)
})

test('context: LORE_CONTEXT env pins the context when no flag or lore.json does', () => {
  const target = makeContextRepo({}, { project: 'from-env' })
  const elsewhere = makeContextRepo({}, { project: 'cwd' })
  process.env.LORE_CONTEXT = target
  try {
    assert.equal(resolveContext(elsewhere).config.project, 'cwd', 'a lore.json in cwd wins over the env')
    assert.equal(resolveContext(elsewhere, { context: target }).config.project, 'from-env', 'an explicit flag wins over both')
    assert.equal(resolveContext('/', {}).config.project, 'from-env', 'no lore.json anywhere → env fallback')
  } finally {
    delete process.env.LORE_CONTEXT
  }
})
