/*
 * recorder.js — 牌局记录、回看、分享与复盘分析
 */
(function (root) {
  'use strict';
  var PE = root.PokerEval;
  var STREET_NAMES = ['翻牌前', '翻牌', '转牌', '河牌'];
  var ACTION_NAMES = {
    fold: '弃牌', check: '过牌', call: '跟注', bet: '下注', raise: '加注', allin: '全下'
  };
  var ACTION_IDS = ['fold', 'check', 'call', 'bet', 'raise', 'allin'];

  // ---------------- 序列化 ----------------
  /**
   * @param {boolean} full 是否包含 GTO 建议明细（本地存档用 true，分享码用 false）
   */
  function serialize(game, full) {
    return {
      v: 1,
      bb: game.bb,
      stack: game.startStack,
      difficulty: game.difficulty,
      savedAt: Date.now(),
      hands: game.hands.map(function (h) {
        return {
          n: h.no,
          b: h.button,
          h: h.heroCards,
          a: h.aiCards,
          bd: h.board,
          sr: h.streetReached,
          r: {
            w: h.result.winner,
            f: h.result.byFold ? 1 : 0,
            hn: h.result.heroNet,
            an: h.result.aiNet,
            p: h.result.pot,
            hd: h.result.heroHandDesc,
            ad: h.result.aiHandDesc
          },
          ac: h.actions.map(function (x) {
            var arr = [
              x.street,
              x.seat,
              ACTION_IDS.indexOf(x.action),
              x.size,
              x.raiseTo || 0,
              Math.round(x.equity * 1000),
              Math.round(x.potOdds * 1000),
              Math.round((x.potBefore || 0) * 10),
              x.toCall || 0,
              x.stackBefore || 0
            ];
            if (full) {
              arr.push({
                o: (x.options || []).map(function (o) {
                  return [ACTION_IDS.indexOf(o.action), o.size || 0, Math.round((o.freq || 0) * 1000), Math.round((o.ev || 0) * 100)];
                }),
                p: x.primary ? [ACTION_IDS.indexOf(x.primary.action), x.primary.size || 0] : null,
                r: x.reasons || [],
                hd: x.handDesc || '',
                hole: x.hole || [],
                board: x.board || []
              });
            }
            return arr;
          })
        };
      })
    };
  }

  function deserialize(data) {
    if (!data || !data.hands) return null;
    return {
      v: data.v,
      bb: data.bb || 2,
      stack: data.stack || 200,
      difficulty: data.difficulty || 'standard',
      savedAt: data.savedAt,
      hands: data.hands.map(function (h) {
        return {
          no: h.n,
          button: h.b,
          heroCards: h.h,
          aiCards: h.a,
          board: h.bd || [],
          streetReached: h.sr || 0,
          result: {
            winner: h.r.w,
            byFold: !!h.r.f,
            heroNet: h.r.hn,
            aiNet: h.r.an,
            pot: h.r.p,
            heroHandDesc: h.r.hd,
            aiHandDesc: h.r.ad
          },
          actions: (h.ac || []).map(function (x) {
            var full = x[10];
            return {
              street: x[0],
              seat: x[1],
              action: ACTION_IDS[x[2]] || 'check',
              size: x[3],
              raiseTo: x[4],
              equity: x[5] / 1000,
              potOdds: x[6] / 1000,
              potBefore: x[7] / 10,
              toCall: x[8],
              stackBefore: x[9],
              options: full ? (full.o || []).map(function (o) {
                return { action: ACTION_IDS[o[0]] || 'check', size: o[1], freq: o[2] / 1000, ev: o[3] / 100 };
              }) : null,
              primary: full && full.p ? { action: ACTION_IDS[full.p[0]] || 'check', size: full.p[1] } : null,
              reasons: full ? (full.r || []) : [],
              handDesc: full ? (full.hd || '') : '',
              hole: full ? (full.hole || []) : [],
              board: full ? (full.board || []) : []
            };
          })
        };
      })
    };
  }

  // ---------------- base64url ----------------
  function bytesToB64u(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    var b64 = (typeof btoa === 'function') ? btoa(s) : Buffer.from(bytes).toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64uToBytes(str) {
    var b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    if (typeof atob === 'function') {
      var s = atob(b64);
      var out = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }

  // ---------------- 分享码（压缩 + base64url） ----------------
  function canCompress() {
    return typeof CompressionStream === 'function';
  }

  async function compressBytes(bytes) {
    if (!canCompress()) return null;
    try {
      var cs = new CompressionStream('deflate-raw');
      var w = cs.writable.getWriter();
      w.write(bytes);
      w.close();
      var out = await new Response(cs.readable).arrayBuffer();
      return new Uint8Array(out);
    } catch (e) {
      return null;
    }
  }

  async function decompressBytes(bytes) {
    if (typeof DecompressionStream !== 'function') return null;
    try {
      var ds = new DecompressionStream('deflate-raw');
      var w = ds.writable.getWriter();
      w.write(bytes);
      w.close();
      var out = await new Response(ds.readable).arrayBuffer();
      return new Uint8Array(out);
    } catch (e) {
      return null;
    }
  }

  /**
   * 生成分享码。前缀 G 表示压缩，P 表示未压缩
   */
  async function toShareCode(game) {
    var json = JSON.stringify(serialize(game));
    var bytes = new TextEncoder().encode(json);
    var comp = await compressBytes(bytes);
    var prefix, payload;
    if (comp && comp.length < bytes.length) {
      prefix = 'G'; payload = comp;
    } else {
      prefix = 'P'; payload = bytes;
    }
    return prefix + bytesToB64u(payload);
  }

  async function fromShareCode(code) {
    code = (code || '').trim();
    if (!code) return null;
    var prefix = code[0];
    var body = code.slice(1);
    var bytes = b64uToBytes(body);
    var json;
    if (prefix === 'G') {
      var dec = await decompressBytes(bytes);
      if (!dec) throw new Error('当前浏览器不支持解压该分享码');
      json = new TextDecoder().decode(dec);
    } else {
      json = new TextDecoder().decode(bytes);
    }
    return deserialize(JSON.parse(json));
  }

  function toJSONFile(game) {
    return JSON.stringify(serialize(game), null, 2);
  }
  function fromJSONFile(text) {
    return deserialize(JSON.parse(text));
  }

  // ---------------- 文字战报（便于粘贴分享） ----------------
  function toSummaryText(game) {
    var bb = game.bb;
    var lines = [];
    lines.push('德州扑克 GTO 练习 — 牌局记录');
    lines.push('级别: ' + (bb / 2) + '/' + bb + ' | 起始筹码: ' + game.startStack + ' | AI 难度: ' + (game.difficulty || 'standard'));
    lines.push('手牌数: ' + game.hands.length);
    lines.push('');
    game.hands.forEach(function (h) {
      var btn = h.button === 0 ? '玩家' : 'AI';
      lines.push('—— 第 ' + h.no + ' 手（按钮: ' + btn + '）——');
      lines.push('玩家: ' + h.heroCards.map(PE.cardText).join(' ') + '   AI: ' + h.aiCards.map(PE.cardText).join(' '));
      var curStreet = -1;
      h.actions.forEach(function (a) {
        if (a.street !== curStreet) {
          curStreet = a.street;
          var b = h.board.slice(0, a.street === 0 ? 0 : (a.street === 1 ? 3 : (a.street === 2 ? 4 : 5)));
          lines.push('  [' + STREET_NAMES[a.street] + ']' + (b.length ? ' ' + b.map(PE.cardText).join(' ') : ''));
        }
        var who = a.seat === 0 ? '玩家' : 'AI  ';
        var sz = a.size > 0 ? ' ' + a.size : '';
        lines.push('    ' + who + ' ' + (ACTION_NAMES[a.action] || a.action) + sz +
          ' [胜率 ' + (a.equity * 100).toFixed(0) + '%]');
      });
      if (h.board.length) lines.push('  公共牌: ' + h.board.map(PE.cardText).join(' '));
      var r = h.result;
      var resTxt = r.winner === 0 ? '玩家胜' : (r.winner === 1 ? 'AI 胜' : '平局');
      lines.push('  结果: ' + resTxt + (r.byFold ? '（对手弃牌）' : '') +
        ' | 底池 ' + r.pot + ' | 玩家净 ' + (r.heroNet >= 0 ? '+' : '') + r.heroNet.toFixed(0) +
        (r.byFold ? '' : '（' + (r.heroHandDesc || '') + ' vs ' + (r.aiHandDesc || '') + '）'));
      lines.push('');
    });
    var tot = game.hands.reduce(function (s, h) { return s + h.result.heroNet; }, 0);
    lines.push('玩家总盈亏: ' + (tot >= 0 ? '+' : '') + tot.toFixed(0) + '（' + (tot / bb).toFixed(1) + ' BB）');
    return lines.join('\n');
  }

  // ---------------- 复盘分析 ----------------
  /**
   * 为一条动作记录匹配 GTO 选项
   * @returns {{opt:Object, target:string, gap:number, refSize:number}|null}
   *  gap = 玩家实际额度与最接近的 GTO 选项之间的差距（筹码）
   */
  function matchOptionDetailed(options, rec) {
    if (!options || !options.length) return null;
    var target = rec.action;
    if (target === 'allin') {
      // all-in 可能是「加注型」也可能是「跟注型」
      target = (rec.raiseTo > 0 && rec.raiseTo > (rec.toCall || 0)) ? 'raise' : 'call';
    }
    var cands = options.filter(function (o) { return o.action === target; });
    if (!cands.length) cands = options;
    var refSize = (target === 'raise' || target === 'bet') ? (rec.raiseTo || rec.size) : rec.size;
    var best = cands[0], bestDiff = Infinity;
    cands.forEach(function (o) {
      var d = Math.abs((o.size || 0) - refSize);
      if (d < bestDiff) { bestDiff = d; best = o; }
    });
    return { opt: best, target: target, gap: bestDiff, refSize: refSize, cands: cands };
  }

  function matchOption(options, rec) {
    var m = matchOptionDetailed(options, rec);
    return m ? m.opt : null;
  }

  /**
   * 分析单个决策点
   */
  function analyzeDecision(rec, bb) {
    if (!rec.options || !rec.options.length) return null;
    var bbv = bb || 2;
    var m = matchOptionDetailed(rec.options, rec);
    var chosen = m ? m.opt : null;
    var best = null, bestIdx = -1;
    rec.options.forEach(function (o, i) {
      if (!best || (o.ev || 0) > (best.ev || 0)) { best = o; bestIdx = i; }
    });
    var chosenIdx = chosen ? rec.options.indexOf(chosen) : -1;

    var evLossChips = (best.ev || 0) - (chosen ? (chosen.ev || 0) : 0);
    var evLossBB = evLossChips / bbv;

    var chosenFreq = chosen ? chosen.freq : 0;
    var primary = rec.primary || { action: best.action, size: best.size };

    var maxFreq = 0;
    rec.options.forEach(function (o) { if ((o.freq || 0) > maxFreq) maxFreq = o.freq || 0; });
    var relFreq = maxFreq > 0 ? chosenFreq / maxFreq : 0;

    // 行动方向是否与 GTO 选项一致（all-in 已归一化为 raise / call）
    var actionMatched = !!m && rec.options.indexOf(m.opt) >= 0 &&
      (m.target === 'call' || m.target === 'fold' || m.target === 'check' || m.target === 'raise' || m.target === 'bet');
    var sameAction = !!m && actionMatched;
    // 额度是否落在 GTO 建议的尺度附近（1 个 bb 内视为一致）
    var sizeGapBB = m ? m.gap / bbv : 99;
    var sizeMatched = sizeGapBB < 0.6;

    // 分级原则：GTO 是混合策略，选到低频分支本身不是错误。
    // 因此只有「行动方向偏离」或「尺度明显偏离」才计入失误。
    var level, levelText;
    if (sameAction && sizeMatched && chosenIdx === bestIdx) {
      level = 'best'; levelText = '最优';
    } else if (sameAction && sizeMatched && relFreq >= 0.55) {
      level = 'mixed'; levelText = '主流打法';
    } else if (sameAction && sizeMatched && chosenFreq >= 0.15) {
      level = 'fine'; levelText = '可选分支';
    } else if (sameAction && !sizeMatched) {
      // 方向对但尺度不对：算轻微偏离，并给出建议尺度
      if (evLossBB >= 0.8) { level = 'minor'; levelText = '尺度偏离'; }
      else { level = 'fine'; levelText = '尺度可优化'; }
    } else if (evLossBB >= 4) {
      level = 'severe'; levelText = '严重偏离';
    } else if (evLossBB >= 1.5) {
      level = 'error'; levelText = '偏离';
    } else if (evLossBB >= 0.3) {
      level = 'minor'; levelText = '小偏离';
    } else {
      level = 'fine'; levelText = '可选分支';
    }
    var isMistake = (level === 'minor' && levelText !== '尺度可优化') || level === 'error' || level === 'severe';

    return {
      street: rec.street,
      streetName: STREET_NAMES[rec.street],
      seat: rec.seat,
      action: rec.action,
      actionName: ACTION_NAMES[rec.action] || rec.action,
      size: rec.size,
      raiseTo: rec.raiseTo,
      equity: rec.equity,
      potOdds: rec.potOdds,
      potBefore: rec.potBefore,
      toCall: rec.toCall,
      handDesc: rec.handDesc,
      reasons: rec.reasons || [],
      hole: rec.hole,
      board: rec.board,
      options: rec.options,
      chosen: chosen,
      best: best,
      primary: primary,
      chosenFreq: chosenFreq,
      maxFreq: maxFreq,
      evLossBB: evLossBB,
      level: level,
      levelText: levelText,
      isMistake: isMistake,
      sizeGapBB: sizeGapBB,
      sizeMatched: sizeMatched
    };
  }

  /**
   * 生成整场复盘报告
   */
  function buildReport(game) {
    var bb = game.bb || 2;
    var hands = game.hands || [];
    var report = {
      handCount: hands.length,
      hands: [],
      stats: {},
      totalEvLossBB: 0,
      mistakeCounts: { best: 0, mixed: 0, fine: 0, minor: 0, error: 0, severe: 0 }
    };

    var vpipHands = 0, pfrHands = 0, showdownHands = 0, wtsdHands = 0;
    var bets = 0, raises = 0, calls = 0, folds = 0, checks = 0;
    var heroFoldsPreflop = 0, heroPreflopDecisions = 0;
    var totalNet = 0;

    hands.forEach(function (h) {
      var heroActions = (h.actions || []).filter(function (a) { return a.seat === 0; });
      var preflop = heroActions.filter(function (a) { return a.street === 0; });
      var sawFlop = (h.actions || []).some(function (a) { return a.street >= 1; });

      var voluntarily = preflop.some(function (a) {
        return a.action === 'call' || a.action === 'raise' || a.action === 'bet' || a.action === 'allin';
      });
      var raised = preflop.some(function (a) {
        return a.action === 'raise' || a.action === 'bet' || a.action === 'allin';
      });
      if (voluntarily) vpipHands++;
      if (raised) pfrHands++;
      if (h.result && !h.result.byFold) showdownHands++;
      if (sawFlop && h.result && !h.result.byFold) wtsdHands++;

      var decisions = [];
      var handLoss = 0;
      var handMistakes = 0;
      (h.actions || []).forEach(function (a) {
        if (a.seat === 0) {
          if (a.action === 'bet' || a.action === 'raise' || a.action === 'allin') { bets += (a.action === 'bet' ? 1 : 0); raises += (a.action === 'raise' || a.action === 'allin' ? 1 : 0); }
          if (a.action === 'call') calls++;
          if (a.action === 'fold') folds++;
          if (a.action === 'check') checks++;
          if (a.street === 0) {
            heroPreflopDecisions++;
            if (a.action === 'fold') heroFoldsPreflop++;
          }
        }
        var an = analyzeDecision(a, bb);
        if (an && an.seat === 0) {
          decisions.push(an);
          // 只统计「偏离 GTO」造成的损失；选到 GTO 低频分支属于正常混合，不计为损失
          if (an.isMistake) {
            handLoss += Math.max(0, an.evLossBB);
            handMistakes++;
          }
          report.mistakeCounts[an.level] = (report.mistakeCounts[an.level] || 0) + 1;
        }
      });

      totalNet += (h.result ? h.result.heroNet : 0);
      report.totalEvLossBB += handLoss;
      report.hands.push({
        no: h.no,
        button: h.button,
        heroCards: h.heroCards,
        aiCards: h.aiCards,
        board: h.board,
        result: h.result,
        decisions: decisions,
        evLossBB: handLoss,
        mistakes: handMistakes,
        actions: h.actions
      });
    });

    report.stats = {
      vpip: hands.length ? vpipHands / hands.length : 0,
      pfr: hands.length ? pfrHands / hands.length : 0,
      showdownRate: hands.length ? showdownHands / hands.length : 0,
      wtsd: hands.length ? wtsdHands / hands.length : 0,
      af: calls > 0 ? (bets + raises) / calls : (bets + raises),
      foldToNothing: heroPreflopDecisions ? heroFoldsPreflop / heroPreflopDecisions : 0,
      totalNet: totalNet,
      totalNetBB: totalNet / bb,
      actionCounts: { bet: bets, raise: raises, call: calls, fold: folds, check: checks }
    };
    return report;
  }

  /**
   * 构建可用于逐步回看的帧序列
   * 每帧 = 某一个动作发生「之前」的桌面快照 + 该动作
   */
  function buildReplayFrames(hand) {
    var frames = [];
    var board = [];
    var committed = [0, 0];
    var bb = 2;
    // 还原盲注
    var sbSeat = hand.button;
    committed[sbSeat] = 1;
    committed[1 - sbSeat] = 2;

    frames.push({
      index: 0,
      type: 'deal',
      street: 0,
      board: [],
      heroCards: hand.heroCards,
      aiCards: hand.aiCards,
      pot: 3,
      committed: committed.slice(),
      text: '发牌：' + PE.cardText(hand.heroCards[0]) + ' ' + PE.cardText(hand.heroCards[1])
    });

    var street = -1;
    (hand.actions || []).forEach(function (a, i) {
      if (a.street !== street) {
        street = a.street;
        var nb = hand.board.slice(0, street === 0 ? 0 : (street === 1 ? 3 : (street === 2 ? 4 : 5)));
        if (street > 0) {
          frames.push({
            index: frames.length,
            type: 'street',
            street: street,
            board: nb.slice(),
            heroCards: hand.heroCards,
            aiCards: hand.aiCards,
            pot: committed[0] + committed[1],
            committed: committed.slice(),
            text: STREET_NAMES[street] + '：' + nb.map(PE.cardText).join(' ')
          });
        }
      }
      var before = {
        index: frames.length,
        type: 'action',
        street: a.street,
        board: hand.board.slice(0, a.street === 0 ? 0 : (a.street === 1 ? 3 : (a.street === 2 ? 4 : 5))),
        heroCards: hand.heroCards,
        aiCards: hand.aiCards,
        pot: committed[0] + committed[1],
        committed: committed.slice(),
        action: a,
        text: (a.seat === 0 ? '玩家' : 'AI') + ' ' + (ACTION_NAMES[a.action] || a.action) + (a.size > 0 ? ' ' + a.size : '')
      };
      frames.push(before);
      committed[a.seat] += a.size;
    });

    frames.push({
      index: frames.length,
      type: 'result',
      street: hand.streetReached || 0,
      board: hand.board.slice(),
      heroCards: hand.heroCards,
      aiCards: hand.aiCards,
      pot: hand.result ? hand.result.pot : committed[0] + committed[1],
      committed: committed.slice(),
      result: hand.result,
      text: hand.result ? (hand.result.winner === 0 ? '玩家胜' : (hand.result.winner === 1 ? 'AI 胜' : '平局')) : ''
    });
    return frames;
  }

  root.Recorder = {
    serialize: serialize,
    deserialize: deserialize,
    toShareCode: toShareCode,
    fromShareCode: fromShareCode,
    toJSONFile: toJSONFile,
    fromJSONFile: fromJSONFile,
    toSummaryText: toSummaryText,
    buildReport: buildReport,
    analyzeDecision: analyzeDecision,
    buildReplayFrames: buildReplayFrames,
    STREET_NAMES: STREET_NAMES,
    ACTION_NAMES: ACTION_NAMES
  };
})(typeof self !== 'undefined' ? self : globalThis);
