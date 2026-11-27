import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { COVERAGE_FILE, parseCoverage, refreshRequestCoverage, savedCoverage } from '../src/request-coverage.js'
import { REQUESTS_FILE } from '../src/requests.js'
import { triageRequest } from '../src/triage.js'
import { parseWorkItems, workFile } from '../src/work.js'
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
  assert.equal(result.disposition, 'intake')
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
  await refreshRequestCoverage(root, 'WEB', options(calls))
  assert.equal(calls.length, 2)
  const lookup = savedCoverage(read(), work)
  assert.equal(lookup(request)?.key, 'WEB-1')
  assert.equal(lookup(requests[1]), undefined)
  assert.equal(lookup({ ...request, ticket: 'WEB-9' }), undefined)
  assert.equal(lookup({ ...request, request: 'Something else' }), undefined)
  assert.equal(lookup({ ...request, status: 'archived' }), undefined)
  assert.equal(savedCoverage(read(), work.filter(w => w.key !== 'WEB-1'))(request), undefined)
  work[0].state = 'closed'
  assert.equal(savedCoverage(read(), work)(request), undefined)
  work[0].state = 'open'
  work[0].description = 'Revise navigation'
  assert.equal(savedCoverage(read(), work)(request), undefined)
  writeFileSync(join(root, workFile('WEB')), JSON.stringify(work))
  await refreshRequestCoverage(root, 'WEB', options(calls))
  assert.equal(calls.length, 4)
  assert.equal(savedCoverage(read(), work)(request), undefined)
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
