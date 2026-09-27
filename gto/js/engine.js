/*
 * engine.js — 德州扑克牌局引擎
 * 负责：发牌、盲注、下注轮状态机、边池结算、摊牌判定、决策点记录（供复盘与回看）
 *
 * 座位约定：seat 0 = 玩家（Hero），1..n-1 = AI 对手
 * 支持 2 人（单挑）到 6 人桌。单挑时按钮 = 小盲；多人桌按钮之后依次是小盲 / 大盲。
 *
 * 兼容说明：heroStack / aiStack 是 this.chips[0] / this.chips[1] 的读写别名，
 * 便于旧代码（含测试脚本）继续使用。
 */
(function (root) {
  'use strict';
  var PE = root.PokerEval;
  var PT = root.PreflopTable;
  var EQ = root.Equity;
  var GTO = root.GTO;

  var STREET_NAMES = ['翻牌前', '翻牌', '转牌', '河牌'];
  var HERO = 0, AI = 1;

  function fullRange() {
    var r = {};
    for (var i = 0; i < GTO.ALL_KEYS.length; i++) r[GTO.ALL_KEYS[i]] = 1;
    return r;
  }

  // 在某个布尔数组里从 from 开始找第一个为 true 的位置
  function nextFrom(list, from) {
    var n = list.length;
    for (var k = 0; k < n; k++) {
      var i = (from + k) % n;
      if (list[i]) return i;
    }
    return -1;
  }

  /**
   * 边池计算
   * @param {number[]} committed 每个座位在本手牌的总投入
   * @param {boolean[]} canWin 是否有资格赢（未弃牌）
   * @returns {Array<{amount:number, eligible:number[]}>} 主池在前，边池在后
   */
  function buildPots(committed, canWin) {
    var contrib = committed.slice();
    var pots = [];
    for (;;) {
      var min = Infinity;
      for (var i = 0; i < contrib.length; i++) {
        if (canWin[i] && contrib[i] > 0 && contrib[i] < min) min = contrib[i];
      }
      if (min === Infinity) break;
      var amount = 0, el = [];
      for (var j = 0; j < contrib.length; j++) {
        if (contrib[j] > 0) {
          var take = Math.min(contrib[j], min);
          contrib[j] -= take;
          amount += take;
          if (canWin[j]) el.push(j);
        }
      }
      pots.push({ amount: amount, eligible: el });
    }
    return pots;
  }

  // ---------------- 范围追踪 ----------------
  // 根据对手的动作序列逐步收窄其范围（AI 与玩家的估计用同一套逻辑）
  function RangeTracker(n) {
    this.n = n;
    this.ranges = [];
    for (var i = 0; i < n; i++) this.ranges.push(fullRange());
  }
  RangeTracker.prototype.get = function (seat) { return this.ranges[seat]; };

  RangeTracker.prototype.apply = function (seat, action, ctx) {
    var r = this.ranges[seat];
    var out = {};
    var gto = GTO;
    var board = ctx.board || [];

    if (ctx.street === 0) {
      var isHU = (ctx.numPlayers === 2);
      for (var k in r) {
        var w = r[k];
        if (!(w > 0)) continue;
        var info = gto.keyInfo(k);
        var f = 1;
        if (action === 'fold') {
          f = 0.0001;
        } else if (isHU) {
          // ---- 单挑：沿用原有的 SB / BB 范围模型 ----
          var raisesBefore = ctx.raisesBefore || 0;
          if (raisesBefore === 0) {
            if (ctx.isButton) {
              if (action === 'raise' || action === 'allin') f = (gto.RANGES.SB_PLAY[k] || 0) * gto.RANGES.SB_RAISE_SHARE(info);
              else if (action === 'call') f = (gto.RANGES.SB_PLAY[k] || 0) * (1 - gto.RANGES.SB_RAISE_SHARE(info));
            } else {
              f = action === 'raise' ? gto.RANGES.BB_VS_LIMP_RAISE(info) : (1 - gto.RANGES.BB_VS_LIMP_RAISE(info));
            }
          } else if (raisesBefore === 1) {
            var m = gto.RANGES.BB_VS_OPEN(info);
            f = action === 'raise' || action === 'allin' ? m.three : (action === 'call' ? m.call : 0);
          } else if (raisesBefore === 2) {
            var m2 = gto.RANGES.VS_3BET(info);
            f = action === 'raise' || action === 'allin' ? m2.three : (action === 'call' ? m2.call : 0);
          } else {
            var m3 = gto.RANGES.VS_4BET(info);
            f = action === 'allin' || action === 'raise' ? m3.three : (action === 'call' ? m3.call : 0);
          }
        } else {
          // ---- 多人桌：按位置的开池 / 防守模型 ----
          var label = ctx.posLabel || 'MP';
          if (ctx.isFirstIn) {
            var ow = gto.openWeight(label, k);
            if (action === 'raise' || action === 'allin') f = ow;
            else if (action === 'call') f = ow * 0.22;          // limp 是低频选择
            else f = Math.max(0, 1 - ow * 1.2);                  // 过牌 / 弃牌
          } else if ((ctx.raisesBefore || 0) === 0) {
            var vl = gto.vsLimpMix(info, ctx, ctx.voluntaryBefore || 1);
            f = (action === 'raise' || action === 'allin') ? vl.raise : vl.continue;
          } else if ((ctx.raisesBefore || 0) === 1) {
            var vo = gto.vsOpenMix(info, ctx);
            f = (action === 'raise' || action === 'allin') ? vo.three : (action === 'call' ? vo.call : 0);
          } else if ((ctx.raisesBefore || 0) === 2) {
            var v3 = gto.RANGES.VS_3BET(info);
            f = (action === 'raise' || action === 'allin') ? v3.three : (action === 'call' ? v3.call : 0);
          } else {
            var v4 = gto.RANGES.VS_4BET(info);
            f = (action === 'allin' || action === 'raise') ? v4.three : (action === 'call' ? v4.call : 0);
          }
        }
        var nw = w * f;
        if (nw > 0.004) out[k] = nw;
      }
      this.ranges[seat] = out;
    } else {
      this.ranges[seat] = gto.updateRangeForAction(r, action, board, ctx.street);
    }
  };

  // ---------------- 牌局 ----------------
  function Game(opts) {
    opts = opts || {};
    this.bb = opts.bb || 2;
    this.startStack = opts.stack || 200;   // 100bb
    this.difficulty = opts.difficulty || 'standard';
    var n = Math.max(2, Math.min(6, opts.players || 2));
    this.n = n;

    this.players = [];
    for (var i = 0; i < n; i++) {
      this.players.push({
        seat: i,
        name: (opts.names && opts.names[i]) || (i === 0 ? '我' : '对手 ' + 'ABCDE'[i - 1]),
        isHero: i === 0
      });
    }

    this.chips = [];
    for (var j = 0; j < n; j++) this.chips.push(this.startStack);

    this.button = n - 1;                    // 保证第一手牌由 hero 坐按钮
    this.hands = [];
    this.handNo = 0;
    this.cur = null;
    this.tracker = new RangeTracker(n);
    this.pending = null;
  }

  // 兼容旧 API：heroStack / aiStack
  Object.defineProperty(Game.prototype, 'heroStack', {
    get: function () { return this.chips[0]; },
    set: function (v) { this.chips[0] = v; }
  });
  Object.defineProperty(Game.prototype, 'aiStack', {
    get: function () { return this.chips[1]; },
    set: function (v) { this.chips[1] = v; }
  });

  Game.prototype.deck = function () {
    var d = [];
    for (var i = 0; i < 52; i++) d.push(i);
    for (var j = d.length - 1; j > 0; j--) {
      var k = (Math.random() * (j + 1)) | 0;
      var t = d[j]; d[j] = d[k]; d[k] = t;
    }
    return d;
  };

  Game.prototype.totalPot = function () {
    var c = this.cur, s = 0;
    for (var i = 0; i < this.n; i++) s += c.committed[i];
    return s;
  };

  Game.prototype.startHand = function () {
    var n = this.n;
    var inHand = [];
    var count = 0;
    for (var i = 0; i < n; i++) {
      inHand[i] = this.chips[i] > 0;
      if (inHand[i]) count++;
    }
    if (count < 2) return null;

    // 按钮前进到下一个有筹码的座位
    for (var k = 1; k <= n; k++) {
      var cand = (this.button + k) % n;
      if (inHand[cand]) { this.button = cand; break; }
    }

    var d = this.deck();
    var holes = [];
    for (var s = 0; s < n; s++) {
      holes[s] = inHand[s] ? [d[s * 2], d[s * 2 + 1]] : null;
    }
    var rest = d.slice(n * 2);

    var sbAmount = this.bb / 2, bbAmount = this.bb;
    var sbSeat = (n === 2) ? nextFrom(inHand, this.button) : nextFrom(inHand, (this.button + 1) % n);
    var bbSeat = nextFrom(inHand, (sbSeat + 1) % n);
    if (bbSeat < 0 || bbSeat === sbSeat) return null;

    var streetBets = [], committed = [], stacks = [], acted = [], folded = [], allin = [];
    for (var q = 0; q < n; q++) {
      streetBets[q] = 0; committed[q] = 0;
      stacks[q] = this.chips[q];
      acted[q] = false; folded[q] = !inHand[q]; allin[q] = false;
    }

    function post(seat, amt) {
      var put = Math.min(amt, this.chips[seat]);
      streetBets[seat] = put;
      committed[seat] = put;
      stacks[seat] = this.chips[seat] - put;
      if (stacks[seat] <= 0) allin[seat] = true;
    }
    post.call(this, sbSeat, sbAmount);
    post.call(this, bbSeat, bbAmount);

    var labels = GTO.positionLabels(n);
    var relPos = [], posLabel = [];
    for (var r = 0; r < n; r++) {
      var rel = (r - this.button + n) % n;
      relPos[r] = rel;
      posLabel[r] = labels[rel];
    }

    this.handNo++;
    this.cur = {
      no: this.handNo,
      button: this.button,
      sbSeat: sbSeat,
      bbSeat: bbSeat,
      holes: holes,
      heroCards: holes[0] || [],          // 兼容旧代码
      aiCards: holes[1] || [],
      deck: rest,
      board: [],
      street: 0,
      streetBets: streetBets,
      committed: committed,
      stacks: stacks,
      acted: acted,
      folded: folded,
      allin: allin,
      inHand: inHand.slice(),
      relPos: relPos,
      posLabel: posLabel,
      raisesThisStreet: 0,
      lastRaiseTo: this.bb,
      actions: [],
      result: null
    };
    this.tracker = new RangeTracker(n);
    this.pending = null;
    return this.cur;
  };

  Game.prototype.holeOf = function (seat) { return this.cur.holes[seat]; };
  Game.prototype.stackOf = function (seat) { return this.cur.stacks[seat]; };
  Game.prototype.nameOf = function (seat) { return this.players[seat].name; };

  /** 存活（未弃牌且参与本手牌）的座位列表 */
  Game.prototype.liveSeats = function () {
    var c = this.cur, out = [];
    for (var i = 0; i < this.n; i++) if (!c.folded[i] && c.inHand[i]) out.push(i);
    return out;
  };

  /** 本街的行动顺序：从起始座位开始，跳过已弃牌或未参与的座位 */
  Game.prototype.streetOrder = function () {
    var c = this.cur, n = this.n, out = [];
    var liveOrder = [];
    for (var i = 0; i < n; i++) liveOrder[i] = !c.folded[i] && c.inHand[i];
    var start = c.street === 0
      ? (n === 2 ? c.button : nextFrom(liveOrder, (c.bbSeat + 1) % n))
      : nextFrom(liveOrder, (c.button + 1) % n);
    if (start < 0) start = 0;
    for (var k = 0; k < n; k++) {
      var s = (start + k) % n;
      if (liveOrder[s]) out.push(s);
    }
    return out;
  };

  /** 当前街应先行动的座位 */
  Game.prototype.firstActor = function () {
    var o = this.streetOrder();
    return o.length ? o[0] : null;
  };

  Game.prototype.currentBet = function () {
    var mx = 0;
    for (var i = 0; i < this.n; i++) if (this.cur.streetBets[i] > mx) mx = this.cur.streetBets[i];
    return mx;
  };

  Game.prototype.toCallFor = function (seat) {
    var c = this.cur;
    var need = this.currentBet() - c.streetBets[seat];
    return Math.max(0, Math.min(need, c.stacks[seat]));
  };

  /** 下一个该行动的座位；返回 null 表示本街结束 */
  Game.prototype.nextActor = function () {
    var c = this.cur;
    var live = this.liveSeats();
    if (live.length <= 1) return null;

    var actable = 0;
    for (var p = 0; p < live.length; p++) if (!c.allin[live[p]]) actable++;
    if (actable === 0) return null;

    var order = this.streetOrder();
    var cb = this.currentBet();
    for (var i = 0; i < order.length; i++) {
      var s = order[i];
      if (c.allin[s]) continue;
      if (c.streetBets[s] < cb) return s;      // 投入不足，必须行动
      if (!c.acted[s]) return s;               // 投入已平但还没行动过
    }
    return null;
  };

  Game.prototype.legalActions = function (seat) {
    var c = this.cur;
    var tc = this.toCallFor(seat);
    var stack = c.stacks[seat];
    var out = [];
    if (tc > 0) {
      out.push('fold');
      out.push('call');
      if (stack > tc) out.push('raise');
    } else {
      out.push('check');
      if (stack > 0) out.push('bet');
    }
    if (stack > 0) out.push('allin');
    return out;
  };

  Game.prototype.minRaiseTo = function (seat) {
    var c = this.cur;
    var cb = this.currentBet();
    var last = c.lastRaiseTo || this.bb;
    var minTo = last + Math.max(cb - last, this.bb);
    return Math.min(minTo, c.stacks[seat] + c.streetBets[seat]);
  };

  /** 到当前为止，本街自愿投入的玩家数（不含 seat 自己）与加注次数 */
  Game.prototype.streetContext = function (seat) {
    var c = this.cur;
    var raises = 0;
    var volSeats = {};
    for (var i = c.actions.length - 1; i >= 0; i--) {
      var a = c.actions[i];
      if (a.street !== c.street) break;
      if (a.action === 'raise' || a.action === 'bet') raises++;
      if (a.action === 'call' || a.action === 'raise' || a.action === 'bet' || a.action === 'allin') volSeats[a.seat] = 1;
    }
    if (volSeats[seat]) delete volSeats[seat];
    var vol = 0;
    for (var k in volSeats) vol++;
    return { raises: raises, voluntary: vol };
  };

  /** 本街在 seat 之后行动的存活对手数量 */
  Game.prototype.opponentsAfter = function (seat) {
    var order = this.streetOrder();
    var idx = order.indexOf(seat);
    if (idx < 0) return 0;
    var cnt = 0;
    for (var i = idx + 1; i < order.length; i++) if (order[i] !== seat) cnt++;
    return cnt;
  };

  /** 构建某座位视角的决策状态 */
  Game.prototype.buildState = function (seat) {
    var c = this.cur, n = this.n;
    var board = c.board.slice();
    var hole = this.holeOf(seat);

    var oppRanges = [], oppSeats = [], oppStackMax = 0, widthSum = 0;
    for (var i = 0; i < n; i++) {
      if (i === seat || c.folded[i] || !c.inHand[i]) continue;
      oppSeats.push(i);
      var rg = this.tracker.get(i);
      oppRanges.push(rg);
      widthSum += EQ.rangeWidth(rg);
      if (c.stacks[i] > oppStackMax) oppStackMax = c.stacks[i];
    }
    var liveOpponents = oppSeats.length;
    var oppWidth = liveOpponents ? widthSum / liveOpponents : 0.5;

    var pot = this.totalPot();
    var toCall = this.toCallFor(seat);
    var oppsAfter = this.opponentsAfter(seat);

    // IP = 在本街最后一个行动（所有对手都先动）
    var position = (oppsAfter === 0) ? 'IP' : 'OOP';

    // 判断翻前主动方
    var isPreflopAggressor = false;
    if (c.street === 0) {
      isPreflopAggressor = false;   // 多人桌没有单一「翻前加注者」概念，交由下面的检索
      if (n === 2) isPreflopAggressor = (c.button === seat);
    }
    for (var q = c.actions.length - 1; q >= 0; q--) {
      var aa = c.actions[q];
      if (aa.street === 0 && (aa.action === 'raise' || aa.action === 'bet')) {
        isPreflopAggressor = (aa.seat === seat);
        break;
      }
    }

    var ctx = this.streetContext(seat);

    // 胜率：多人用多对手模拟，单挑用单对手模拟
    var iter;
    if (liveOpponents >= 2) {
      iter = Math.max(450, Math.round(1500 / Math.sqrt(liveOpponents)));
      if (c.street === 0) iter = Math.max(400, Math.round(iter * 0.85));
    } else {
      iter = c.street === 0 ? 1400 : 1800;
    }
    var eq = liveOpponents >= 2
      ? EQ.calcEquityMulti(hole, board, oppRanges, iter)
      : EQ.calcEquity(hole, board, liveOpponents === 1 ? oppRanges[0] : null, iter);

    var st = {
      seat: seat,
      hole: hole,
      holeKey: PT.keyOfCards(hole[0], hole[1]),
      board: board,
      street: c.street,
      pot: pot,
      toCall: toCall,
      myStack: c.stacks[seat],
      oppStack: oppStackMax,
      bb: this.bb,
      position: position,
      oppsAfter: oppsAfter,
      isButton: c.button === seat,
      isPreflopAggressor: isPreflopAggressor,
      isFirstActorPreflop: (c.street === 0 && this.firstActor() === seat && c.raisesThisStreet === 0),
      raisesThisStreet: c.raisesThisStreet,
      lastRaiseTo: c.lastRaiseTo,
      numPlayers: n,
      relPos: c.relPos[seat],
      posLabel: c.posLabel[seat],
      liveOpponents: liveOpponents,
      voluntaryCount: ctx.voluntary,
      isFirstIn: (c.street === 0 && ctx.raises === 0 && ctx.voluntary === 0),
      equity: eq.equity,
      oppRange: liveOpponents > 0 ? oppRanges[0] : null,
      oppRangeWidth: oppWidth
    };
    return st;
  };

  /** 为某座位准备决策（计算 GTO 建议），缓存为 pending */
  Game.prototype.prepareDecision = function (seat) {
    var st = this.buildState(seat);
    var advice = GTO.decide(st);
    this.pending = { seat: seat, state: st, advice: advice };
    return { state: st, advice: advice };
  };

  /** 自动决策（按 GTO 频率抽样）；AI 与自动测试共用 */
  Game.prototype.autoDecide = function (seat) {
    var d = this.prepareDecision(seat);
    var opts = GTO.adjustForDifficulty(d.advice.options, this.difficulty, d.state);
    var legal = this.legalActions(seat);
    var filtered = [];
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      var la = o.action === 'allin' ? 'allin' : o.action;
      if (legal.indexOf(la) < 0) continue;
      // 校验额度
      if (o.action === 'raise' || o.action === 'bet' || o.action === 'allin') {
        var stack = d.state.myStack;
        if (o.action === 'allin') { o.size = stack + this.toCallFor(seat); }
        else {
          var max = stack + (o.action === 'raise' ? this.toCallFor(seat) : 0);
          o.size = Math.min(Math.max(o.size, this.minRaiseTo(seat)), max);
          if (o.size <= 0) continue;
        }
      }
      filtered.push(o);
    }
    if (!filtered.length) {
      filtered = [{ action: this.toCallFor(seat) > 0 ? 'call' : 'check', size: 0, freq: 1 }];
    }
    GTO.normalize(filtered);
    var r = Math.random(), acc = 0, chosen = filtered[filtered.length - 1];
    for (var j = 0; j < filtered.length; j++) {
      acc += filtered[j].freq;
      if (r <= acc) { chosen = filtered[j]; break; }
    }
    return { decision: { state: d.state, advice: d.advice }, chosen: chosen };
  };

  /** AI 决策；不传座位时默认是 seat 1 */
  Game.prototype.aiDecide = function (seat) {
    return this.autoDecide(seat === undefined ? AI : seat);
  };

  /**
   * 执行一个动作
   * @param {number} seat
   * @param {string} action fold/check/call/bet/raise/allin
   * @param {number} size bet/raise 的「加注到」总额；allin 忽略
   */
  Game.prototype.applyAction = function (seat, action, size) {
    var c = this.cur, n = this.n;
    var pend = this.pending;
    var st = (pend && pend.seat === seat) ? pend.state : this.buildState(seat);
    var adv = (pend && pend.seat === seat) ? pend.advice : GTO.decide(st);

    var stackBefore = c.stacks[seat];
    var potBefore = this.totalPot();
    var prevBet = this.currentBet();
    var tc = this.toCallFor(seat);
    var putIn = 0;
    var actualAction = action;

    if (action === 'fold') {
      c.folded[seat] = true;
    } else if (action === 'check') {
      putIn = 0;
    } else if (action === 'call') {
      putIn = Math.min(tc, c.stacks[seat]);
      if (putIn >= c.stacks[seat]) { actualAction = 'allin'; c.allin[seat] = true; }
    } else if (action === 'bet' || action === 'raise') {
      var maxTo = c.stacks[seat] + c.streetBets[seat];
      var target = Math.min(size || this.minRaiseTo(seat), maxTo);
      putIn = Math.max(0, Math.min(target - c.streetBets[seat], c.stacks[seat]));
      if (putIn >= c.stacks[seat] && c.stacks[seat] > 0) {
        actualAction = 'allin';
        c.allin[seat] = true;
      }
      if (c.streetBets[seat] + putIn > prevBet) {
        c.raisesThisStreet++;
        c.lastRaiseTo = Math.max(c.lastRaiseTo || 0, c.streetBets[seat] + putIn);
        // 价格变化 → 其他尚未 all-in 的玩家可以重新行动
        for (var z = 0; z < n; z++) {
          if (z !== seat && !c.folded[z] && !c.allin[z]) c.acted[z] = false;
        }
      }
    } else if (action === 'allin') {
      putIn = c.stacks[seat];
      c.allin[seat] = true;
      if (putIn + c.streetBets[seat] > prevBet) {
        c.raisesThisStreet++;
        c.lastRaiseTo = Math.max(c.lastRaiseTo || 0, putIn + c.streetBets[seat]);
        for (var z2 = 0; z2 < n; z2++) {
          if (z2 !== seat && !c.folded[z2] && !c.allin[z2]) c.acted[z2] = false;
        }
      }
    }

    c.stacks[seat] -= putIn;
    c.streetBets[seat] += putIn;
    c.committed[seat] += putIn;
    c.acted[seat] = true;

    var rec = {
      street: c.street,
      seat: seat,
      action: actualAction,
      size: putIn,
      raiseTo: (action === 'bet' || action === 'raise') ? c.streetBets[seat] : 0,
      potBefore: potBefore,
      toCall: tc,
      stackBefore: stackBefore,
      stackAfter: c.stacks[seat],
      board: c.board.slice(),
      hole: this.holeOf(seat) ? this.holeOf(seat).slice() : [],
      holeKey: this.holeOf(seat) ? PT.keyOfCards(this.holeOf(seat)[0], this.holeOf(seat)[1]) : '',
      equity: adv.equity,
      potOdds: tc > 0 ? tc / (potBefore + tc) : 0,
      position: st.position,
      posLabel: st.posLabel || '',
      handDesc: adv.handDesc || '',
      reasons: adv.reasons || [],
      options: (adv.options || []).map(function (o) {
        return { action: o.action, size: o.size, freq: o.freq, ev: o.ev, note: o.note };
      }),
      primary: adv.primary ? { action: adv.primary.action, size: adv.primary.size } : null,
      oppRangeWidth: st.oppRangeWidth,
      time: Date.now()
    };
    c.actions.push(rec);

    // 更新该玩家的范围估计（用动作发生前统计到的信息）
    var ctxCount = this.streetContext(seat);
    this.tracker.apply(seat, actualAction, {
      street: c.street,
      board: c.board,
      numPlayers: n,
      seat: seat,
      isButton: c.button === seat,
      relPos: c.relPos[seat],
      posLabel: c.posLabel[seat],
      raisesBefore: ctxCount.raises,
      voluntaryBefore: Math.max(1, ctxCount.voluntary),
      isFirstIn: st.isFirstIn,
      oppsAfter: st.oppsAfter,
      liveOpponents: st.liveOpponents
    });

    this.pending = null;
    return rec;
  };

  /** 本街是否结束 */
  Game.prototype.isStreetOver = function () {
    return this.nextActor() === null;
  };

  /** 推进到下一街；返回 'next' | 'showdown' | 'fold' */
  Game.prototype.advance = function () {
    var c = this.cur;
    var live = this.liveSeats();
    if (live.length <= 1) {
      this.settleUp(true);
      return 'fold';
    }
    // 只剩一人能够行动（其余全部 all-in）→ 直接发完剩余公共牌
    var actable = [];
    for (var i = 0; i < live.length; i++) if (!c.allin[live[i]]) actable.push(live[i]);
    if (actable.length <= 1) {
      while (c.street < 3) {
        c.street++;
        var need2 = c.street === 1 ? 3 : 1;
        for (var j = 0; j < need2; j++) c.board.push(c.deck.shift());
      }
      this.settleUp(false);
      return 'showdown';
    }

    if (c.street < 3) {
      c.street++;
      var need = c.street === 1 ? 3 : 1;
      for (var k = 0; k < need; k++) c.board.push(c.deck.shift());
      c.streetBets = [];
      c.acted = [];
      for (var q = 0; q < this.n; q++) { c.streetBets[q] = 0; c.acted[q] = false; }
      c.raisesThisStreet = 0;
      c.lastRaiseTo = 0;
      return 'next';
    }
    this.settleUp(false);
    return 'showdown';
  };

  Game.prototype.showdown = function () {
    this.settleUp(false);
  };

  /**
   * 结算：支持边池与多人平分
   * @param {boolean} byFold 是否因所有人弃牌而结束
   */
  Game.prototype.settleUp = function (byFold) {
    var c = this.cur, n = this.n;
    var i;

    // 摊牌前确保公共牌发满
    if (!byFold) {
      while (c.board.length < 5 && c.street >= 3) c.board.push(c.deck.shift());
    }

    var canWin = [];
    var live = [];
    for (i = 0; i < n; i++) {
      canWin[i] = !c.folded[i] && !!c.holes[i];
      if (canWin[i]) live.push(i);
    }

    var values = [];
    for (i = 0; i < n; i++) {
      values[i] = (c.holes[i] && c.board.length >= 3) ? PE.evalBest(c.holes[i].concat(c.board)) : -1;
    }

    var prize = [];
    for (i = 0; i < n; i++) prize[i] = 0;

    var pots = [];
    if (live.length === 1) {
      var total = 0;
      for (i = 0; i < n; i++) total += c.committed[i];
      pots.push({ amount: total, eligible: [live[0]], winners: [live[0]] });
      prize[live[0]] = total;
    } else if (live.length > 1) {
      // 保证发满 5 张公共牌
      while (c.board.length < 5) c.board.push(c.deck.shift());
      for (i = 0; i < n; i++) {
        values[i] = c.holes[i] ? PE.evalBest(c.holes[i].concat(c.board)) : -1;
      }
      pots = buildPots(c.committed, canWin);
      if (!pots.length) {
        var t2 = 0;
        for (i = 0; i < n; i++) t2 += c.committed[i];
        pots.push({ amount: t2, eligible: live.slice(), winners: live.slice() });
        var each = t2 / live.length;
        live.forEach(function (s) { prize[s] += each; });
      } else {
    pots.forEach(function (p) {
      var best = -Infinity, winners = [];
      p.eligible.forEach(function (s) {
        var v = values[s];
        if (v > best) { best = v; winners = [s]; }
        else if (v === best) winners.push(s);
      });
      if (!winners.length) winners = p.eligible.slice();
      p.winners = winners.slice();
      p.share = p.amount / winners.length;
      p.contested = p.eligible.length >= 2;   // 只有一个有资格者的奖池属于「退还多余下注」
      winners.forEach(function (s) { prize[s] += p.share; });
    });
      }
    }

    // 净收益 & 写回筹码
    var nets = [];
    for (i = 0; i < n; i++) {
      nets[i] = prize[i] - c.committed[i];
      this.chips[i] = c.stacks[i] + c.committed[i] + nets[i];
    }

    var winners = [];
    pots.forEach(function (p) {
      // 只有「有竞争」的奖池才产生真正的赢家；单独拥有的奖池是退还多余下注
      if (p.eligible.length < 2) return;
      (p.winners || []).forEach(function (s) { if (winners.indexOf(s) < 0) winners.push(s); });
    });
    if (!winners.length && live.length) winners = [live[0]];

    var potTotal = 0;
    for (i = 0; i < n; i++) potTotal += c.committed[i];

    var playerInfo = [];
    for (i = 0; i < n; i++) {
      playerInfo.push({
        seat: i,
        name: this.players[i].name,
        isHero: i === 0,
        hole: c.holes[i] ? c.holes[i].slice() : null,
        handValue: values[i],
        handDesc: (c.holes[i] && c.board.length >= 3) ? PE.describeHand(c.holes[i], c.board) : '',
        committed: c.committed[i],
        prize: prize[i],
        net: nets[i],
        folded: !!c.folded[i]
      });
    }

    var res = {
      winner: winners.length === 1 ? winners[0] : -1,
      winners: winners,
      byFold: !!byFold,
      board: c.board.slice(),
      holes: c.holes.map(function (h) { return h ? h.slice() : null; }),
      heroCards: c.holes[0] ? c.holes[0].slice() : [],
      aiCards: c.holes[1] ? c.holes[1].slice() : [],
      heroHandValue: values[0],
      aiHandValue: values[1],
      heroHandDesc: (c.holes[0] && c.board.length >= 3) ? PE.describeHand(c.holes[0], c.board) : '',
      aiHandDesc: (c.holes[1] && c.board.length >= 3) ? PE.describeHand(c.holes[1], c.board) : '',
      pot: potTotal,
      committed: c.committed.slice(),
      pots: pots.map(function (p) {
        return {
          amount: p.amount,
          eligible: (p.eligible || []).slice(),
          winners: (p.winners || []).slice(),
          contested: p.eligible ? p.eligible.length >= 2 : false
        };
      }),
      players: playerInfo,
      nets: nets.slice(),
      prize: prize.slice(),
      heroNet: nets[0],
      aiNet: nets[1] || 0,
      split: winners.length > 1,
      showdown: !byFold
    };

    c.result = res;
    c.endTime = Date.now();
    this.hands.push({
      no: c.no,
      button: c.button,
      players: n,
      holes: c.holes.map(function (h) { return h ? h.slice() : null; }),
      heroCards: c.holes[0] ? c.holes[0].slice() : [],
      aiCards: c.holes[1] ? c.holes[1].slice() : [],
      board: c.board,
      actions: c.actions,
      result: res,
      streetReached: c.street
    });
    return res;
  };

  // 兼容旧调用：finishHand(winnerSeat, byFold)
  Game.prototype.finishHand = function (winnerSeat, byFold) {
    return this.settleUp(!!byFold);
  };

  Game.prototype.isOver = function () {
    for (var i = 0; i < this.n; i++) if (this.chips[i] <= 0) return true;
    return false;
  };

  root.Engine = {
    Game: Game,
    RangeTracker: RangeTracker,
    buildPots: buildPots,
    STREET_NAMES: STREET_NAMES,
    HERO: HERO,
    AI: AI
  };
})(typeof self !== 'undefined' ? self : globalThis);
