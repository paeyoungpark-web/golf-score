/* ━━━ Golf Score AI — 추가 내기 게임 (스킨스 · 라스베가스 · 후세인) ━━━
 * 원칙: 스코어카드 타수만으로 계산 (추가 입력 없음)
 * 입력 holes = [{hole, par, scores:[참가자별 타수]}]  — 참가자 순서 = 카드 순서
 * 출력 홀별 { txns:[{from,to,amount,tag}], info, ... }  — from/to 는 참가자 인덱스
 */
(function (root) {
  'use strict';

  /* 직전 홀 타수로 순위 재정렬 (동타는 기존 순서 유지 = 오너 순서 규칙) */
  function reorder(order, scores) {
    return order
      .map((p, k) => ({ p, k }))
      .sort((a, b) => scores[a.p] - scores[b.p] || a.k - b.k)
      .map(x => x.p);
  }

  /* ── 스킨스 ──
   * 홀마다 단독 최저타 1명이 스킨 획득 → 나머지 전원이 (스킨 수 × 금액) 지급
   * 동타면 스킨이 다음 홀로 이월, 마지막 홀까지 동타면 이월분 소멸(정산 없음) */
  function skins(holes, unit) {
    let carry = 0;
    return holes.map((h, i) => {
      const sc = h.scores, n = sc.length, stake = carry + 1;
      const min = Math.min(...sc);
      const winners = sc.reduce((a, s, p) => (s === min ? a.concat(p) : a), []);
      if (winners.length === 1) {
        const w = winners[0], txns = [];
        for (let p = 0; p < n; p++) if (p !== w) txns.push({ from: p, to: w, amount: stake * unit, tag: '스킨' });
        carry = 0;
        return { txns, winner: w, stake, info: stake > 1 ? `스킨 ${stake}개 (이월 ${stake - 1})` : '스킨 1개' };
      }
      carry = stake;
      const last = i === holes.length - 1;
      return { txns: [], winner: -1, stake, info: last ? `동타 — 이월 ${stake}개 소멸` : `동타 — ${stake}개 이월` };
    });
  }

  /* ── 라스베가스 (1·4 vs 2·3) ──
   * 4인 전용. 직전 홀 순위로 1등+4등 / 2등+3등 팀 구성 (1번 홀은 카드 순서)
   * 팀 합산 타수가 낮은 팀 승리. mode 'stroke' = 타수차 × 금액, 'fixed' = 홀당 고정 금액
   * 지는 팀 두 명이 이긴 팀 두 명에게 각각 1:1 지급 */
  function vegas(holes, unit, opt) {
    const mode = (opt && opt.mode) || 'stroke';
    const n = holes.length ? holes[0].scores.length : 0;
    if (n !== 4) return holes.map(() => ({ txns: [], skip: true, info: '4인 전용' }));
    let order = [0, 1, 2, 3];
    return holes.map((h, i) => {
      if (i > 0) order = reorder(order, holes[i - 1].scores);
      const A = [order[0], order[3]], B = [order[1], order[2]];
      const sa = h.scores[A[0]] + h.scores[A[1]], sb = h.scores[B[0]] + h.scores[B[1]];
      const txns = [];
      if (sa !== sb) {
        const win = sa < sb ? A : B, lose = sa < sb ? B : A;
        const amt = (mode === 'fixed' ? 1 : Math.abs(sa - sb)) * unit;
        txns.push({ from: lose[0], to: win[0], amount: amt, tag: '라스' });
        txns.push({ from: lose[1], to: win[1], amount: amt, tag: '라스' });
      }
      return { txns, teams: [A, B], teamScores: [sa, sb], info: sa === sb ? '팀 동타' : '' };
    });
  }

  /* ── 후세인 ──
   * 후세인 1명 vs 나머지. 후세인 타수 × (인원-1) 과 나머지 합계 비교 (3~4인)
   * 후세인이 낮으면 나머지 각자가 후세인에게, 높으면 후세인이 나머지 각자에게 금액 지급
   * rotation 'order' = 순번 교대(1번홀 P1, 2번홀 P2 …)
   *          'winner' = 직전 홀 단독 1등 / 'loser' = 직전 홀 단독 꼴찌 (동타면 직전 후세인 유지) */
  function hussein(holes, unit, opt) {
    const rot = (opt && opt.rotation) || 'order';
    const n = holes.length ? holes[0].scores.length : 0;
    if (n < 3) return holes.map(() => ({ txns: [], skip: true, info: '3~4인 전용' }));
    let hus = 0;
    return holes.map((h, i) => {
      if (i > 0) {
        if (rot === 'order') hus = i % n;
        else {
          const prev = holes[i - 1].scores;
          const t = rot === 'winner' ? Math.min(...prev) : Math.max(...prev);
          const c = prev.reduce((a, s, p) => (s === t ? a.concat(p) : a), []);
          if (c.length === 1) hus = c[0];
        }
      }
      const others = [];
      for (let p = 0; p < n; p++) if (p !== hus) others.push(p);
      const hs = h.scores[hus] * (n - 1), os = others.reduce((a, p) => a + h.scores[p], 0);
      const txns = [];
      if (hs < os) others.forEach(p => txns.push({ from: p, to: hus, amount: unit, tag: '후세인' }));
      else if (hs > os) others.forEach(p => txns.push({ from: hus, to: p, amount: unit, tag: '후세인' }));
      return { txns, hussein: hus, husScore: hs, othersScore: os, info: hs === os ? '동점' : '' };
    });
  }

  const GolfGames = { skins, vegas, hussein, reorder };
  if (typeof module !== 'undefined' && module.exports) module.exports = GolfGames;
  else root.GolfGames = GolfGames;
})(typeof window !== 'undefined' ? window : this);
