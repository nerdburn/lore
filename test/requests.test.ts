import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acceptFold } from '../src/commands/extract.js'
import { reidAroundClosed } from '../src/requests.js'

test('fold: a request a person archived or deleted keeps its record, and a new request never takes its id', () => {
  const previous = [
    { id: 'req-0001', request: 'Export members', status: 'open' },
    { id: 'req-0002', request: 'Dark mode', status: 'archived' },
    { id: 'req-0003', request: 'Old idea', status: 'deleted' },
  ]
  // The fold was shown only req-0001, so it numbers its new requests from req-0002.
  const proposed = [
    { id: 'req-0001', request: 'Export members', status: 'done' },
    { id: 'req-0002', request: 'Referral codes', status: 'open' },
    { id: 'req-0003', request: 'Weekly digest', status: 'open' },
  ]
  const merged = acceptFold('requests', previous, reidAroundClosed(previous, proposed))
  assert.deepEqual(merged.items, [
    { id: 'req-0001', request: 'Export members', status: 'done' },
    { id: 'req-0002', request: 'Dark mode', status: 'archived' },
    { id: 'req-0003', request: 'Old idea', status: 'deleted' },
    { id: 'req-0004', request: 'Referral codes', status: 'open' },
    { id: 'req-0005', request: 'Weekly digest', status: 'open' },
  ])
  assert.deepEqual(reidAroundClosed([{ id: 'req-0001', status: 'open' }], proposed), proposed, 'with nothing closed, ids pass through')
})
