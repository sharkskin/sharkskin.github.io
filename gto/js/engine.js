/*
 * engine.js — heads-up 德州扑克牌局引擎
 * 负责：发牌、盲注、下注轮状态机、摊牌分池、决策点记录（供复盘与回看）
 *
 * 座位约定： seat 0 = 玩家（Hero）， seat 1 = AI
 * heads-up 中按钮位 = 小盲（翻前先行动，翻后最后行动 = 有位置优势）
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

  // ---------------- 范围追踪 ----------------
  // 根据对手的动作序列，逐步收窄其范围（AI 与玩家的估计用同一套逻辑）
  function RangeTracker() {
    this.ranges = [fullRange(), fullRange()];
  }
  RangeTracker.prototype.get = function (seat) { return this.ranges[seat]; };
  RangeTracker.prototype.apply = function (seat, action, ctx) {
    var r = this.ranges[seat];
    var out = {};
    var gto = GTO;
    var board = ctx.board || [];

    if (ctx.street === 0) {
      var raisesBefore = ctx.raisesThisStreetBefore || 0;
      for (var k in r) {
        var w = r[k];
        if (!(w > 0)) continue;
        var info = gto.keyInfo(k);
        var f = 1;
        if (action === 'fold') {
          f = 0.0001; // 弃牌不代表没有这手牌，但我们只需要剩余范围 —— 这里不用于已弃牌场景
        } else if (raisesBefore === 0) {
          if (ctx.isButton) {
            if (action === 'raise' || action === 'allin') f = (gto.RANGES.SB_PLAY[k] || 0) * gto.RANGES.SB_RAISE_SHARE(info);
            else if (action === 'call') f = (gto.RANGES.SB_PLAY[k] || 0) * (1 - gto.RANGES.SB_RAISE_SHARE(info));
          } else {
            // BB 面对 limp
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
    this.heroStack = this.startStack;
    this.aiStack = this.startStack;
    this.button = AI;                       // 下一手牌 hero 成为按钮
    this.hands = [];
    this.handNo = 0;
    this.cur = null;
    this.tracker = null;
    this.pending = null;
  }

  Game.prototype.deck = function () {
    var d = [];
    for (var i = 0; i < 52; i++) d.push(i);
    for (var j = d.length - 1; j > 0; j--) {
      var k = (Math.random() * (j + 1)) | 0;
      var t = d[j]; d[j] = d[k]; d[k] = t;
    }
    return d;
  };

  Game.prototype.startHand = function () {
    if (this.heroStack <= 0 || this.aiStack <= 0) return null;
    this.button = 1 - this.button; // 按钮交替
    var d = this.deck();
    var heroCards = [d[0], d[1]];
    var aiCards = [d[2], d[3]];
    var rest = d.slice(4);

    var sb = this.bb / 2, bb = this.bb;
    var heroStack = this.heroStack, aiStack = this.aiStack;
    var streetBets = [0, 0];
    var heroBlind = this.button === HERO ? sb : bb;
    var aiBlind = this.button === AI ? sb : bb;
    streetBets[HERO] = Math.min(heroBlind, heroStack);
    streetBets[AI] = Math.min(aiBlind, aiStack);
    heroStack -= streetBets[HERO];
    aiStack -= streetBets[AI];
    // 盲注就打光的情况（短码）
    var heroAllinBlind = heroStack <= 0;
    var aiAllinBlind = aiStack <= 0;

    this.handNo++;
    this.cur = {
      no: this.handNo,
      button: this.button,
      heroCards: heroCards,
      aiCards: aiCards,
      deck: rest,
      board: [],
      street: 0,
      streetBets: streetBets,
      committed: [streetBets[HERO], streetBets[AI]], // 本手牌总投入
      stacks: [heroStack, aiStack],
      acted: [false, false],
      raisesThisStreet: 0,
      lastRaiseTo: this.bb,
      folded: [false, false],
      allin: [heroAllinBlind, aiAllinBlind],
      actions: [],
      result: null
    };
    this.tracker = new RangeTracker();
    this.pending = null;
    return this.cur;
  };

  Game.prototype.holeOf = function (seat) {
    return seat === HERO ? this.cur.heroCards : this.cur.aiCards;
  };
  Game.prototype.stackOf = function (seat) { return this.cur.stacks[seat]; };

  /** 当前街应先行动的座位 */
  Game.prototype.firstActor = function () {
    // 翻前：按钮（小盲）先行动；翻后：非按钮先行动
    return this.cur.street === 0 ? this.cur.button : (1 - this.cur.button);
  };

  Game.prototype.currentBet = function () {
    return Math.max(this.cur.streetBets[0], this.cur.streetBets[1]);
  };

  Game.prototype.toCallFor = function (seat) {
    var c = this.currentBet() - this.cur.streetBets[seat];
    return Math.min(c, this.cur.stacks[seat]);
  };

  /** 下一个该行动的座位；返回 null 表示本街结束 */
  Game.prototype.nextActor = function () {
    var c = this.cur;
    if (c.folded[0] || c.folded[1]) return null;
    // 一方 all-in 且另一方已匹配 → 不再行动
    if (c.allin[0] && c.streetBets[1] >= c.streetBets[0] && c.acted[1]) return null;
    if (c.allin[1] && c.streetBets[0] >= c.streetBets[1] && c.acted[0]) return null;

    var order = [this.firstActor(), 1 - this.firstActor()];
    for (var i = 0; i < 2; i++) {
      var s = order[i];
      if (c.folded[s] || c.allin[s]) continue;
      var need = c.streetBets[1 - s] - c.streetBets[s];
      if (need > 0) return s;               // 投入不足，必须行动
      if (!c.acted[s]) return s;            // 投入相等但还没行动过
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

  /** 构建某座位视角的决策状态 */
  Game.prototype.buildState = function (seat) {
    var c = this.cur;
    var opp = 1 - seat;
    var board = c.board.slice();
    var hole = this.holeOf(seat);
    var oppRange = this.tracker.get(opp);
    var pot = c.committed[0] + c.committed[1];
    var toCall = this.toCallFor(seat);
    var isButton = c.button === seat;
    var position = (c.street === 0) ? (isButton ? 'OOP' : 'IP') : (isButton ? 'IP' : 'OOP');

    // 判断翻前主动方
    var isPreflopAggressor = false;
    if (c.street === 0) {
      isPreflopAggressor = isButton; // 按钮是翻前的开池方（简化）
    } else {
      // 翻前最后一次加注者
      for (var i = c.actions.length - 1; i >= 0; i--) {
        var a = c.actions[i];
        if (a.street === 0 && (a.action === 'raise' || a.action === 'bet')) {
          isPreflopAggressor = (a.seat === seat);
          break;
        }
      }
    }

    var iter = c.street === 0 ? 1400 : 1800;
    var eq = EQ.calcEquity(hole, board, oppRange, iter);

    var oppWidth = EQ.rangeWidth(oppRange);

    var st = {
      seat: seat,
      hole: hole,
      holeKey: PT.keyOfCards(hole[0], hole[1]),
      board: board,
      street: c.street,
      pot: pot,
      toCall: toCall,
      myStack: c.stacks[seat],
      oppStack: c.stacks[opp],
      bb: this.bb,
      position: position,
      isButton: isButton,
      isPreflopAggressor: isPreflopAggressor,
      isFirstActorPreflop: (c.street === 0 && this.firstActor() === seat && c.raisesThisStreet === 0),
      raisesThisStreet: c.raisesThisStreet,
      lastRaiseTo: c.lastRaiseTo,
      equity: eq.equity,
      oppRange: oppRange,
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

  /** 自动决策（按 GTO 频率抽样）；aiDecide 与自动测试共用 */
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

  /** AI 决策 */
  Game.prototype.aiDecide = function () {
    return this.autoDecide(AI);
  };

  /**
   * 执行一个动作
   * @param {number} seat
   * @param {string} action fold/check/call/bet/raise/allin
   * @param {number} size bet/raise 的「加注到」总额；allin 忽略
   */
  Game.prototype.applyAction = function (seat, action, size) {
    var c = this.cur;
    var pend = this.pending;
    var opp = 1 - seat;
    var st = pend ? pend.state : this.buildState(seat);
    var adv = pend ? pend.advice : GTO.decide(st);

    var stackBefore = c.stacks[seat];
    var potBefore = c.committed[0] + c.committed[1];
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
      var target = Math.min(size || this.minRaiseTo(seat), c.stacks[seat] + c.streetBets[seat]);
      putIn = target - c.streetBets[seat];
      putIn = Math.min(putIn, c.stacks[seat]);
      if (putIn >= c.stacks[seat]) { actualAction = 'allin'; c.allin[seat] = true; }
      else {
        c.raisesThisStreet++;
        c.lastRaiseTo = target;
        c.acted[opp] = false; // 价格变化，对手需重新行动
      }
    } else if (action === 'allin') {
      putIn = c.stacks[seat];
      c.allin[seat] = true;
      if (putIn + c.streetBets[seat] > this.currentBet()) {
        c.raisesThisStreet++;
        c.lastRaiseTo = putIn + c.streetBets[seat];
        c.acted[opp] = false;
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
      hole: this.holeOf(seat).slice(),
      holeKey: PT.keyOfCards(this.holeOf(seat)[0], this.holeOf(seat)[1]),
      equity: adv.equity,
      potOdds: tc > 0 ? tc / (potBefore + tc) : 0,
      position: st.position,
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

    // 更新该玩家的范围估计
    var raisesBefore = 0;
    for (var i = c.actions.length - 2; i >= 0; i--) {
      if (c.actions[i].street !== c.street) break;
      if (c.actions[i].action === 'raise' || c.actions[i].action === 'bet') raisesBefore++;
    }
    this.tracker.apply(seat, actualAction, {
      street: c.street,
      board: c.board,
      isButton: c.button === seat,
      raisesThisStreetBefore: raisesBefore
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
    if (c.folded[0] || c.folded[1]) {
      this.finishHand(c.folded[0] ? AI : HERO, true);
      return 'fold';
    }
    // 若已 all-in 匹配，直接发完剩余牌
    if (c.street < 3) {
      c.street++;
      var need = c.street === 1 ? 3 : 1;
      for (var i = 0; i < need; i++) c.board.push(c.deck.shift());
      c.streetBets = [0, 0];
      c.acted = [false, false];
      c.raisesThisStreet = 0;
      c.lastRaiseTo = 0;
      // 若双方都 all-in，后续街无行动直接进入摊牌
      if (c.allin[0] && c.allin[1]) {
        while (c.street < 3) {
          c.street++;
          var n2 = c.street === 1 ? 3 : 1;
          for (var j = 0; j < n2; j++) c.board.push(c.deck.shift());
        }
        this.showdown();
        return 'showdown';
      }
      return 'next';
    }
    this.showdown();
    return 'showdown';
  };

  Game.prototype.showdown = function () {
    var c = this.cur;
    var hv = PE.evalBest(c.heroCards.concat(c.board));
    var av = PE.evalBest(c.aiCards.concat(c.board));
    var winner = hv > av ? HERO : (av > hv ? AI : -1);
    this.finishHand(winner, false, hv, av);
  };

  Game.prototype.finishHand = function (winner, byFold, hv, av) {
    var c = this.cur;
    var com = [c.committed[0], c.committed[1]];
    var res = {
      winner: winner,
      byFold: !!byFold,
      board: c.board.slice(),
      heroCards: c.heroCards.slice(),
      aiCards: c.aiCards.slice(),
      heroHandValue: hv,
      aiHandValue: av,
      heroHandDesc: PE.describeHand(c.heroCards, c.board),
      aiHandDesc: PE.describeHand(c.aiCards, c.board),
      pot: com[0] + com[1],
      committed: com.slice(),
      // 净收益（含边池退还）
      heroNet: 0,
      aiNet: 0,
      showdown: !byFold
    };

    // 分池（含边池退还）
    var minC = Math.min(com[0], com[1]);
    var mainPot = minC * 2;
    var excess = Math.abs(com[0] - com[1]);
    var refundSeat = com[0] > com[1] ? HERO : AI;

    if (winner === -1) {
      // 平局：各自拿回自己的投入，净收益为 0
      res.heroNet = 0;
      res.split = true;
    } else if (winner === HERO) {
      res.heroNet = -com[0] + mainPot + (refundSeat === HERO ? excess : 0);
    } else {
      res.heroNet = -com[0] + (refundSeat === HERO ? excess : 0);
    }
    res.aiNet = -res.heroNet;

    // stacks 是已扣除本手投入后的余额，结算时加回投入再加净收益
    this.heroStack = this.cur.stacks[0] + com[0] + res.heroNet;
    this.aiStack = this.cur.stacks[1] + com[1] + res.aiNet;

    c.result = res;
    c.endTime = Date.now();
    this.hands.push({
      no: c.no,
      button: c.button,
      heroCards: c.heroCards,
      aiCards: c.aiCards,
      board: c.board,
      actions: c.actions,
      result: res,
      streetReached: c.street
    });
    return res;
  };

  Game.prototype.isOver = function () {
    return this.heroStack <= 0 || this.aiStack <= 0;
  };

  root.Engine = {
    Game: Game,
    RangeTracker: RangeTracker,
    STREET_NAMES: STREET_NAMES,
    HERO: HERO,
    AI: AI
  };
})(typeof self !== 'undefined' ? self : globalThis);
