/*
 * equity.js — 蒙特卡洛胜率计算
 * 支持：vs 随机手牌、vs 指定范围（按组合频率加权）
 */
(function (root) {
  'use strict';
  var PE = root.PokerEval;
  var PT = root.PreflopTable;

  // 169 个 key -> 该 key 包含的具体组合数
  function comboCount(key) {
    if (key[0] === key[1]) return 6;
    return key[2] === 's' ? 4 : 12;
  }

  // 展开 key 为具体两张牌列表
  function expandKey(key) {
    var A = '23456789TJQKA';
    var r1 = A.indexOf(key[0]), r2 = A.indexOf(key[1]);
    var res = [];
    if (key[0] === key[1]) {
      for (var s1 = 0; s1 < 4; s1++)
        for (var s2 = s1 + 1; s2 < 4; s2++)
          res.push([s1 * 13 + r1, s2 * 13 + r1]);
    } else if (key[2] === 's') {
      for (var s = 0; s < 4; s++) res.push([s * 13 + r1, s * 13 + r2]);
    } else {
      for (var a = 0; a < 4; a++)
        for (var b = 0; b < 4; b++)
          if (a !== b) res.push([a * 13 + r1, b * 13 + r2]);
    }
    return res;
  }

  var keyComboCache = {};
  function combosOf(key) {
    if (!keyComboCache[key]) keyComboCache[key] = expandKey(key);
    return keyComboCache[key];
  }

  /**
   * 范围 -> 加权组合列表
   * @param {Object} range { key: weight(0..1) }  weight 为该 key 被持有的频率
   */
  function buildRangeCombos(range) {
    var list = [];
    for (var key in range) {
      var w = range[key];
      if (!(w > 0)) continue;
      var cs = combosOf(key);
      for (var i = 0; i < cs.length; i++) list.push({ c: cs[i], w: w });
    }
    return list;
  }

  /**
   * 计算胜率
   * @param {number[]} hole 英雄两张牌
   * @param {number[]} board 公共牌（0..5 张）
   * @param {Object|null} oppRange 对手范围 {key:weight}，null 表示随机手牌
   * @param {number} iter 模拟次数
   * @returns {{win:number, tie:number, equity:number, n:number}}
   */
  function calcEquity(hole, board, oppRange, iter) {
    iter = iter || 2000;
    board = board || [];
    var known = {};
    hole.forEach(function (c) { known[c] = 1; });
    board.forEach(function (c) { known[c] = 1; });

    var deck = [];
    for (var c = 0; c < 52; c++) if (!known[c]) deck.push(c);

    var combos = null;
    var cum = null;
    var totalW = 0;
    if (oppRange) {
      combos = buildRangeCombos(oppRange).filter(function (x) {
        return !known[x.c[0]] && !known[x.c[1]];
      });
      if (combos.length) {
        // 前缀和 + 二分抽样，避免每次 O(n) 线性扫描（全范围可达 1326 组合）
        cum = new Float64Array(combos.length);
        var acc = 0;
        for (var ci = 0; ci < combos.length; ci++) {
          acc += combos[ci].w;
          cum[ci] = acc;
        }
        totalW = acc;
      }
      if (!combos.length || totalW <= 0) { combos = null; cum = null; }
    }

    var need = 5 - board.length;
    var win = 0, tie = 0, n = 0;
    var b = board.slice();

    for (var it = 0; it < iter; it++) {
      var o1, o2;
      var pool = deck;
      var skip = 0;
      if (combos) {
        // 按权重二分抽一个组合
        var t = Math.random() * totalW;
        var lo = 0, hi = cum.length - 1;
        while (lo < hi) {
          var mid = (lo + hi) >> 1;
          if (cum[mid] < t) lo = mid + 1; else hi = mid;
        }
        var picked = combos[lo];
        o1 = picked.c[0]; o2 = picked.c[1];
      } else {
        // 随机取两张
        var i1 = (Math.random() * pool.length) | 0;
        o1 = pool[i1];
        var i2 = (Math.random() * pool.length) | 0;
        while (i2 === i1) i2 = (Math.random() * pool.length) | 0;
        o2 = pool[i2];
      }

      // 抽取补足公共牌的牌（避开对手手牌）
      var used = {};
      used[o1] = 1; used[o2] = 1;
      var added = 0;
      var guard = 0;
      var tmp = b.slice();
      while (added < need && guard < 200) {
        guard++;
        var idx = (Math.random() * pool.length) | 0;
        var cd = pool[idx];
        if (used[cd]) continue;
        used[cd] = 1;
        tmp.push(cd);
        added++;
      }
      if (added < need) continue;

      var my = PE.evalBest([hole[0], hole[1], tmp[0], tmp[1], tmp[2], tmp[3], tmp[4]]);
      var op = PE.evalBest([o1, o2, tmp[0], tmp[1], tmp[2], tmp[3], tmp[4]]);
      if (my > op) win++; else if (my === op) tie++;
      n++;
    }

    var equity = n ? (win + tie * 0.5) / n : 0.5;
    return { win: n ? win / n : 0, tie: n ? tie / n : 0, equity: equity, n: n };
  }

  /**
   * 多人底池胜率：同时对多个对手范围做蒙特卡洛模拟
   * @param {number[]} hole 英雄两张牌
   * @param {number[]} board 公共牌（0..5 张）
   * @param {Array<Object|null>} oppRanges 每个对手的范围（null = 随机手牌）
   * @param {number} iter 模拟次数
   */
  function calcEquityMulti(hole, board, oppRanges, iter) {
    iter = iter || 1200;
    board = board || [];
    var k = oppRanges ? oppRanges.length : 0;
    if (k === 0) { return calcEquity(hole, board, null, iter); }
    if (k === 1) { return calcEquity(hole, board, oppRanges[0], iter); }

    var known = {};
    hole.forEach(function (c) { known[c] = 1; });
    board.forEach(function (c) { known[c] = 1; });

    var deck = [];
    for (var c = 0; c < 52; c++) if (!known[c]) deck.push(c);

    // 预构建每个对手的加权抽样表
    var tables = [];
    for (var j = 0; j < k; j++) {
      if (!oppRanges[j]) { tables.push(null); continue; }
      var combos = buildRangeCombos(oppRanges[j]).filter(function (x) {
        return !known[x.c[0]] && !known[x.c[1]];
      });
      if (!combos.length) { tables.push(null); continue; }
      var cum = new Float64Array(combos.length);
      var acc = 0;
      for (var ci = 0; ci < combos.length; ci++) { acc += combos[ci].w; cum[ci] = acc; }
      tables.push({ c: combos, cum: cum, total: acc });
    }

    function pick(t) {
      var target = Math.random() * t.total;
      var lo = 0, hi = t.cum.length - 1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (t.cum[mid] < target) lo = mid + 1; else hi = mid;
      }
      return t.c[lo];
    }

    var need = 5 - board.length;
    var win = 0, tie = 0, n = 0;

    for (var it = 0; it < iter; it++) {
      var used = {};
      var ok = true;
      var oppHoles = [];
      for (var m = 0; m < k; m++) {
        var picked = null;
        if (tables[m]) {
          // 逐个对手抽样，牌冲突时重抽（有限次）
          for (var tries = 0; tries < 12; tries++) {
            var cand = pick(tables[m]);
            if (used[cand.c[0]] || used[cand.c[1]]) continue;
            picked = cand; break;
          }
          if (!picked) continue;
        } else {
          var got = false;
          for (var tries2 = 0; tries2 < 40; tries2++) {
            var i1 = (Math.random() * deck.length) | 0;
            var i2 = (Math.random() * deck.length) | 0;
            if (i1 === i2) continue;
            if (used[deck[i1]] || used[deck[i2]]) continue;
            picked = { c: [deck[i1], deck[i2]] };
            got = true; break;
          }
          if (!got) { ok = false; break; }
        }
        used[picked.c[0]] = 1; used[picked.c[1]] = 1;
        oppHoles.push(picked.c);
      }
      if (!ok || oppHoles.length < k) continue;

      var run = board.slice();
      for (var a = 0; a < need; a++) {
        var cd = -1;
        for (var tries3 = 0; tries3 < 40; tries3++) {
          var idx = (Math.random() * deck.length) | 0;
          if (used[deck[idx]]) continue;
          cd = deck[idx]; break;
        }
        if (cd < 0) { ok = false; break; }
        used[cd] = 1;
        run.push(cd);
      }
      if (!ok) continue;

      var my = PE.evalBest([hole[0], hole[1], run[0], run[1], run[2], run[3], run[4]]);
      var bestOpp = -1;
      for (var q = 0; q < oppHoles.length; q++) {
        var ov = PE.evalBest([oppHoles[q][0], oppHoles[q][1], run[0], run[1], run[2], run[3], run[4]]);
        if (ov > bestOpp) bestOpp = ov;
      }
      if (my > bestOpp) win++;
      else if (my === bestOpp) tie++;
      n++;
    }

    var equity = n ? (win + tie * 0.5) / n : (1 / (k + 1));
    return { win: n ? win / n : 0, tie: n ? tie / n : 0, equity: equity, n: n, opponents: k };
  }

  /**
   * 英雄手牌在对手范围内的相对强度百分位（0..1）
   * 用当前牌力 vs 范围抽样牌力的比较近似
   */
  function handStrengthVsRange(hole, board, oppRange, iter) {
    iter = iter || 600;
    var res = calcEquity(hole, board, oppRange, iter);
    return res.equity;
  }

  /** 补全：把范围对象规范化（缺失 key 视为 0） */
  function normalizeRange(range) {
    var out = {};
    for (var k in range) if (range[k] > 0) out[k] = Math.min(1, range[k]);
    return out;
  }

  /** 范围中组合数占比（用于 UI 显示范围宽度） */
  function rangeWidth(range) {
    var tot = 0, have = 0;
    for (var i = 12; i >= 0; i--) {
      for (var j = i; j >= 0; j--) {
        var A = '23456789TJQKA';
        var key;
        if (i === j) key = A[i] + A[i];
        else {
          key = A[i] + A[j] + 's'; tot += 4; if (range[key] > 0) have += 4 * Math.min(1, range[key]);
          key = A[i] + A[j] + 'o'; tot += 12; if (range[key] > 0) have += 12 * Math.min(1, range[key]);
          continue;
        }
        tot += 6; if (range[key] > 0) have += 6 * Math.min(1, range[key]);
      }
    }
    return tot ? have / tot : 0;
  }

  root.Equity = {
    calcEquity: calcEquity,
    calcEquityMulti: calcEquityMulti,
    handStrengthVsRange: handStrengthVsRange,
    normalizeRange: normalizeRange,
    rangeWidth: rangeWidth,
    expandKey: expandKey,
    comboCount: comboCount,
    combosOf: combosOf
  };
})(typeof self !== 'undefined' ? self : globalThis);
