import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const G = require('../public/games.js')

const H = (par: number, ...scores: number[]) => ({ hole: 0, par, scores })
const net = (rows: any[], n: number) => {
  const t = new Array(n).fill(0)
  rows.forEach(r => r.txns.forEach((x: any) => { t[x.from] -= x.amount; t[x.to] += x.amount }))
  return t
}

test('skins: 단독 최저타 획득, 동타 이월, 마지막 동타 소멸', () => {
  const r = G.skins([H(4, 4, 4, 5, 5), H(4, 3, 4, 4, 4), H(4, 5, 5, 5, 5)], 1000)
  assert.equal(r[0].winner, -1)
  assert.equal(r[1].winner, 0)
  assert.equal(r[1].stake, 2)
  assert.deepEqual(net(r, 4), [6000, -2000, -2000, -2000])
  assert.match(r[2].info, /소멸/)
})

test('vegas: 1번홀 카드순서, 이후 직전홀 순위로 1·4 vs 2·3', () => {
  const r = G.vegas([H(4, 4, 5, 6, 3), H(4, 4, 4, 4, 5)], 1000)
  // 1번홀 팀: [0,3]=7 vs [1,2]=11 → 4타 차
  assert.deepEqual(r[0].teams, [[0, 3], [1, 2]])
  assert.deepEqual(net([r[0]], 4), [4000, -4000, -4000, 4000])
  // 2번홀 순위: P3(3) P0(4) P1(5) P2(6) → [3,2] vs [0,1]
  assert.deepEqual(r[1].teams, [[3, 2], [0, 1]])
  assert.deepEqual(r[1].teamScores, [9, 8])
  assert.deepEqual(net([r[1]], 4), [1000, 1000, -1000, -1000])
  const f = G.vegas([H(4, 4, 5, 6, 3)], 1000, { mode: 'fixed' })
  assert.deepEqual(net(f, 4), [1000, -1000, -1000, 1000])
})

test('vegas: 4인이 아니면 건너뜀', () => {
  const r = G.vegas([H(4, 4, 5, 6)], 1000)
  assert.equal(r[0].skip, true)
  assert.equal(r[0].txns.length, 0)
})

test('hussein: 순번 교대, 후세인×3 vs 나머지 합', () => {
  const r = G.hussein([H(4, 4, 5, 5, 5), H(4, 4, 6, 4, 4)], 1000)
  assert.equal(r[0].hussein, 0)
  assert.deepEqual(net([r[0]], 4), [3000, -1000, -1000, -1000])
  assert.equal(r[1].hussein, 1)
  assert.deepEqual(net([r[1]], 4), [1000, -3000, 1000, 1000])
})

test('hussein: 직전홀 단독 1등이 후세인, 동타면 유지', () => {
  const r = G.hussein([H(4, 5, 4, 5, 5), H(4, 4, 4, 5, 5), H(4, 4, 4, 4, 4)], 1000, { rotation: 'winner' })
  assert.equal(r[1].hussein, 1)
  assert.equal(r[2].hussein, 1)
  assert.equal(r[2].txns.length, 0)
})

test('hussein: 3인이면 ×2 비교', () => {
  const r = G.hussein([H(4, 4, 5, 4)], 1000)
  assert.equal(r[0].husScore, 8)
  assert.equal(r[0].othersScore, 9)
  assert.deepEqual(net(r, 3), [2000, -1000, -1000])
})
