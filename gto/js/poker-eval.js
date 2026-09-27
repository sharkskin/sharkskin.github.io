/*
 * poker-eval.js — 德州扑克牌力评估核心
 * 同时支持浏览器全局与 Node CommonJS（供离线预计算使用）
 * 牌编码：0..51，rank = c % 13 (0='2' ... 12='A')，suit = (c/13)|0 (0=♠ 1=♥ 2=♦ 3=♣)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PokerEval = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var RANK_CHARS = '23456789TJQKA';
  var SUIT_CHARS = 'shdc';
  var RANK_NAMES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  var CAT_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

  function parseCard(s) {
    var r = RANK_CHARS.indexOf(s[0].toUpperCase());
    var su = SUIT_CHARS.indexOf(s[1].toLowerCase());
    if (r < 0 || su < 0) return -1;
    return su * 13 + r;
  }

  function cardText(c) {
    return RANK_NAMES[c % 13] + SUIT_CHARS[(c / 13) | 0];
  }

  function cardRank(c) { return c % 13; }
  function cardSuit(c) { return (c / 13) | 0; }

  // ---- 5 张牌评估：返回整数，越大越强 ----
  // 结构：category(0..8) << 20 | 5 个 4bit 的排序键
  var STRAIGHT_MASKS = [];
  (function () {
    for (var h = 12; h >= 4; h--) {
      STRAIGHT_MASKS.push({ high: h, mask: 0x1F << (h - 4) });
    }
  })();

  function eval5(c0, c1, c2, c3, c4) {
    var counts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    var suitCount = [0, 0, 0, 0];
    var rMask = 0;
    var cards = [c0, c1, c2, c3, c4];

    for (var i = 0; i < 5; i++) {
      var r = cards[i] % 13;
      counts[r]++;
      rMask |= (1 << r);
      suitCount[(cards[i] / 13) | 0]++;
    }

    var isFlush = (suitCount[0] === 5 || suitCount[1] === 5 || suitCount[2] === 5 || suitCount[3] === 5);

    var straightHigh = -1;
    for (var k = 0; k < STRAIGHT_MASKS.length; k++) {
      if ((rMask & STRAIGHT_MASKS[k].mask) === STRAIGHT_MASKS[k].mask) {
        straightHigh = STRAIGHT_MASKS[k].high;
        break;
      }
    }
    if (straightHigh < 0 && (rMask & 0x100F) === 0x100F) straightHigh = 3; // A2345

    var quads = -1, trips = -1, trips2 = -1;
    var pairs = [];
    var singles = [];
    for (var r2 = 12; r2 >= 0; r2--) {
      if (counts[r2] === 4) quads = r2;
      else if (counts[r2] === 3) {
        if (trips < 0) trips = r2; else trips2 = r2;
      } else if (counts[r2] === 2) pairs.push(r2);
      else if (counts[r2] === 1) singles.push(r2);
    }

    function key(a, b, c, d, e) {
      return (a << 16) | (b << 12) | (c << 8) | (d << 4) | e;
    }
    function pack(cat, tk) { return (cat << 20) | tk; }

    if (isFlush && straightHigh >= 0) return pack(8, key(straightHigh, 0, 0, 0, 0));
    if (quads >= 0) {
      var qk = singles.length ? singles[0] : pairs[0];
      return pack(7, key(quads, qk, 0, 0, 0));
    }
    if (trips >= 0 && (pairs.length >= 1 || trips2 >= 0)) {
      var pk = pairs.length ? pairs[0] : trips2;
      return pack(6, key(trips, pk, 0, 0, 0));
    }
    if (isFlush) {
      var f = singles.concat(pairs).sort(function (a, b) { return b - a; });
      for (var pi = 0; pi < pairs.length; pi++) { /* 同花时重复牌已合并，无需处理 */ }
      return pack(5, key(f[0], f[1], f[2], f[3], f[4]));
    }
    if (straightHigh >= 0) return pack(4, key(straightHigh, 0, 0, 0, 0));
    if (trips >= 0) {
      return pack(3, key(trips, singles[0] !== undefined ? singles[0] : 0, singles[1] !== undefined ? singles[1] : 0, 0, 0));
    }
    if (pairs.length >= 2) {
      return pack(2, key(pairs[0], pairs[1], singles[0] !== undefined ? singles[0] : 0, 0, 0));
    }
    if (pairs.length === 1) {
      return pack(1, key(pairs[0], singles[0], singles[1], singles[2], 0));
    }
    return pack(0, key(singles[0], singles[1], singles[2], singles[3], singles[4]));
  }

  // ---- 7 张（或 5/6 张）取最优 5 张 ----
  var COMBO7 = (function () {
    var res = [];
    for (var a = 0; a < 3; a++)
      for (var b = a + 1; b < 4; b++)
        for (var c = b + 1; c < 5; c++)
          for (var d = c + 1; d < 6; d++)
            for (var e = d + 1; e < 7; e++)
              res.push([a, b, c, d, e]);
    return res;
  })();
  var COMBO6 = [
    [0, 1, 2, 3, 4], [0, 1, 2, 3, 5], [0, 1, 2, 4, 5], [0, 1, 3, 4, 5], [0, 2, 3, 4, 5], [1, 2, 3, 4, 5]
  ];

  function evalBest(cards) {
    var n = cards.length;
    var best = -1;
    if (n === 5) return eval5(cards[0], cards[1], cards[2], cards[3], cards[4]);
    if (n === 6) {
      for (var i = 0; i < COMBO6.length; i++) {
        var cb = COMBO6[i];
        var v = eval5(cards[cb[0]], cards[cb[1]], cards[cb[2]], cards[cb[3]], cards[cb[4]]);
        if (v > best) best = v;
      }
      return best;
    }
    for (var j = 0; j < COMBO7.length; j++) {
      var c7 = COMBO7[j];
      var v7 = eval5(cards[c7[0]], cards[c7[1]], cards[c7[2]], cards[c7[3]], cards[c7[4]]);
      if (v7 > best) best = v7;
    }
    return best;
  }

  function categoryOf(value) { return value >> 20; }

  // 中文牌力描述（用于 UI 与复盘）
  function describeHand(hole, board) {
    if (!board || board.length < 3 || !hole || hole.length < 2) return '—';
    var all = hole.concat(board);
    var v = evalBest(all);
    var cat = v >> 20;
    var tk = v & 0xFFFFF;
    function rAt(i) { return (tk >> (16 - 4 * i)) & 0xF; }

    var counts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    var suitCount = [0, 0, 0, 0];
    var rMask = 0;
    for (var i = 0; i < all.length; i++) {
      counts[all[i] % 13]++;
      suitCount[(all[i] / 13) | 0]++;
      rMask |= (1 << (all[i] % 13));
    }
    var boardRanks = board.map(function (c) { return c % 13; });
    var topBoard = Math.max.apply(null, boardRanks);

    switch (cat) {
      case 8: return '同花顺 ' + RANK_NAMES[rAt(0)] + ' 高';
      case 7: return '四条 ' + RANK_NAMES[rAt(0)];
      case 6: return '葫芦 ' + RANK_NAMES[rAt(0)] + ' 配 ' + RANK_NAMES[rAt(1)];
      case 5: {
        // 同花：判断是坚果还是次级
        var fs = -1;
        for (var s = 0; s < 4; s++) if (suitCount[s] >= 5) fs = s;
        var suited = all.filter(function (c) { return ((c / 13) | 0) === fs; }).map(function (c) { return c % 13; }).sort(function (a, b) { return b - a; });
        var hi = suited[0];
        if (suited[0] === 12) return '坚果同花（A 高）';
        return '同花（' + RANK_NAMES[hi] + ' 高）';
      }
      case 4: return '顺子 ' + RANK_NAMES[rAt(0)] + ' 高';
      case 3: {
        var tr = rAt(0);
        if (tr === topBoard && boardRanks.filter(function (r) { return r === tr; }).length >= 2) {
          return '明三条（set）' + RANK_NAMES[tr];
        }
        if (hole.some(function (c) { return (c % 13) === tr; }) && boardRanks.indexOf(tr) >= 0) {
          return '三条 ' + RANK_NAMES[tr] + '（用一张手牌）';
        }
        return '三条 ' + RANK_NAMES[tr] + '（暗三条/板面三条）';
      }
      case 2: {
        var p1 = rAt(0), p2 = rAt(1);
        var usedHole = hole.filter(function (c) { return (c % 13) === p1 || (c % 13) === p2; }).length;
        var over = p1 > topBoard;
        if (usedHole === 0) return '两对（板面）';
        if (p1 === topBoard) return '顶两对';
        if (over) return '两对（超对拆）';
        return '两对 ' + RANK_NAMES[p1] + '/' + RANK_NAMES[p2];
      }
      case 1: {
        var pr = rAt(0);
        var kick = rAt(1);
        var holeInPair = hole.some(function (c) { return (c % 13) === pr; });
        var boardHasPair = boardRanks.indexOf(pr) >= 0;
        if (pr > topBoard) return '超对 ' + RANK_NAMES[pr];
        if (pr === topBoard) {
          if (holeInPair && boardHasPair) {
            if (kick >= 9) return '顶对 + 好踢脚（' + RANK_NAMES[kick] + '）';
            if (kick >= 6) return '顶对 + 中等踢脚（' + RANK_NAMES[kick] + '）';
            return '顶对 + 弱踢脚（' + RANK_NAMES[kick] + '）';
          }
          return '顶对（板面对子）';
        }
        if (boardRanks.indexOf(pr) < 0) return '中对/底对（口袋对 ' + RANK_NAMES[pr] + '）';
        var idx = boardRanks.slice().sort(function (a, b) { return b - a; }).indexOf(pr);
        if (idx === 1) return '中对 ' + RANK_NAMES[pr];
        return '底对 ' + RANK_NAMES[pr];
      }
      default: {
        // 高牌：检查听牌
        var flushDraw = suitCount.some(function (v) { return v === 4; });
        var hasA = hole.some(function (c) { return (c % 13) === 12; });
        var drawNote = [];
        if (flushDraw) drawNote.push('听花');
        if (hasOpenEnded(rMask)) drawNote.push('听顺');
        if (drawNote.length) return '高牌（' + drawNote.join('+') + '）';
        if (hasA) return 'A 高';
        return '高牌 ' + RANK_NAMES[rAt(0)];
      }
    }
  }

  function hasOpenEnded(rMask) {
    // OESD：4 张连续（不含 A2345/Broadway 边角判断的简化版）
    for (var h = 12; h >= 4; h--) {
      var m = 0x1F << (h - 4);
      var bits = rMask & m;
      var cnt = popcount(bits);
      if (cnt === 4) return true;
    }
    if ((rMask & 0x100F) && popcount(rMask & 0x100F) === 4) return true;
    return false;
  }

  function popcount(x) {
    var c = 0;
    while (x) { x &= x - 1; c++; }
    return c;
  }

  function categoryName(value) { return CAT_NAMES[value >> 20]; }

  return {
    RANK_CHARS: RANK_CHARS,
    SUIT_CHARS: SUIT_CHARS,
    RANK_NAMES: RANK_NAMES,
    parseCard: parseCard,
    cardText: cardText,
    cardRank: cardRank,
    cardSuit: cardSuit,
    eval5: eval5,
    evalBest: evalBest,
    categoryOf: categoryOf,
    categoryName: categoryName,
    describeHand: describeHand,
    hasOpenEnded: hasOpenEnded
  };
});
