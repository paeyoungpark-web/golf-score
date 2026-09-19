import assert from 'node:assert/strict'
import { test } from 'node:test'
import { step2_convert } from '../src/index.tsx'

const raw = {
  players: ['A', 'B'],
  pars: [4, 4, 3, 5, 4, 4, 5, 3, 4, 4, 4, 3, 5, 4, 4, 5, 3, 4],
  rawScores: [new Array(18).fill(0), new Array(18).fill(1)],
  cardTotal: [72, 90],
  detectedMode: '1card-2p',
}

test('converts diff scores and calculates OUT, IN, and total deterministically', () => {
  const result = step2_convert(raw)

  assert.equal(result.holes[0].scores[0], 4)
  assert.equal(result.holes[2].scores[1], 4)
  assert.deepEqual(result.totals.out, [36, 45])
  assert.deepEqual(result.totals.in, [36, 45])
  assert.deepEqual(result.totals.total, [72, 90])
  assert.equal(result.detectedMode, '1card-2p')
})

test('rejects incomplete or malformed OCR scorecards', () => {
  assert.throws(() => step2_convert({ ...raw, pars: raw.pars.slice(0, 17) }))
  assert.throws(() => step2_convert({ ...raw, rawScores: [[0, 0, null]] }))
})