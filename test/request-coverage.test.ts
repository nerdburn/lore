import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { COVERAGE_FILE, parseCoverage, refreshRequestCoverage, savedCoverage } from '../src/request-coverage.js'
import { REQUESTS_FILE } from '../src/requests.js'
import { triageRequest } from '../src/triage.js'
import { readAudit } from '../src/audit.js'
import { parseWorkItems, readWorkItems, workFile } from '../src/work.js'
import { makeContextRepo } from './helpers.js'

const tracker = [
  { key: 'WEB-1', title: 'Delivery estimator', description: 'Display shipping charges in the basket prior to checkout.', status: 'in_progress' },
  { key: 'WEB-2', title: 'International orders', description: 'Enable cross-border payments.', status: 'todo' },
  { key: 'WEB-3', title: 'Old shipping flow', status: 'done' },
]
const request = { id: 'req-1', request: 'Can buyers see what postage costs earlier?', status: 'open' }
const options = (calls: string[]) => ({ apiKey: 'fixture', fetch: async (_: unknown, init?: RequestInit) => {
  const { state, questions } = JSON.parse(String(init?.body))
  calls.push(state.request)
  const tickets = state.tickets as { title: string; description: string }[]
  assert(tickets.every(t => t.title !== 'Old shipping flow'))
  return Response.json({ answers: Object.fromEntries(tickets.map((t, i) => {
    assert.match(questions['ticket_' + i].instructions, /entire concrete change/)
    return ['ticket_' + i, { noul: t.description.includes('shipping charges') && state.request === request.request ? 0.96 : 0.4 }]
  })) })
} })

test('live triage suggests possible coverage independently of goals and reports the shortlist size', async () => {
  const extra = Array.from({ length: 14 }, (_, i) => ({ key: 'OTHER-' + i, title: 'Miscellaneous', status: 'todo' }))
  const work = parseWorkItems(JSON.stringify([...extra, ...tracker]))
  const calls: string[] = []
  const result = await triageRequest(request.request, [], work, options(calls))
  assert.equal(result.disposition, 'covered')
  assert.equal(result.work_coverage.checked, 8)
  assert.equal(result.work_coverage.open, 16)
  assert.equal(result.work_coverage.suggestion?.key, 'WEB-1')
  assert.equal(result.classification, 'no_active_goals')
  assert.deepEqual(calls, [request.request])
  const partial = await triageRequest('Show costs and email receipts', [], work, options(calls))
  assert.equal(partial.work_coverage.suggestion, undefined)
  const failure = await triageRequest(request.request, [], work, { apiKey: 'test', fetch: async () => Response.json({ answers: {} }) })
  assert.equal(failure.work_coverage.status, 'needs_review')
  assert.equal(failure.work_coverage.suggestion, undefined)
})

test('extraction retains positive and negative checks, rechecks changed scopes, and suppresses stale suggestions on read', async () => {
  const requests = [request, { id: 'req-2', request: 'Send payment receipts' }, { id: 'req-3', request: 'Archived', status: 'archived' },
    { id: 'req-4', request: 'Already promoted' }]
  const source = JSON.stringify([...tracker, { key: 'WEB-4', title: 'Already linked', request: 'req-4', status: 'todo' }])
  const root = makeContextRepo({ [workFile('WEB')]: source, [REQUESTS_FILE]: JSON.stringify(requests) })
  const work = parseWorkItems(source)
  const calls: string[] = []
  const read = () => parseCoverage(readFileSync(join(root, COVERAGE_FILE), 'utf8'))
  await refreshRequestCoverage(root, 'WEB', options(calls))
  assert.deepEqual(calls, requests.slice(0, 2).map(r => r.request))
  const persisted = readWorkItems(root, 'WEB')
  assert.deepEqual(persisted[0].linked_requests, [request.id])
  assert.deepEqual(persisted.map(t => [t.key, t.status, t.assignee, t.priority]), work.map(t => [t.key, t.status, t.assignee, t.priority]))
  assert.match(persisted[0].history.at(-1)!.reason, /req-1.*0.96/)
  assert.equal(readAudit(root)[0].actor, 'jev')
  const oldCache = readFileSync(join(root, COVERAGE_FILE), 'utf8')
  await refreshRequestCoverage(root, 'WEB', options(calls))
  assert.equal(calls.length, 2)
  assert.equal(readAudit(root).length, 1)
  // Simulate a pre-upgrade checkout with an advisory cache but no ticket link.
  writeFileSync(join(root, workFile('WEB')), source)
  writeFileSync(join(root, COVERAGE_FILE), oldCache)
  const lookup = savedCoverage(read(), work)
  assert.equal(lookup(request)?.key, 'WEB-1')
  assert.equal(lookup(requests[1]), undefined)
  assert.equal(lookup({ ...request, ticket: 'WEB-9' }), undefined)
  assert.equal(lookup({ ...request, request: 'Something else' }), undefined)
  assert.equal(lookup({ ...request, status: 'archived' }), undefined)
  await refreshRequestCoverage(root, 'WEB', {})
  assert.deepEqual(readWorkItems(root, 'WEB')[0].linked_requests, ['req-1'])
  work[0].description = 'Revise navigation'
  writeFileSync(join(root, workFile('WEB')), JSON.stringify(work))
  await refreshRequestCoverage(root, 'WEB', options(calls))
  assert.equal(calls.length, 4)
  assert.equal(savedCoverage(read(), work)(request), undefined)
  assert.equal(readWorkItems(root, 'WEB')[0].linked_requests, undefined)
})

test('scheduled checks prioritize new asks, bound each run and retry failed evaluations', async () => {
  const requests = Array.from({ length: 5 }, (_, i) => ({
    id: 'req-' + i, request: 'Ask ' + i, date: '2026-11-0' + (i + 1),
  }))
  const root = makeContextRepo({ [workFile('WEB')]: JSON.stringify(tracker), [REQUESTS_FILE]: JSON.stringify(requests) })
  const calls: string[] = []
  let failures = 0
  await refreshRequestCoverage(root, 'WEB', { apiKey: 'fixture', fetch: async () => { failures++; throw Error('offline') } })
  assert.equal(failures, 1)
  await refreshRequestCoverage(root, 'WEB', options(calls))
  assert.deepEqual(calls, ['Ask 4', 'Ask 3', 'Ask 2'])
  await refreshRequestCoverage(root, 'WEB', options(calls))
  assert.deepEqual(calls, ['Ask 4', 'Ask 3', 'Ask 2', 'Ask 1', 'Ask 0'])
})

test('a live match links automatically once its exact ask is recorded', async () => {
  const root = makeContextRepo({ [workFile('WEB')]: JSON.stringify(tracker) })
  const liveCache = join(root, '.live')
  const work = readWorkItems(root, 'WEB')
  const live = await triageRequest(request.request, [], work, { ...options([]), liveCache })
  assert.equal(live.disposition, 'covered')
  writeFileSync(join(root, REQUESTS_FILE), JSON.stringify([request]))
  await refreshRequestCoverage(root, 'WEB', { liveCache })
  assert.deepEqual(readWorkItems(root, 'WEB')[0].linked_requests, [request.id])
})

test('a ticket that closes while Jev is evaluating the ask is never auto-linked', async () => {
  const root = makeContextRepo({ [workFile('WEB')]: JSON.stringify(tracker), [REQUESTS_FILE]: JSON.stringify([request]) })
  const fake = options([])
  await refreshRequestCoverage(root, 'WEB', { ...fake, fetch: async (url, init) => {
    writeFileSync(join(root, workFile('WEB')), JSON.stringify(tracker.map(t => ({ ...t, status: 'done' }))))
    return fake.fetch(url, init)
  } })
  assert.equal(readWorkItems(root, 'WEB')[0].linked_requests, undefined)
  assert.deepEqual(readAudit(root), [])
})
