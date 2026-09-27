/*
 * gto.js — GTO 策略引擎
 *
 * 说明：这是面向教学的「近似 GTO」引擎，而非完整求解器。
 * 预翻牌基于 169 手牌的真实胜率排序构建范围；翻牌后基于
 * 胜率 / 底池赔率 / 位置 / 牌面纹理 / SPR 计算每个行动的混合频率与 EV。
 *
 * 输出的核心形态是「频率分布」而非单一答案 —— 这正是 GTO 的本质特征。
 */
(function (root) {
  'use strict';
  var PE = root.PokerEval;
  var PT = root.PreflopTable;
  var EQ = root.Equity;

  var A_CH = '23456789TJQKA';

  // ---------------- 基础工具 ----------------
  var ALL_KEYS = (function () {
    var ks = [];
    for (var i = 12; i >= 0; i--) {
      for (var j = i; j >= 0; j--) {
        if (i === j) ks.push(A_CH[i] + A_CH[i]);
        else { ks.push(A_CH[i] + A_CH[j] + 's'); ks.push(A_CH[i] + A_CH[j] + 'o'); }
      }
    }
    return ks;
  })();

  var infoCache = {};
  function keyInfo(key) {
    if (infoCache[key]) return infoCache[key];
    var d = PT.lookup(key) || { rank: 169, equity: 0.33 };
    var r1 = A_CH.indexOf(key[0]), r2 = A_CH.indexOf(key[1]);
    var hi = Math.max(r1, r2), lo = Math.min(r1, r2);
    var isPair = r1 === r2;
    var isSuited = key[2] === 's';
    var gap = hi - lo - 1;
    var info = {
      key: key,
      rank: d.rank,
      pct: (d.rank - 1) / 168,
      pfEquity: d.equity,
      isPair: isPair,
      isSuited: isSuited,
      isOffsuit: key[2] === 'o',
      isAx: hi === 12,
      isBroadway: lo >= 8,
      gap: gap,
      isConnector: !isPair && gap <= 0,
      isSuitedConnector: isSuited && !isPair && gap <= 1,
      highCard: hi,
      lowCard: lo
    };
    infoCache[key] = info;
    return info;
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  // 把 {three,call,fold} 归一化到和为 1
  function renormalize(m) {
    var t = (m.three || 0) + (m.call || 0) + (m.fold || 0);
    if (t <= 0) return { three: 0, call: 0, fold: 1 };
    return { three: (m.three || 0) / t, call: (m.call || 0) / t, fold: (m.fold || 0) / t };
  }

  // ---------------- 范围构建 ----------------
  // 范围 = { key: weight(0..1) }，weight 表示该组合被持有的频率

  function rangeFrom(spec) {
    var r = {};
    for (var i = 0; i < ALL_KEYS.length; i++) {
      var k = ALL_KEYS[i];
      var w = spec(keyInfo(k), k);
      if (w > 0) r[k] = w > 1 ? 1 : w;
    }
    return r;
  }

  function mergeRanges(a, b) {
    var out = {};
    for (var k in a) out[k] = a[k];
    for (var k2 in b) out[k2] = Math.max(out[k2] || 0, b[k2]);
    return out;
  }

  // 预翻牌范围定义（heads-up，100bb）
  // SB = 按钮，翻前先行动；BB 后行动

  var RANGES = {
    // SB 开局（含 limp 与 raise 的整体可玩范围）
    // heads-up 中按钮位弃牌极少：即使最弱的手牌也大多可玩（赔率 + 位置 + 对手单盲注）
    SB_PLAY: rangeFrom(function (i) {
      var p = i.pct;
      if (p <= 0.10) return 1.0;
      if (p <= 0.35) return 0.99;
      if (p <= 0.60) return 0.96;
      if (p <= 0.80) return 0.91;
      if (p <= 0.92) return 0.85;
      return 0.74;
    }),
    // SB 开局中「加注」的份额（其余为 limp / 弃牌）
    SB_RAISE_SHARE: function (i) {
      var p = i.pct;
      var s = 0.92 - p * 0.36;               // 0.92 → 0.56
      if (i.isPair && i.highCard <= 9) s += 0.06;   // 小对子偏向加注
      if (i.isSuitedConnector) s += 0.05;
      if (i.isAx && i.isSuited) s += 0.06;
      if (i.isBroadway && !i.isPair) s += 0.04;
      return clamp(s, 0.2, 1.0);
    },
    // BB 面对 SB 加注：3bet / 跟注 / 弃牌
    BB_VS_OPEN: function (i) {
      var p = i.pct;
      var three = 0, call = 0;
      if (p <= 0.05) three = 0.90;
      else if (p <= 0.10) three = 0.70;
      else if (p <= 0.18) three = 0.42;
      else if (p <= 0.28) three = 0.22;
      else if (i.isSuited && (i.isAx || i.isSuitedConnector || (i.isPair && i.highCard <= 7))) three = 0.20;
      else if (p <= 0.75) three = 0.07;
      else three = 0.04;

      if (p <= 0.18) call = 0.10;
      else if (p <= 0.35) call = 0.78;
      else if (p <= 0.55) call = 0.82;
      else if (p <= 0.75) call = 0.74;
      else if (p <= 0.90) call = 0.52;
      else call = 0.26;

      var tot = three + call;
      if (tot > 1) { three /= tot; call /= tot; }
      return { three: three, call: call, fold: Math.max(0, 1 - three - call) };
    },
    // BB 面对 SB limp（toCall = 0）：加注 / 过牌
    BB_VS_LIMP_RAISE: function (i) {
      var p = i.pct;
      var r;
      if (p <= 0.12) r = 0.92;
      else if (p <= 0.30) r = 0.80;
      else if (p <= 0.50) r = 0.62;
      else if (p <= 0.70) r = 0.45;
      else if (p <= 0.88) r = 0.28;
      else r = 0.15;
      if (i.isAx) r += 0.08;
      return clamp(r, 0.05, 0.95);
    },
    // 面对 3bet：4bet / 跟注 / 弃牌
    VS_3BET: function (i) {
      var p = i.pct;
      var four = 0, call = 0;
      if (p <= 0.04) four = 0.90;
      else if (p <= 0.08) four = 0.65;
      else if (p <= 0.14) four = 0.40;
      else if (i.isSuited && i.isAx) four = 0.28;         // Axs 作为 4bet 诈唬
      else if (i.isSuitedConnector) four = 0.16;
      else if (p <= 0.55) four = 0.06;

      if (p <= 0.10) call = 0.10;
      else if (p <= 0.25) call = 0.55;
      else if (p <= 0.45) call = 0.62;
      else if (p <= 0.70) call = 0.35;
      else call = 0.10;

      var tot = four + call;
      if (tot > 1) { four /= tot; call /= tot; }
      return { three: four, call: call, fold: Math.max(0, 1 - four - call) };
    },
    // 面对 4bet：5bet all-in / 跟注 / 弃牌
    VS_4BET: function (i) {
      var p = i.pct;
      var jam = 0, call = 0;
      if (p <= 0.03) jam = 0.95;
      else if (p <= 0.07) jam = 0.70;
      else if (p <= 0.12) jam = 0.35;
      else if (i.isAx && i.isSuited) jam = 0.20;
      else if (p <= 0.35) jam = 0.05;

      if (p <= 0.08) call = 0.05;
      else if (p <= 0.20) call = 0.45;
      else if (p <= 0.40) call = 0.25;
      else call = 0.03;

      var tot = jam + call;
      if (tot > 1) { jam /= tot; call /= tot; }
      return { three: jam, call: call, fold: Math.max(0, 1 - jam - call) };
    }
  };

  // ---------------- 牌面纹理分析 ----------------
  var textureCache = {};
  function analyzeBoard(board) {
    var key = board.join(',');
    if (textureCache[key]) return textureCache[key];
    var suitCount = [0, 0, 0, 0];
    var rankCount = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < board.length; i++) {
      suitCount[(board[i] / 13) | 0]++;
      rankCount[board[i] % 13]++;
    }
    var maxSuit = Math.max.apply(null, suitCount);
    var flushPossible = maxSuit >= 3;
    var flushMade = maxSuit >= 5;

    // 连牌度
    var rMask = 0;
    for (var r = 0; r < 13; r++) if (rankCount[r]) rMask |= (1 << r);
    var straightMade = false, straightDrawHeavy = false;
    for (var h = 12; h >= 4; h--) {
      var m = 0x1F << (h - 4);
      var bits = popc(rMask & m);
      if (bits === 5) straightMade = true;
      if (bits === 4) straightDrawHeavy = true;
    }
    if (popc(rMask & 0x100F) >= 4) straightDrawHeavy = true;

    var paired = false, trips = false;
    for (var r2 = 0; r2 < 13; r2++) {
      if (rankCount[r2] === 2) paired = true;
      if (rankCount[r2] >= 3) trips = true;
    }

    var high = 0;
    for (var r3 = 12; r3 >= 0; r3--) if (rankCount[r3]) { high = r3; break; }
    var lowConnected = false;
    for (var r4 = 0; r4 <= 6; r4++) if (rankCount[r4] && rankCount[r4 + 1]) lowConnected = true;

    var wet = 0;
    if (flushPossible) wet += 0.35;
    if (straightDrawHeavy) wet += 0.35;
    if (lowConnected) wet += 0.15;
    if (paired) wet -= 0.15;
    if (trips) wet -= 0.2;
    wet = clamp(wet, 0, 1);

    var t = {
      wet: wet,
      dry: 1 - wet,
      flushPossible: flushPossible,
      flushMade: flushMade,
      straightMade: straightMade,
      straightDrawHeavy: straightDrawHeavy,
      paired: paired,
      trips: trips,
      highCard: high,
      isLowBoard: high <= 7,
      isAceBoard: high === 12,
      // 谁有范围优势：A 高牌面利于翻前加注者；低牌面利于跟注者
      favorsPreflopAggressor: high >= 10 || (!lowConnected && !flushPossible)
    };
    textureCache[key] = t;
    return t;
  }

  function popc(x) { var c = 0; while (x) { x &= x - 1; c++; } return c; }

  // ---------------- 范围在牌面上的强度 ----------------
  var boardScoreCache = {};
  function boardStrengthScores(board) {
    if (board.length < 3) return null;
    var key = board.join(',');
    if (boardScoreCache[key]) return boardScoreCache[key];
    var scores = {};
    var vals = [];
    for (var i = 0; i < ALL_KEYS.length; i++) {
      var k = ALL_KEYS[i];
      var combos = EQ.combosOf(k);
      var sum = 0, n = 0;
      for (var c = 0; c < combos.length; c++) {
        var cc = combos[c];
        if (board.indexOf(cc[0]) >= 0 || board.indexOf(cc[1]) >= 0) continue;
        var all = [cc[0], cc[1]].concat(board);
        sum += PE.evalBest(all);
        n++;
      }
      var avg = n ? sum / n : 0;
      scores[k] = avg;
      vals.push(avg);
    }
    vals.sort(function (a, b) { return a - b; });
    // 转成 0..1 百分位
    var out = {};
    for (var kk in scores) {
      var v = scores[kk];
      var lo = 0, hi = vals.length - 1, pos = 0;
      // 二分查找排名
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (vals[mid] <= v) { pos = mid; lo = mid + 1; } else hi = mid - 1;
      }
      out[kk] = vals.length > 1 ? pos / (vals.length - 1) : 0.5;
    }
    boardScoreCache[key] = out;
    return out;
  }

  /**
   * 根据对手动作更新其范围
   */
  function updateRangeForAction(range, action, board, street) {
    if (!range) return range;
    var scores = board.length >= 3 ? boardStrengthScores(board) : null;
    var out = {};
    for (var k in range) {
      var w = range[k];
      if (!(w > 0)) continue;
      var s = scores ? scores[k] : (1 - keyInfo(k).pct); // 翻前用手牌原始强度
      var f;
      if (action === 'bet' || action === 'raise' || action === 'allin') {
        // 极化：强牌与听牌保留，中间牌弱化
        if (s >= 0.80) f = 1.0;
        else if (s >= 0.62) f = 0.75;
        else if (s >= 0.45) f = 0.32;
        else if (s >= 0.22) f = 0.45;     // 半诈唬
        else f = 0.12;
      } else if (action === 'call') {
        if (s >= 0.80) f = 1.0;
        else if (s >= 0.55) f = 0.95;
        else if (s >= 0.30) f = 0.85;
        else f = 0.45;                     // 弱牌跟注后仍可能（听牌）
      } else { // check
        if (s >= 0.85) f = 0.55;           // 慢打的强牌
        else if (s >= 0.60) f = 0.85;
        else if (s >= 0.30) f = 1.0;
        else f = 0.95;
      }
      var nw = w * f;
      if (nw > 0.005) out[k] = nw;
    }
    return out;
  }

  // ---------------- EV 估算 ----------------
  function estimateFoldProb(betSize, pot, oppRangeWidth, texture, street) {
    var ratio = pot > 0 ? betSize / pot : 1;
    var base = 0.10 + 0.50 * Math.min(1, ratio);
    base *= (1.18 - 0.45 * clamp(oppRangeWidth, 0, 1));
    if (texture && texture.wet > 0.45) base *= 0.85;
    if (street === 3) base *= 0.92;
    return clamp(base, 0.04, 0.85);
  }

  // 各行动 EV（单位：筹码；基准为「弃牌 = 0」）
  function evFold() { return 0; }
  function evCall(pot, toCall, equity) {
    return equity * pot - (1 - equity) * toCall;
  }
  function evCheck(pot, equity, position) {
    // 过牌保留实现权益，位置有利时略高
    var f = position === 'IP' ? 1.0 : 0.92;
    return equity * pot * f;
  }
  // 被对手加注的概率（下注/加注越大越容易被反击）
  function raiseRiskOf(size, pot) {
    return clamp(0.07 + 0.10 * (pot > 0 ? size / pot : 1), 0, 0.28);
  }

  function evBet(betSize, pot, equity, oppRangeWidth, texture, street) {
    var fp = estimateFoldProb(betSize, pot, oppRangeWidth, texture, street);
    var eqCalled = clamp(equity * 0.82, 0.02, 0.98); // 被跟注时对手范围更强
    var called = eqCalled * (pot + betSize) - (1 - eqCalled) * betSize;
    var rr = raiseRiskOf(betSize, pot);
    var raised = -betSize * 0.6;           // 被加注后多数要弃牌，损失已投入的注
    return fp * pot + (1 - fp) * ((1 - rr) * called + rr * raised);
  }
  function evRaise(raiseTo, pot, toCall, equity, oppRangeWidth, texture, street) {
    // raiseTo = 本轮加注后的总投入（含已有的 toCall）
    var additional = raiseTo - toCall;
    var potAfterCall = pot + toCall;
    var fp = estimateFoldProb(additional, potAfterCall, oppRangeWidth, texture, street) * 0.95;
    var eqCalled = clamp(equity * 0.80, 0.02, 0.98);
    var win = pot + toCall + additional;  // 赢时净得（不含自己本次投入）
    var called = eqCalled * win - (1 - eqCalled) * raiseTo;
    var rr = raiseRiskOf(additional, potAfterCall);
    var reRaised = -raiseTo * 0.55;
    return fp * pot + (1 - fp) * ((1 - rr) * called + rr * reRaised);
  }

  // ---------------- 预翻牌决策 ----------------
  function decidePreflop(state) {
    var options = [];
    var reasons = [];
    var info = keyInfo(state.holeKey);
    var raises = state.raisesThisStreet || 0;
    var toCall = state.toCall;
    var pot = state.pot;
    var bb = state.bb || 2;
    var isFirstActor = state.isFirstActorPreflop; // SB（按钮）
    var stack = state.myStack;

    function push(action, freq, size, note) {
      if (freq <= 0.001) return;
      options.push({ action: action, size: size || 0, freq: freq, note: note || '' });
    }

    // 计算各行动 EV（预翻牌用 equity 近似）
    var eqVsRange = state.equity;

    if (raises === 0 && toCall > 0 && isFirstActor) {
      // --- SB 开局 ---
      var playW = RANGES.SB_PLAY[state.holeKey] || 0;
      var raiseShare = RANGES.SB_RAISE_SHARE(info);
      var openSize = Math.min(bb * 2.5, stack + toCall); // 加注到 2.5bb
      var raiseTo = bb * 2.5;
      var limpW = playW * (1 - raiseShare);
      var raiseW = playW * raiseShare;
      var foldW = Math.max(0, 1 - playW);

      var evR = evBet(raiseTo - toCall, pot, eqVsRange, 0.85, null, 0);
      var evL = evCall(pot, toCall, eqVsRange);

      push('raise', raiseW, raiseTo, '开池加注 2.5bb，夺取主动权与范围优势');
      push('call', limpW, toCall, '跟注补盲（limp），以小代价看翻牌');
      push('fold', foldW, 0, '弃牌，手牌太弱不值得投入');

      reasons.push('你在按钮位（小盲）翻前先行动，heads-up 中开局范围极宽，约 ' + Math.round(playW * 100) + '% 的手牌可玩。');
      reasons.push('这手牌胜率 ' + pct(eqVsRange) + '，全范围排名 ' + info.rank + '/169（前 ' + Math.round(info.pct * 100) + '%）。');
      if (raiseShare > 0.7) reasons.push('牌力较强，加注能同时拿到价值与主动权。');
      else if (raiseShare < 0.5) reasons.push('中等偏弱牌，混合使用加注与 limp 更接近 GTO。');
    } else if (raises === 0 && toCall === 0) {
      // --- BB 面对 SB limp ---
      var rW = RANGES.BB_VS_LIMP_RAISE(info);
      var sz = Math.max(bb * 2, Math.min(bb * 3, pot + bb * 2));
      var raiseTo2 = bb * 3;
      push('raise', rW, raiseTo2, '对手示弱（limp），加注惩罚并接管主动权');
      push('check', 1 - rW, 0, '过牌，用宽范围便宜看翻牌');
      reasons.push('对手 limp 显示范围偏弱，你可以用较宽的范围加注施压。');
      reasons.push('这手牌排名 ' + info.rank + '/169，加注频率约 ' + Math.round(rW * 100) + '%。');
    } else if (raises === 1) {
      // --- 面对开池加注 ---
      var m = RANGES.BB_VS_OPEN(info);
      if (state.isButton) {
        // 按钮位（SB）面对加注时有位置优势，防守范围更宽、3bet 略增
        m = renormalize({ three: m.three * 1.15, call: m.call * 1.22, fold: m.fold * 0.55 });
      }
      var threeTo = Math.round((state.lastRaiseTo || (bb * 2.5)) * 3);
      threeTo = Math.max(bb * 6, threeTo);
      push('raise', m.three, threeTo, '3bet：强牌拿价值 / 合适牌型做诈唬');
      push('call', m.call, toCall, '跟注：底池赔率好，位置/赔率支持宽防守');
      push('fold', m.fold, 0, '弃牌：这手牌在面对开池范围时权益不足');
      var potOdds = toCall / (pot + toCall);
      reasons.push('底池赔率 ' + pct(potOdds) + '，你的胜率 ' + pct(eqVsRange) + '，' +
        (eqVsRange > potOdds ? '权益足够继续。' : '权益不足，需要考虑位置与实现度。'));
      reasons.push('heads-up 大盲面对开池防守范围很宽（约 80%+），3bet 约占 20% 且要极化。');
    } else if (raises === 2) {
      var m2 = RANGES.VS_3BET(info);
      if (state.isButton) {
        m2 = renormalize({ three: m2.three, call: m2.call * 1.15, fold: m2.fold * 0.8 });
      }
      var fourTo = Math.round((state.lastRaiseTo || (bb * 6)) * 2.4);
      push('raise', m2.three, fourTo, '4bet：价值或阻断牌型诈唬');
      push('call', m2.call, toCall, '跟注：在有利赔率下实现权益');
      push('fold', m2.fold, 0, '弃牌：对手 3bet 范围强，这手牌难以实现权益');
      reasons.push('面对 3bet 时范围需要收紧，4bet 应当极化（强牌 + Axs 类诈唬）。');
    } else {
      var m3 = RANGES.VS_4BET(info);
      push('allin', m3.three, stack + toCall, '5bet all-in');
      push('call', m3.call, toCall, '跟注');
      push('fold', m3.fold, 0, '弃牌');
      reasons.push('面对 4bet，决策基本收敛为 all-in 或弃牌，只保留极少量跟注。');
    }

    return finalize(options, reasons, state, eqVsRange);
  }

  // ---------------- 翻牌后决策 ----------------
  function decidePostflop(state) {
    var options = [];
    var reasons = [];
    var pot = state.pot;
    var toCall = state.toCall;
    var equity = state.equity;
    var board = state.board;
    var street = state.street;
    var texture = analyzeBoard(board);
    var stack = state.myStack;
    var oppWidth = state.oppRangeWidth || 0.5;
    var position = state.position;
    var handDesc = PE.describeHand(state.hole, board);
    var spr = pot > 0 ? stack / pot : 99;

    function push(action, freq, size, note) {
      if (freq <= 0.001) return;
      options.push({ action: action, size: size || 0, freq: freq, note: note || '' });
    }

    if (toCall > 0) {
      // ---- 面对下注 ----
      var potOdds = toCall / (pot + toCall);
      var evC = evCall(pot, toCall, equity);
      var evF = 0;

      // 候选加注尺度
      var raiseSizes = candidateRaiseSizes(state, pot, toCall);
      var raiseEVs = raiseSizes.map(function (s) {
        return evRaise(s, pot, toCall, equity, oppWidth, texture, street);
      });

      // 决策频率
      var foldF = 0, callF = 0, raiseF = 0;
      var edge = equity - potOdds;

      if (edge < -0.12) {
        foldF = 0.85; callF = 0.13; raiseF = 0.02;
      } else if (edge < -0.05) {
        foldF = 0.62; callF = 0.33; raiseF = 0.05;
      } else if (edge < 0.02) {
        foldF = 0.30; callF = 0.62; raiseF = 0.08;
      } else if (edge < 0.12) {
        foldF = 0.08; callF = 0.72; raiseF = 0.20;
      } else {
        foldF = 0.02; callF = 0.48; raiseF = 0.50;
      }

      // 修正项
      if (equity > 0.78) { raiseF += 0.22; callF -= 0.18; foldF = Math.max(0, foldF - 0.04); } // 强牌多拿价值
      if (spr < 1.2) { callF += 0.12; raiseF -= 0.06; }   // 短筹码更倾向跟注/全下
      if (position === 'OOP') { callF += 0.08; raiseF -= 0.06; } // 不利位置更多过牌跟注
      if (texture.wet > 0.6 && equity < 0.5) { raiseF += 0.06; } // 湿润牌面半诈唬
      if (street === 3 && equity > 0.85) { raiseF += 0.15; callF -= 0.12; } // 河牌坚果加注

      var tot = foldF + callF + raiseF;
      foldF /= tot; callF /= tot; raiseF /= tot;

      push('fold', foldF, 0, '权益不足以支付这个价格');
      push('call', callF, toCall, '权益与底池赔率匹配，继续实现权益');
      push('raise', raiseF, raiseSizes[bestIdx(raiseEVs)], '加注：价值加注或半诈唬施压');

      // EV 写入
      setEV(options, 'fold', evF);
      setEV(options, 'call', evC);
      setEV(options, 'raise', raiseEVs[bestIdx(raiseEVs)]);

      reasons.push('底池赔率 ' + pct(potOdds) + '，你需要在 ' + pct(potOdds) + ' 以上胜率才能保本跟注。');
      reasons.push('当前胜率 ' + pct(equity) + '（' + handDesc + '），' +
        (equity > potOdds ? '高于' : '低于') + '底池赔率 ' + pct(Math.abs(equity - potOdds)) + '。');
      if (edge < -0.05) reasons.push('这是一手偏弱的牌，多数情况下应该弃牌，只有少量跟注/诈唬加注保留平衡。');
      else if (edge > 0.12) reasons.push('权益明显领先，应该提高加注频率去拿价值，慢打只用一小部分。');
      else reasons.push('这是边缘牌，GTO 会混合使用跟注与弃牌，避免可被剥削的单一打法。');
      if (position === 'OOP') reasons.push('你在不利位置，策略偏向过牌-跟注与过牌-加注。');
      else reasons.push('你在有利位置，可以更主动地控制底池与下注频率。');
    } else {
      // ---- 主动下注 / 过牌 ----
      var betSizes = candidateBetSizes(state, pot);
      var evCheckVal = evCheck(pot, equity, position);
      var betEVs = betSizes.map(function (s) {
        return evBet(s, pot, equity, oppWidth, texture, street);
      });

      // 总下注频率：基于权益 + 牌面 + 是否翻前加注者
      var betFreq;
      if (equity >= 0.68) betFreq = 0.85;
      else if (equity >= 0.55) betFreq = 0.72;
      else if (equity >= 0.45) betFreq = 0.60;
      else if (equity >= 0.33) betFreq = 0.48;
      else if (equity >= 0.22) betFreq = 0.38;
      else betFreq = 0.30;

      if (state.isPreflopAggressor) betFreq += texture.favorsPreflopAggressor ? 0.10 : -0.04;
      if (texture.paired) betFreq -= 0.05;
      if (position === 'OOP' && !state.isPreflopAggressor) betFreq -= 0.08;
      if (street === 3) {
        // 河牌走向极化
        if (equity >= 0.75 || equity <= 0.20) betFreq += 0.10;
        else betFreq -= 0.12;
      }
      betFreq = clamp(betFreq, 0.10, 0.92);

      // 尺度分配：EV 越高权重越大（softmax）
      var weights = softmax(betEVs, 1.6);
      push('check', 1 - betFreq, 0, '过牌：控制底池 / 埋伏 / 保留实现权益');
      for (var i = 0; i < betSizes.length; i++) {
        if (weights[i] < 0.05) continue;
        push('bet', betFreq * weights[i], betSizes[i], '下注 ' + Math.round(betSizes[i] / pot * 100) + '% 底池');
      }
      setEV(options, 'check', evCheckVal);
      // 下注 EV 用最高的一档
      var bi = bestIdx(betEVs);
      setEV(options, 'bet', betEVs[bi]);

      reasons.push('你的胜率 ' + pct(equity) + '（' + handDesc + '），建议下注频率约 ' + Math.round(betFreq * 100) + '%。');
      reasons.push('牌面' + (texture.wet > 0.5 ? '较湿润（有听牌可能）' : '较干燥') +
        (texture.paired ? '且已成对' : '') + '，' +
        (texture.wet > 0.5 ? '下注尺度应偏大以保护权益。' : '可用小尺度高频下注。'));
      if (state.isPreflopAggressor && texture.favorsPreflopAggressor) {
        reasons.push('你是翻前加注者且牌面利于你的范围，可以高频持续下注（c-bet）。');
      } else if (!state.isPreflopAggressor) {
        reasons.push('你不是翻前的主动方，范围没有优势，应减少主动下注、多用 check-call。');
      }
      if (street === 3) reasons.push('河牌圈策略应极化：强牌下注拿价值，弱牌只能作为诈唬下注，中等牌力过牌。');
    }

    return finalize(options, reasons, state, equity, texture, spr);
  }

  function softmax(arr, temp) {
    var mx = Math.max.apply(null, arr);
    var ex = arr.map(function (v) { return Math.exp((v - mx) / temp); });
    var s = ex.reduce(function (a, b) { return a + b; }, 0);
    return ex.map(function (v) { return v / s; });
  }
  function bestIdx(arr) {
    var bi = 0;
    for (var i = 1; i < arr.length; i++) if (arr[i] > arr[bi]) bi = i;
    return bi;
  }
  function setEV(options, action, ev) {
    for (var i = 0; i < options.length; i++) if (options[i].action === action) { options[i].ev = ev; return; }
  }

  function candidateBetSizes(state, pot) {
    var stack = state.myStack;
    var raw = [0.33, 0.66, 1.0];
    if (state.street === 3) raw.push(1.5);
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var s = Math.max(state.bb || 2, Math.round(pot * raw[i]));
      s = Math.min(s, stack);
      if (s > 0 && out.indexOf(s) < 0) out.push(s);
    }
    if (!out.length) out.push(Math.min(stack, state.bb || 2));
    return out;
  }

  function candidateRaiseSizes(state, pot, toCall) {
    var stack = state.myStack;
    var base = pot + toCall;
    var raw = [2.2, 3.0];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var s = Math.round((state.lastRaiseTo || toCall) * raw[i]);
      s = Math.max(s, Math.round(base * 0.75) + toCall);
      s = Math.min(s, stack + toCall);
      if (s > toCall && out.indexOf(s) < 0) out.push(s);
    }
    // 全下选项（短码时）
    var allin = stack + toCall;
    if (allin > toCall && out.indexOf(allin) < 0 && stack < pot * 2) out.push(allin);
    if (!out.length) out.push(Math.min(stack + toCall, toCall * 2));
    return out;
  }

  // ---------------- 汇总输出 ----------------
  function finalize(options, reasons, state, equity, texture, spr) {
    // 归一化频率
    var total = 0;
    options.forEach(function (o) { total += o.freq; });
    if (total > 0) options.forEach(function (o) { o.freq = o.freq / total; });

    // 主行动：EV 最高的（若无 EV 则取频率最高的）
    var primary = null;
    for (var i = 0; i < options.length; i++) {
      var o = options[i];
      if (o.ev === undefined) o.ev = estimateMissingEV(o, state, equity);
      if (!primary || o.ev > primary.ev) primary = o;
    }
    if (!primary && options.length) primary = options[0];

    options.sort(function (a, b) { return b.freq - a.freq; });

    return {
      options: options,
      primary: primary ? { action: primary.action, size: primary.size } : null,
      equity: equity,
      potOdds: state.toCall > 0 ? state.toCall / (state.pot + state.toCall) : 0,
      texture: texture || null,
      spr: spr,
      reasons: reasons,
      handDesc: state.hole && state.board ? PE.describeHand(state.hole, state.board) : ''
    };
  }

  function estimateMissingEV(o, state, equity) {
    if (o.action === 'fold') return 0;
    if (o.action === 'check') return equity * state.pot * 0.95;
    if (o.action === 'call') return evCall(state.pot, state.toCall, equity);
    return evBet(o.size, state.pot, equity, state.oppRangeWidth || 0.5, null, state.street);
  }

  function pct(v) { return (v * 100).toFixed(1) + '%'; }

  // ---------------- 对外主入口 ----------------
  /**
   * @param {Object} state 牌局快照（见 engine.js buildDecisionState）
   * @returns {Object} GTO 建议
   */
  function decide(state) {
    var res = state.street === 0 ? decidePreflop(state) : decidePostflop(state);
    res.street = state.street;
    return res;
  }

  /**
   * AI 按 GTO 频率选择行动
   * @param {Object} state
   * @param {Object} advice decide() 的结果
   * @param {string} difficulty 'easy' | 'standard' | 'gto'
   */
  function chooseAction(state, advice, difficulty) {
    var opts = adjustForDifficulty(advice.options, difficulty, state);
    var r = Math.random();
    var acc = 0;
    for (var i = 0; i < opts.length; i++) {
      acc += opts[i].freq;
      if (r <= acc) return opts[i];
    }
    return opts[opts.length - 1];
  }

  /**
   * 难度调整：低难度 AI 更少诈唬、更被动、尺度单一
   */
  function adjustForDifficulty(options, difficulty, state) {
    var out = options.map(function (o) { return { action: o.action, size: o.size, freq: o.freq, note: o.note, ev: o.ev }; });
    if (difficulty === 'gto') return normalize(out);

    if (difficulty === 'easy') {
      out.forEach(function (o) {
        // 弱化诈唬与加注，强化跟注/过牌
        if (o.action === 'raise' || (o.action === 'bet' && state.equity < 0.45)) o.freq *= 0.35;
        if (o.action === 'check') o.freq *= 1.5;
        if (o.action === 'call') o.freq *= 1.4;
        if (o.action === 'fold' && state.equity < 0.3) o.freq *= 1.6;
      });
      // 尺度单一化：只用中等尺度
      var bets = out.filter(function (o) { return o.action === 'bet'; });
      if (bets.length > 1) {
        bets.sort(function (a, b) { return a.size - b.size; });
        var keep = bets[Math.floor(bets.length / 2)];
        bets.forEach(function (b) { if (b !== keep) b.freq = 0; });
      }
      var raises = out.filter(function (o) { return o.action === 'raise'; });
      if (raises.length > 1) {
        raises.sort(function (a, b) { return a.size - b.size; });
        var keepR = raises[0];
        raises.forEach(function (b) { if (b !== keepR) b.freq = 0; });
      }
    } else if (difficulty === 'standard') {
      out.forEach(function (o) {
        if (o.action === 'raise' && state.equity < 0.35) o.freq *= 0.6;
        if (o.action === 'bet' && state.equity < 0.25) o.freq *= 0.7;
      });
    }
    return normalize(out.filter(function (o) { return o.freq > 0.001; }));
  }

  function normalize(arr) {
    var t = 0;
    arr.forEach(function (o) { t += o.freq; });
    if (t <= 0) { arr[0].freq = 1; return arr; }
    arr.forEach(function (o) { o.freq /= t; });
    return arr;
  }

  root.GTO = {
    decide: decide,
    chooseAction: chooseAction,
    adjustForDifficulty: adjustForDifficulty,
    keyInfo: keyInfo,
    ALL_KEYS: ALL_KEYS,
    RANGES: RANGES,
    analyzeBoard: analyzeBoard,
    updateRangeForAction: updateRangeForAction,
    boardStrengthScores: boardStrengthScores,
    estimateFoldProb: estimateFoldProb,
    normalize: normalize
  };
})(typeof self !== 'undefined' ? self : globalThis);
