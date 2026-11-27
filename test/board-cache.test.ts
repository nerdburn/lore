import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BoardSnapshots } from '../src/board/snapshots.js'
import { parseWorkItems, summarizeForRecall } from '../src/work.js'
import { cachedBoardFile } from '../src/board/cache.js'
import { bareProject, bareWorkItems, boardRole } from '../src/board/access.js'

test('board cache reuses unchanged blobs and immediately observes ticket and permission changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-board-cache-'))
  const dir = join(root, 'project.git')
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  const commit = () => {
    git('add', '-A')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'update')
  }
  try {
    execFileSync('git', ['init', '--quiet', dir])
    writeFileSync(join(dir, 'data.json'), '{"value":1}')
    const config = { project: 'test', sources: {}, board: { enabled: true, members: ['test@example.com'], viewers: [] } }
    writeFileSync(join(dir, 'lore.json'), JSON.stringify(config))
    commit()
    let parses = 0
    const parse = (raw: string) => { parses++; return JSON.parse(raw) }
    const read = () => cachedBoardFile(dir, 'data.json', parse)
    const first = read()
    assert.equal(read(), first)
    assert.equal(parses, 1)
    const project = bareProject(root, 'project')!
    assert.equal(boardRole(project.config, 'test@example.com'), 'member')
    assert.deepEqual(bareWorkItems(root, project).items, [])

    // An unrelated commit must not trigger another parse.
    writeFileSync(join(dir, 'other'), 'unrelated')
    commit()
    assert.equal(read(), first)
    assert.equal(parses, 1)

    writeFileSync(join(dir, 'data.json'), '{"value":2}')
    mkdirSync(join(dir, 'context/work/lore'), { recursive: true })
    writeFileSync(join(dir, 'context/work/lore/TES.yaml'), '- key: TES-1\n  title: First ticket\n  status: todo\n')
    config.board.members = []
    writeFileSync(join(dir, 'lore.json'), JSON.stringify(config))
    commit()
    assert.deepEqual(read(), { value: 2 })
    assert.equal(parses, 2)
    assert.equal(boardRole(bareProject(root, 'project')!.config, 'test@example.com'), undefined)
    const items = bareWorkItems(root, project).items
    assert.equal(items[0].title, 'First ticket')
    assert.equal(bareWorkItems(root, project).items, items)

    git('rm', '--quiet', 'data.json', 'lore.json', 'context/work/lore/TES.yaml')
    commit()
    assert.throws(read)
    assert.equal(bareProject(root, 'project'), undefined)
    assert.deepEqual(bareWorkItems(root, project).items, [])

    // Restoring an older revision must work without a stale failed entry.
    git('reset', '--hard', 'HEAD~2')
    assert.deepEqual(read(), { value: 1 })
    assert.equal(parses, 3)
    assert.equal(boardRole(bareProject(root, 'project')!.config, 'test@example.com'), 'member')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('board snapshots persist independently of the server and follow direct Git changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-snapshots-'))
  const dir = join(root, 'project.git')
  const cache = join(root, 'cache')
  const tracker = 'context/work/lore/TES.yaml'
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  const commit = () => {
    git('add', '-A')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'update')
  }
  try {
    execFileSync('git', ['init', '--quiet', dir])
    mkdirSync(join(dir, 'context/work/lore'), { recursive: true })
    writeFileSync(join(dir, 'lore.json'), JSON.stringify({ project: 'test', sources: {} }))
    const first = '- {key: TES-1, title: One, status: review, history: [{at: today, by: human, via: web, reason: updated}]}\n'
    writeFileSync(join(dir, tracker), first)
    commit()
    const project = bareProject(root, 'project')!
    const store = new BoardSnapshots(root, cache)
    const [items, counts] = await Promise.all([store.read(project, 'items'), store.read(project, 'counts')])
    assert.deepEqual(items, parseWorkItems(first).map(summarizeForRecall))
    assert.deepEqual(counts, { todo: 0, in_progress: 0, blocked: 0, review: 1, done: 0, archived: 0 })

    // A new server can open the board and read counts without the source blob.
    const oid = git('rev-parse', 'HEAD:' + tracker)
    const blob = join(dir, '.git/objects', oid.slice(0, 2), oid.slice(2))
    renameSync(blob, blob + '.held')
    const fresh = new BoardSnapshots(root, cache)
    assert.deepEqual(await fresh.read(project, 'items'), items)
    const cachedItems = join(cache, readdirSync(cache)[0], 'items.json')
    writeFileSync(cachedItems, '{broken')
    assert.deepEqual(await fresh.read(project, 'counts'), counts)
    await assert.rejects(fresh.read(project, 'items'))
    renameSync(blob + '.held', blob)
    assert.deepEqual(await fresh.read(project, 'items'), items)

    writeFileSync(join(dir, tracker), first.replace('review', 'done'))
    commit()
    assert.equal((await fresh.read(project, 'counts')).done, 1)
    assert.equal((await fresh.read(project, 'items'))[0].state, 'closed')

    git('rm', '--quiet', tracker)
    commit()
    assert.deepEqual(await fresh.read(project, 'items'), [])
    assert.equal((await fresh.read(project, 'counts')).done, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
