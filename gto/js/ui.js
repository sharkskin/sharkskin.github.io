/*
 * ui.js — 界面与交互
 */
(function () {
  'use strict';
  var PE = PokerEval, PT = PreflopTable, EQ = Equity, GTO = GTO_NS(), Engine = EngineNS(), Recorder = RecNS();
  function GTO_NS() { return window.GTO; }
  function EngineNS() { return window.Engine; }
  function RecNS() { return window.Recorder; }

  var HERO = 0, AI = 1;
  var VIEWS = ['game', 'range', 'review', 'replay'];
  var LS_SET = 'gto-poker-settings-v1';
  var LS_SES = 'gto-poker-session-v1';
  var LS_IMP = 'gto-poker-imports-v1';

  var S = {
    game: null,
    coach: true,
    peek: false,
    difficulty: 'standard',
    speed: 700,
    stackBB: 100,
    pending: null,        // hero 待决策 {state, advice}
    betMode: null,        // null | 'bet' | 'raise'
    betSize: 0,
    busy: false,
    handOver: false,
    imports: [],          // 导入的他人的牌局（只用于回看，不影响当前对局）
    replay: { source: 'self', hand: null, frames: [], idx: 0, timer: null }
  };

  // 回看数据源：本次牌局 + 所有导入的牌局
  function replaySources() {
    var arr = [];
    if (S.game && S.game.hands && S.game.hands.length) {
      arr.push({ id: 'self', label: '本次牌局', hands: S.game.hands, bb: S.game.bb, mine: true });
    }
    S.imports.forEach(function (imp) { arr.push(imp); });
    return arr;
  }
  function findSource(id) {
    var srcs = replaySources();
    for (var i = 0; i < srcs.length; i++) if (srcs[i].id === id) return srcs[i];
    return srcs[0] || null;
  }
  function loadImports() {
    try {
      var d = JSON.parse(localStorage.getItem(LS_IMP) || '[]');
      if (Array.isArray(d)) S.imports = d;
    } catch (e) { S.imports = []; }
  }
  function saveImports() {
    try {
      // 只保留最近 3 份，避免占满本地存储
      S.imports = S.imports.slice(-3);
      localStorage.setItem(LS_IMP, JSON.stringify(S.imports));
    } catch (e) { console.warn('导入记录保存失败', e); }
  }

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------------- 牌渲染 ----------------
  var SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };
  function cardHTML(c, cls, small) {
    if (c === undefined || c === null || c < 0) {
      return '<div class="card hidden-c' + (small ? ' small' : '') + '"></div>';
    }
    var r = PE.RANK_NAMES[c % 13];
    var su = PE.SUIT_CHARS[(c / 13) | 0];
    var red = (su === 'h' || su === 'd');
    return '<div class="card ' + (red ? 'red' : 'black') + (small ? ' small' : '') + (cls ? ' ' + cls : '') + '">' +
      r + '<span class="suit">' + SUIT_SYM[su] + '</span></div>';
  }
  function cardBack(cls) {
    return '<div class="card back' + (cls ? ' ' + cls : '') + '"></div>';
  }

  // ---------------- 设置持久化 ----------------
  function loadSettings() {
    loadImports();
    try {
      var d = JSON.parse(localStorage.getItem(LS_SET) || '{}');
      if (d.coach !== undefined) S.coach = d.coach;
      if (d.peek !== undefined) S.peek = d.peek;
      if (d.difficulty) S.difficulty = d.difficulty;
      if (d.speed) S.speed = d.speed;
      if (d.stackBB) S.stackBB = d.stackBB;
    } catch (e) { }
  }
  function saveSettings() {
    try {
      localStorage.setItem(LS_SET, JSON.stringify({
        coach: S.coach, peek: S.peek, difficulty: S.difficulty, speed: S.speed, stackBB: S.stackBB
      }));
    } catch (e) { }
  }
  function saveSession() {
    if (!S.game) return;
    try {
      var d = Recorder.serialize(S.game, true);
      d.heroStack = S.game.heroStack;
      d.aiStack = S.game.aiStack;
      d.button = S.game.button;
      d.handNo = S.game.handNo;
      localStorage.setItem(LS_SES, JSON.stringify(d));
    } catch (e) { console.warn('保存失败', e); }
  }
  function loadSession() {
    try {
      var raw = localStorage.getItem(LS_SES);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d.hands || !d.hands.length) return null;
      var g = new Engine.Game({ bb: d.bb || 2, stack: d.stack || 200, difficulty: d.difficulty || S.difficulty });
      var des = Recorder.deserialize(d);
      g.hands = des.hands;
      g.heroStack = d.heroStack != null ? d.heroStack : g.startStack;
      g.aiStack = d.aiStack != null ? d.aiStack : g.startStack;
      g.button = d.button != null ? d.button : AI;
      g.handNo = d.handNo || des.hands.length;
      return g;
    } catch (e) { return null; }
  }

  // ---------------- 初始化 ----------------
  function init() {
    loadSettings();
    S.game = loadSession();
    if (!S.game) newGame(false);
    applySettingsToUI();
    bindEvents();
    renderAll();
    // 保证进来就有牌可打：有未完成的牌局就继续，否则开新的一手
    if (S.game && S.game.cur && !S.game.cur.result) {
      setTimeout(function () { loop(); }, 200);
    } else {
      startHand();
    }
  }

  function newGame(save) {
    S.game = new Engine.Game({
      bb: 2,
      stack: S.stackBB * 2,   // S.stackBB 以 BB 计，1BB = 2 筹码
      difficulty: S.difficulty
    });
    S.handOver = true;
    S.pending = null;
    S.betMode = null;
    if (save !== false) saveSession();
    renderAll();
    startHand();
  }

  // ---------------- 游戏循环 ----------------
  function startHand() {
    S.handOver = false;
    S.pending = null;
    S.betMode = null;
    $('result-banner').innerHTML = '';
    S.game.startHand();
    renderAll();
    loop();
  }

  function loop() {
    var g = S.game;
    if (!g || !g.cur) return;
    if (g.cur.result) { setHandOver(true); return; }

    var actor = g.nextActor();
    if (actor === null) {
      var r = g.advance();
      renderAll();
      saveSession();
      if (r === 'showdown' || r === 'fold') {
        setHandOver(true);
        return;
      }
      setTimeout(loop, S.speed * 0.6);
      return;
    }

    if (actor === HERO) {
      var d = g.prepareDecision(HERO);
      S.pending = d;
      S.betMode = null;
      renderAll();
      enableActions(true);
    } else {
      enableActions(false);
      setBubble(AI, '思考中…', true);
      var res = g.aiDecide();
      setTimeout(function () {
        var ch = res.chosen;
        g.applyAction(AI, ch.action, ch.size);
        renderAll();
        setTimeout(loop, S.speed * 0.5);
      }, Math.min(S.speed, 900));
    }
  }

  function onHeroAction(action, size) {
    var g = S.game;
    if (!S.pending) return;
    enableActions(false);
    g.applyAction(HERO, action, size);
    S.pending = null;
    S.betMode = null;
    renderAll();
    saveSession();
    setTimeout(loop, S.speed * 0.35);
  }

  function setHandOver(v) {
    S.handOver = v;
    if (v) {
      enableActions(false);
      renderResult();
    }
    renderActions();
  }

  // ---------------- 渲染 ----------------
  function renderAll() {
    renderTable();
    renderCoach();
    renderActions();
  }

  function renderTable() {
    var g = S.game, c = g.cur;
    if (!c) return;
    var showdown = !!c.result;
    var reveal = showdown || S.peek;

    $('street-label').textContent = Engine.STREET_NAMES[c.street];
    $('chip-hero').innerHTML = g.heroStack.toFixed(0) + ' <small>筹码 (' + (g.heroStack / g.bb).toFixed(0) + ' BB)</small>';
    $('chip-ai').innerHTML = g.aiStack.toFixed(0) + ' <small>筹码 (' + (g.aiStack / g.bb).toFixed(0) + ' BB)</small>';

    $('tag-hero-pos').textContent = c.button === HERO ? '按钮/小盲' : '大盲';
    $('tag-ai-pos').textContent = c.button === AI ? '按钮/小盲' : '大盲';
    $('tag-hero-pos').className = 'tag' + (c.button === HERO ? ' btn-tag' : '');
    $('tag-ai-pos').className = 'tag' + (c.button === AI ? ' btn-tag' : '');

    // 手牌
    $('cards-hero').innerHTML = c.heroCards.map(function (x) { return cardHTML(x, ''); }).join('');
    var aiWin = showdown && c.result && c.result.winner === AI;
    var heroWin = showdown && c.result && c.result.winner === HERO;
    $('cards-ai').innerHTML = reveal
      ? c.aiCards.map(function (x) { return cardHTML(x, aiWin ? 'win' : ''); }).join('')
      : (cardBack() + cardBack());

    // 公共牌
    var bh = '';
    for (var i = 0; i < 5; i++) {
      bh += i < c.board.length ? cardHTML(c.board[i], '') : '<div class="card hidden-c"></div>';
    }
    $('board-cards').innerHTML = bh;
    $('pot-display').textContent = '底池 ' + (c.committed[0] + c.committed[1]).toFixed(0);

    // 座位高亮
    var actor = c.result ? null : g.nextActor();
    $('seat-hero').className = 'seat' + (actor === HERO ? ' turn' : '') + (c.folded[0] ? ' folded' : '');
    $('seat-ai').className = 'seat' + (actor === AI ? ' turn' : '') + (c.folded[1] ? ' folded' : '');

    // 气泡
    if (!c.result) {
      var lastH = lastActionOf(c, HERO), lastA = lastActionOf(c, AI);
      setBubble(HERO, lastH ? actionText(lastH) : '', false);
      if (!S.busy) setBubble(AI, lastA ? actionText(lastA) : '', false);
    }
  }

  function lastActionOf(c, seat) {
    for (var i = c.actions.length - 1; i >= 0; i--) {
      if (c.actions[i].seat === seat) return c.actions[i];
    }
    return null;
  }
  function actionText(a) {
    var n = Recorder.ACTION_NAMES[a.action] || a.action;
    if (a.action === 'bet' || a.action === 'raise' || a.action === 'allin') return n + ' ' + a.size.toFixed(0);
    if (a.action === 'call') return '跟注 ' + a.size.toFixed(0);
    return n;
  }
  function setBubble(seat, text, active) {
    var el = seat === HERO ? $('bubble-hero') : $('bubble-ai');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'bubble' + (active ? ' act' : '');
    el.style.display = text ? '' : 'none';
  }

  function renderCoach() {
    var el = $('coach-panel');
    if (!S.coach) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    var c = S.game.cur;
    if (!c) return;

    if (S.pending) {
      renderAdvice(S.pending.advice, S.pending.state);
    } else if (c.result) {
      $('coach-desc').textContent = '本手结束 — 点击查看复盘';
      $('stat-equity').textContent = '—';
      $('stat-odds').textContent = '—';
      $('bar-equity').style.width = '0%';
      $('bar-odds').style.width = '0%';
      $('opt-list').innerHTML = '';
      $('reasons').innerHTML = '';
    } else {
      $('coach-desc').textContent = '等待你的决策…';
    }
  }

  function renderAdvice(adv, st) {
    var eq = adv.equity;
    $('coach-desc').textContent = (adv.handDesc || st.holeKey || '') + ' · 位置 ' + (st.position === 'IP' ? '有利' : '不利');
    $('stat-equity').textContent = (eq * 100).toFixed(1) + '%';
    $('bar-equity').style.width = (eq * 100).toFixed(0) + '%';
    if (st.toCall > 0) {
      var po = st.toCall / (st.pot + st.toCall);
      $('stat-odds').textContent = (po * 100).toFixed(1) + '%';
      $('bar-odds').style.width = (po * 100).toFixed(0) + '%';
    } else {
      $('stat-odds').textContent = '无需跟注';
      $('bar-odds').style.width = '0%';
    }

    var maxEv = -Infinity;
    adv.options.forEach(function (o) { if ((o.ev || 0) > maxEv) maxEv = o.ev || 0; });

    $('opt-list').innerHTML = adv.options.map(function (o) {
      var isBest = Math.abs((o.ev || 0) - maxEv) < 0.01;
      var nm = Recorder.ACTION_NAMES[o.action] || o.action;
      var sz = (o.action === 'bet' || o.action === 'raise' || o.action === 'allin') && o.size ? ' ' + o.size.toFixed(0) : '';
      return '<div class="opt ' + (isBest ? 'best' : (o.freq >= 0.22 ? 'mixed' : '')) + '">' +
        '<span class="a">' + esc(nm + sz) + '</span>' +
        '<span class="fb"><span class="bar"><i style="width:' + (o.freq * 100).toFixed(0) + '%"></i></span></span>' +
        '<span class="f">' + (o.freq * 100).toFixed(0) + '%</span>' +
        '<span class="e">EV ' + (o.ev || 0).toFixed(1) + '</span>' +
        '</div>';
    }).join('');

    $('reasons').innerHTML = (adv.reasons || []).map(function (r) {
      return '<li>' + esc(r) + '</li>';
    }).join('');
  }

  function renderActions() {
    var g = S.game, c = g.cur;
    var canAct = !!S.pending && !S.handOver;
    var toCall = c && !c.result ? g.toCallFor(HERO) : 0;

    // 手牌结束：只保留「下一手」
    if (S.handOver) {
      ['btn-fold', 'btn-check', 'btn-bet', 'btn-allin'].forEach(function (id) { $(id).style.display = 'none'; });
      $('btn-next').style.display = '';
      $('btn-next').disabled = false;
      $('bet-ui').style.display = 'none';
      return;
    }
    ['btn-fold', 'btn-check', 'btn-bet'].forEach(function (id) { $(id).style.display = ''; });

    var fold = $('btn-fold');
    if (S.betMode) {
      fold.textContent = '取消';
      fold.className = 'btn ghost';
    } else {
      fold.textContent = '弃牌';
      fold.className = 'btn fold';
      fold.style.display = (toCall > 0) ? '' : 'none';
    }

    var chk = $('btn-check');
    if (toCall > 0) {
      chk.textContent = '跟注 ' + toCall.toFixed(0);
      chk.className = 'btn call';
    } else {
      chk.textContent = '过牌';
      chk.className = 'btn check';
    }
    var bet = $('btn-bet');
    if (S.betMode) {
      bet.textContent = '确认 ' + (S.betMode === 'raise' ? '加注到 ' : '下注 ') + S.betSize.toFixed(0);
    } else {
      bet.textContent = toCall > 0 ? '加注' : '下注';
    }
    bet.className = 'btn bet';

    $('btn-allin').innerHTML = '全下<span class="sub">' + (c ? (c.stacks[HERO] + toCall).toFixed(0) : '') + '</span>';
    $('btn-next').style.display = 'none';
    $('btn-allin').style.display = (c && c.stacks[HERO] > 0) ? '' : 'none';

    // 下注面板
    var ui = $('bet-ui');
    if (S.betMode && c) {
      ui.style.display = '';
      renderBetPresets();
      var sl = $('bet-slider');
      sl.min = S.betMin; sl.max = S.betMax;
      sl.value = S.betSize;
      $('bet-val').textContent = S.betSize.toFixed(0);
    } else {
      ui.style.display = 'none';
    }

    var dis = !canAct;
    ['btn-fold', 'btn-check', 'btn-bet', 'btn-allin'].forEach(function (id) {
      $(id).disabled = dis;
    });
    $('btn-next').disabled = !S.handOver;
  }

  function renderBetPresets() {
    var g = S.game, c = g.cur;
    var pot = c.committed[0] + c.committed[1];
    var toCall = g.toCallFor(HERO);
    var base = S.betMode === 'raise' ? (pot + toCall) : pot;
    var presets = [0.33, 0.5, 0.66, 1.0, 1.5];
    var row = $('bet-presets');
    row.innerHTML = presets.map(function (p) {
      var v = S.betMode === 'raise'
        ? Math.round(base * p) + toCall
        : Math.round(base * p);
      v = Math.min(Math.max(v, S.betMin), S.betMax);
      return '<button class="bet-btn" data-v="' + v + '">' + Math.round(p * 100) + '%池<br>' + v + '</button>';
    }).join('');
    Array.prototype.forEach.call(row.querySelectorAll('.bet-btn'), function (b) {
      b.onclick = function () {
        S.betSize = Number(b.getAttribute('data-v'));
        $('bet-slider').value = S.betSize;
        $('bet-val').textContent = S.betSize;
        renderActions();
      };
    });
  }

  function enableActions(on) {
    ['btn-fold', 'btn-check', 'btn-bet', 'btn-allin'].forEach(function (id) {
      $(id).disabled = !on;
    });
  }

  function renderResult() {
    var c = S.game.cur;
    if (!c || !c.result) { $('result-banner').innerHTML = ''; return; }
    var r = c.result;
    var win = r.winner === HERO;
    var txt = r.winner === -1 ? '平局' : (win ? '你赢了这手牌' : 'AI 赢了这手牌');
    var cls = r.winner === -1 ? '' : (win ? 'win' : 'lose');
    var net = r.heroNet;
    var detail = r.byFold
      ? (r.winner === HERO ? 'AI 弃牌' : '你弃牌')
      : (esc(r.heroHandDesc || '') + ' vs ' + esc(r.aiHandDesc || ''));
    var html = '<div class="result-banner">' +
      '<div class="big ' + cls + '">' + txt + '　' + (net >= 0 ? '+' : '') + net.toFixed(0) +
      ' (' + (net / S.game.bb >= 0 ? '+' : '') + (net / S.game.bb).toFixed(1) + ' BB)</div>' +
      '<div class="sub2">' + detail + ' · 底池 ' + r.pot.toFixed(0) + '</div>' +
      '</div>';
    $('result-banner').innerHTML = html;

    // 筹码耗尽自动补满（练习模式）
    if (S.game.heroStack <= 0 || S.game.aiStack <= 0) {
      setTimeout(function () {
        S.game.heroStack = S.game.startStack;
        S.game.aiStack = S.game.startStack;
        saveSession();
        renderTable();
        toast('筹码已自动补满，继续练习');
      }, 700);
    }
  }

  // ---------------- 起手牌范围表 ----------------
  var RANGE_COLORS = { a: '#e2574c', c: '#2fae6d', f: '#253a52' };
  var rangeMode = 'sbopen';

  var RANGE_META = {
    sbopen: {
      desc: '按钮位（小盲）翻前先行动。heads-up 中弃牌极少，约 90% 的手牌可玩 —— 强牌加注取价值，中等牌混合加注与 limp，最弱牌才弃牌。',
      labels: ['加注 2.5bb', '跟注补盲 limp', '弃牌']
    },
    bbopen: {
      desc: '大盲面对按钮位开池。底池赔率极好，防守范围很宽（约 80%）；3bet 约 20%，且必须极化 —— 强牌取价值，Axs / 同花连牌当诈唬。',
      labels: ['3bet', '跟注', '弃牌']
    },
    vs3bet: {
      desc: '面对 3bet：范围大幅收紧。4bet 要极化（超强牌 + Axs 类阻断牌诈唬），中间牌力跟注，其余弃牌。',
      labels: ['4bet', '跟注', '弃牌']
    },
    vs4bet: {
      desc: '面对 4bet：决策基本收敛为 5bet all-in 或弃牌，只保留极少量跟注。AA/KK 全下，部分 Axs 用作诈唬全下。',
      labels: ['5bet all-in', '跟注', '弃牌']
    }
  };

  function rangeRow(key) {
    var info = GTO.keyInfo(key);
    var play = GTO.RANGES.SB_PLAY[key] || 0;
    if (rangeMode === 'sbopen') {
      var rs = GTO.RANGES.SB_RAISE_SHARE(info);
      return { a: play * rs, c: play * (1 - rs), f: Math.max(0, 1 - play) };
    }
    if (rangeMode === 'bbopen') {
      var m = GTO.RANGES.BB_VS_OPEN(info);
      return { a: m.three, c: m.call, f: m.fold };
    }
    if (rangeMode === 'vs3bet') {
      var m2 = GTO.RANGES.VS_3BET(info);
      return { a: m2.three, c: m2.call, f: m2.fold };
    }
    var m3 = GTO.RANGES.VS_4BET(info);
    return { a: m3.three, c: m3.call, f: m3.fold };
  }

  function renderRangeChart(selectedKey) {
    var meta = RANGE_META[rangeMode];
    $('range-desc').textContent = meta.desc;
    $('lg-a').textContent = meta.labels[0];
    $('lg-c').textContent = meta.labels[1];
    $('lg-f').textContent = meta.labels[2];

    // 13x13：行 = 高牌（A 在上），列 = 低牌（A 在左）
    var order = 'AKQJT98765432'.split('');
    var html = '';
    for (var r = 0; r < 13; r++) {
      for (var c = 0; c < 13; c++) {
        var key;
        if (r === c) key = order[r] + order[c];
        else if (r < c) key = order[r] + order[c] + 's';
        else key = order[c] + order[r] + 'o';
        var d = rangeRow(key);
        var p1 = d.a * 100, p2 = (d.a + d.c) * 100;
        var bg = 'linear-gradient(90deg,' + RANGE_COLORS.a + ' 0 ' + p1.toFixed(1) + '%,' +
          RANGE_COLORS.c + ' ' + p1.toFixed(1) + '% ' + p2.toFixed(1) + '%,' +
          RANGE_COLORS.f + ' ' + p2.toFixed(1) + '% 100%)';
        html += '<div class="range-cell' + (key === selectedKey ? ' sel' : '') + '" data-k="' + key +
          '" style="background:' + bg + '">' + key + '</div>';
      }
    }
    $('range-grid').innerHTML = html;

    Array.prototype.forEach.call($('range-grid').querySelectorAll('.range-cell'), function (el) {
      el.onclick = function () { renderRangeChart(el.getAttribute('data-k')); };
    });

    // 详情
    if (selectedKey) {
      var info = GTO.keyInfo(selectedKey);
      var dd = rangeRow(selectedKey);
      var pf = PT.lookup(selectedKey);
      var rows = [
        { nm: meta.labels[0], v: dd.a, color: RANGE_COLORS.a },
        { nm: meta.labels[1], v: dd.c, color: RANGE_COLORS.c },
        { nm: meta.labels[2], v: dd.f, color: RANGE_COLORS.f }
      ];
      var totalA = 0, totalC = 0;
      var keys = GTO.ALL_KEYS;
      // 该手牌占总范围的比例（用于说明组合数）
      var combos = EQ.comboCount(selectedKey);
      $('range-detail').innerHTML =
        '<div class="range-detail-card">' +
        '<div class="rk">' + esc(selectedKey) +
        '<small>' + (info.isPair ? '口袋对子 · 6 种组合' : (info.isSuited ? '同花 · 4 种组合' : '非同花 · 12 种组合')) +
        ' · 胜率排名 ' + info.rank + '/169 · 对随机手牌胜率 ' + (pf ? (pf.equity * 100).toFixed(1) : '—') + '%</small></div>' +
        '<div class="mix-bar">' +
        '<i style="width:' + (dd.a * 100).toFixed(1) + '%;background:' + RANGE_COLORS.a + '"></i>' +
        '<i style="width:' + (dd.c * 100).toFixed(1) + '%;background:' + RANGE_COLORS.c + '"></i>' +
        '<i style="width:' + (dd.f * 100).toFixed(1) + '%;background:' + RANGE_COLORS.f + '"></i>' +
        '</div>' +
        rows.map(function (x) {
          return '<div class="mix-row"><span class="nm">' + esc(x.nm) + '</span>' +
            '<span class="bar"><i style="width:' + (x.v * 100).toFixed(0) + '%;background:' + x.color + '"></i></span>' +
            '<span class="pc">' + (x.v * 100).toFixed(0) + '%</span></div>';
        }).join('') +
        '<div class="hint-box" style="margin-top:8px">组合数 ' + combos +
        ' —— GTO 用频率而非「能不能玩」来定义范围：同一手牌常常是「70% 加注 + 30% 跟注」这样的混合策略，' +
        '目的是让对手无法通过你的动作反推出你的牌。</div>' +
        '</div>';
    } else {
      $('range-detail').innerHTML = '<div class="hint-box">点击任意格子查看该手牌的详细频率。</div>';
    }
  }

  // ---------------- 复盘视图 ----------------
  function renderReview() {
    var el = $('review-scroll');
    var g = S.game;
    if (!g || !g.hands.length) {
      el.innerHTML = '<div class="empty">还没有牌局记录<br>先打几手牌，再来这里看复盘</div>';
      return;
    }
    var rep = Recorder.buildReport(g);
    var st = rep.stats;
    var pctv = function (v) { return (v * 100).toFixed(0) + '%'; };

    var html = '';
    html += '<div class="section-title">总体表现 <span class="right">共 ' + rep.handCount + ' 手</span></div>';
    html += '<div class="grid3">' +
      card('总盈亏', (st.totalNetBB >= 0 ? '+' : '') + st.totalNetBB.toFixed(1) + ' BB', st.totalNet.toFixed(0) + ' 筹码', st.totalNetBB >= 0 ? 'var(--good)' : 'var(--bad)') +
      card('EV 损失', rep.totalEvLossBB.toFixed(1) + ' BB', '相对 GTO 最优线', rep.totalEvLossBB > 20 ? 'var(--bad)' : 'var(--warn)') +
      card('严重错误', rep.mistakeCounts.severe + '', '次', rep.mistakeCounts.severe > 0 ? 'var(--severe)' : 'var(--good)') +
      '</div>';
    html += '<div class="grid3" style="margin-top:8px">' +
      card('VPIP', pctv(st.vpip), '主动入池率') +
      card('PFR', pctv(st.pfr), '翻前加注率') +
      card('摊牌率', pctv(st.showdownRate), '打到摊牌') +
      '</div>';
    html += '<div class="grid2" style="margin-top:8px">' +
      card('攻击因子 AF', st.af.toFixed(2), '(下注+加注)/跟注') +
      card('翻前弃牌率', pctv(st.foldToNothing), '面对盲注直接弃') +
      '</div>';

    var mc = rep.mistakeCounts;
    html += '<div class="section-title">决策质量分布</div>';
    html += '<div class="cardx" style="display:flex;gap:6px;flex-wrap:wrap">' +
      badge('最优 ' + mc.best, 'ok') + badge('合理混合 ' + mc.mixed, 'mixed') +
      badge('可忽略 ' + mc.fine, 'ok') + badge('小失误 ' + mc.minor, 'minor') +
      badge('偏离 ' + mc.error, 'error') + badge('严重偏离 ' + mc.severe, 'severe') +
      '</div>';
    html += '<div class="hint-box" style="margin-top:8px">' +
      'GTO 是混合策略：同一手牌常常同时存在两三个正确选项（比如「70% 跟注 + 30% 加注」）。' +
      '所以判定失误看的不是「你有没有选到 EV 最高那一个」，而是你的选择是否落在 GTO 的合理分布内。' +
      '只有当行动方向或下注尺度明显偏离时，才计入 EV 损失。' +
      '</div>';

    html += '<div class="section-title">逐手复盘 <span class="right">点击展开决策详情</span></div>';
    rep.hands.slice().reverse().forEach(function (h) {
      var net = h.result.heroNet;
      var win = h.result.winner === 0;
      html += '<div class="hand-item" data-no="' + h.no + '">' +
        '<div class="r1">' +
        '<span class="no">#' + h.no + '</span>' +
        '<span class="cards">' + h.heroCards.map(function (x) { return cardHTML(x, '', true); }).join('') + '</span>' +
        '<span class="res ' + (h.result.winner === -1 ? 'd' : (win ? 'w' : 'l')) + '">' +
        (h.result.winner === -1 ? '平' : (win ? '胜' : '负')) + '</span>' +
        '<span class="net" style="color:' + (net >= 0 ? 'var(--good)' : 'var(--bad)') + '">' +
        (net >= 0 ? '+' : '') + net.toFixed(0) + '</span>' +
        '</div>' +
        '<div class="r2">' +
        '<span>对手 ' + h.aiCards.map(function (x) { return PE.cardText(x); }).join(' ') + '</span>' +
        (h.board.length ? '<span>牌面 ' + h.board.map(function (x) { return PE.cardText(x); }).join(' ') + '</span>' : '') +
        '<span>EV 损失 ' + h.evLossBB.toFixed(1) + ' BB</span>' +
        (h.mistakes ? '<span class="badge ' + (h.mistakes > 1 ? 'error' : 'minor') + '">' + h.mistakes + ' 处值得注意</span>' : '<span class="badge ok">无明显失误</span>') +
        '</div></div>';
    });

    el.innerHTML = html;

    Array.prototype.forEach.call(el.querySelectorAll('.hand-item'), function (it) {
      it.onclick = function () {
        var no = Number(it.getAttribute('data-no'));
        showHandDetail(no, it);
      };
    });
  }

  function showHandDetail(no, el) {
    var g = S.game;
    var rep = Recorder.buildReport(g);
    var h = null;
    rep.hands.forEach(function (x) { if (x.no === no) h = x; });
    if (!h) return;
    var existing = el.querySelector('.detail');
    if (existing) { existing.remove(); return; }

    var html = '<div class="detail" style="margin-top:8px;border-top:1px solid var(--line);padding-top:8px">';
    if (!h.decisions.length) {
      html += '<div class="hint-box">这手牌没有玩家决策点（可能全部由 AI 行动或直接弃牌）。</div>';
    }
    h.decisions.forEach(function (d) {
      html += '<div class="decision-item ' + d.level + '">' +
        '<div class="h">' +
        '<span class="st">' + d.streetName + '</span>' +
        '<span class="act">' + esc(d.actionName) + (d.size ? ' ' + d.size.toFixed(0) : '') + '</span>' +
        '<span class="badge ' + badgeClass(d.level) + '">' + d.levelText + '</span>' +
        (d.evLossBB > 0.05 ? '<span class="badge minor">EV -' + d.evLossBB.toFixed(1) + ' BB</span>' : '') +
        (d.sizeMatched === false && (d.action === 'bet' || d.action === 'raise')
          ? '<span class="badge mixed">尺度差 ' + d.sizeGapBB.toFixed(1) + ' BB</span>' : '') +
        '</div>' +
        '<div class="b">手牌：' + d.hole.map(function (x) { return PE.cardText(x); }).join(' ') +
        (d.board && d.board.length ? ' ｜ 牌面：' + d.board.map(function (x) { return PE.cardText(x); }).join(' ') : '') +
        '<br>胜率 ' + (d.equity * 100).toFixed(1) + '%' +
        (d.potOdds > 0 ? ' ｜ 底池赔率 ' + (d.potOdds * 100).toFixed(1) + '%' : '') +
        (d.handDesc ? ' ｜ ' + esc(d.handDesc) : '') + '</div>';

      if (d.best) {
        // GTO 里「EV 最高」与「最常出现的动作」往往不是同一个，两者都要展示
        var mainOpt = d.best;
        (d.options || []).forEach(function (o) { if ((o.freq || 0) > (mainOpt.freq || 0)) mainOpt = o; });
        var fmt = function (o) {
          var nm = Recorder.ACTION_NAMES[o.action] || o.action;
          var sz = (o.size && (o.action === 'bet' || o.action === 'raise')) ? ' ' + o.size.toFixed(0) : '';
          return nm + sz;
        };
        html += '<div class="cmp">GTO 主流：<b>' + esc(fmt(mainOpt)) + '</b>（' + (mainOpt.freq * 100).toFixed(0) + '%）' +
          '　EV 最高：' + esc(fmt(d.best)) + '<br><span class="vs">你的选择：' + esc(d.actionName) +
          (d.size ? ' ' + d.size.toFixed(0) : '') + '</span>' +
          (d.chosenFreq !== undefined ? '（该选项 GTO 频率 ' + (d.chosenFreq * 100).toFixed(0) + '%）' : '') + '</div>';
      }
      if (d.reasons && d.reasons.length) {
        html += '<div class="b" style="margin-top:3px">' + d.reasons.map(function (r) { return '· ' + esc(r); }).join('<br>') + '</div>';
      }
      html += '</div>';
    });
    html += '</div>';
    el.insertAdjacentHTML('beforeend', html);
  }

  function badgeClass(level) {
    return { best: 'ok', mixed: 'mixed', fine: 'ok', minor: 'minor', error: 'error', severe: 'severe' }[level] || 'ok';
  }
  function badge(text, cls) { return '<span class="badge ' + cls + '">' + esc(text) + '</span>'; }
  function card(k, v, hint, color) {
    return '<div class="cardx"><div class="k">' + esc(k) + '</div>' +
      '<div class="v" style="' + (color ? 'color:' + color : '') + '">' + esc(v) + '</div>' +
      '<div class="hint">' + esc(hint || '') + '</div></div>';
  }

  // ---------------- 回看视图 ----------------
  function renderReplayList() {
    var box = $('r-hand-list');
    var srcs = replaySources();
    if (!srcs.length) {
      box.innerHTML = '<div class="empty" style="padding:16px">暂无牌局</div>';
      return;
    }
    var html = '';
    srcs.forEach(function (src) {
      var active = (S.replay.source === src.id);
      html += '<div class="section-title" style="margin:10px 0 6px">' + esc(src.label) +
        (src.imported ? ' <span class="right">' + src.hands.length + ' 手 · 导入</span>'
          : ' <span class="right">' + src.hands.length + ' 手</span>') +
        (src.imported ? ' <button class="iconbtn small" data-del="' + src.id + '" style="margin-left:6px">删除</button>' : '') +
        '</div>';
      html += '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
        src.hands.slice().reverse().slice(0, 60).map(function (h) {
          var w = h.result.winner === 0 ? '胜' : (h.result.winner === 1 ? '负' : '平');
          var cls = active && S.replay.hand && S.replay.hand.no === h.no ? 'btn-tag' : '';
          return '<button class="iconbtn small ' + cls + '" data-src="' + src.id + '" data-h="' + h.no + '">#' + h.no + ' ' + w + '</button>';
        }).join('') + '</div>';
    });
    box.innerHTML = html;

    Array.prototype.forEach.call(box.querySelectorAll('[data-h]'), function (b) {
      b.onclick = function () { selectReplayHand(b.getAttribute('data-src'), Number(b.getAttribute('data-h'))); };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-del]'), function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var id = b.getAttribute('data-del');
        S.imports = S.imports.filter(function (x) { return x.id !== id; });
        saveImports();
        if (S.replay.source === id) { S.replay.source = 'self'; S.replay.hand = null; }
        renderReplayList();
        toast('已删除该导入牌局');
      };
    });
  }

  function selectReplayHand(sourceId, no) {
    var src = findSource(sourceId);
    if (!src) return;
    var h = null;
    src.hands.forEach(function (x) { if (x.no === no) h = x; });
    if (!h) return;
    stopPlay();
    S.replay.source = src.id;
    S.replay.hand = h;
    S.replay.frames = Recorder.buildReplayFrames(h);
    S.replay.idx = 0;
    renderReplayFrame();
    renderReplayList();
  }

  function renderReplayFrame() {
    var r = S.replay;
    if (!r.hand) { $('r-desc').textContent = '选择一手牌开始回看'; return; }
    var f = r.frames[r.idx];
    if (!f) return;

    $('r-street').textContent = Engine.STREET_NAMES[f.street || 0];
    $('r-pot').textContent = '底池 ' + (f.pot || 0).toFixed(0);

    // 手牌：逐步揭示 —— 第一帧起显示玩家手牌；AI 手牌在结果帧显示
    var heroCards = f.heroCards || [];
    $('r-cards-hero').innerHTML = heroCards.length
      ? heroCards.map(function (x) { return cardHTML(x, f.result && f.result.winner === 0 ? 'win' : ''); }).join('')
      : (cardBack() + cardBack());
    var revealAi = f.type === 'result' || S.peek;
    $('r-cards-ai').innerHTML = revealAi
      ? (f.aiCards || []).map(function (x) { return cardHTML(x, f.result && f.result.winner === 1 ? 'win' : ''); }).join('')
      : (cardBack() + cardBack());

    var bh = '';
    for (var i = 0; i < 5; i++) {
      bh += i < (f.board || []).length ? cardHTML(f.board[i], '') : '<div class="card hidden-c"></div>';
    }
    $('r-board').innerHTML = bh;
    $('r-chip-hero').textContent = '投入 ' + (f.committed ? f.committed[0].toFixed(0) : '—');
    $('r-chip-ai').textContent = '投入 ' + (f.committed ? f.committed[1].toFixed(0) : '—');

    $('r-step-text').textContent = (r.idx + 1) + ' / ' + r.frames.length;

    var desc = '';
    var opts = $('r-opt-list'), rs = $('r-reasons');
    if (f.type === 'result') {
      var w = f.result.winner;
      desc = (w === 0 ? '玩家胜' : (w === 1 ? 'AI 胜' : '平局')) +
        (f.result.byFold ? '（弃牌结束）' : '（' + (f.result.heroHandDesc || '') + ' vs ' + (f.result.aiHandDesc || '') + '）');
      opts.innerHTML = '';
      rs.innerHTML = '';
    } else if (f.action) {
      var a = f.action;
      desc = (a.seat === 0 ? '玩家' : 'AI') + ' ' + (Recorder.ACTION_NAMES[a.action] || a.action) +
        (a.size ? ' ' + a.size.toFixed(0) : '') + ' ｜ 胜率 ' + (a.equity * 100).toFixed(1) + '%' +
        (a.potOdds > 0 ? ' ｜ 底池赔率 ' + (a.potOdds * 100).toFixed(1) + '%' : '');
      if (a.seat === 0 && a.options && a.options.length) {
        var maxEv = -Infinity;
        a.options.forEach(function (o) { if ((o.ev || 0) > maxEv) maxEv = o.ev || 0; });
        opts.innerHTML = a.options.map(function (o) {
          var nm = Recorder.ACTION_NAMES[o.action] || o.action;
          var sz = (o.size && (o.action === 'bet' || o.action === 'raise')) ? ' ' + o.size.toFixed(0) : '';
          var isBest = Math.abs((o.ev || 0) - maxEv) < 0.01;
          return '<div class="opt ' + (isBest ? 'best' : '') + '">' +
            '<span class="a">' + esc(nm + sz) + '</span>' +
            '<span class="fb"><span class="bar"><i style="width:' + (o.freq * 100).toFixed(0) + '%"></i></span></span>' +
            '<span class="f">' + (o.freq * 100).toFixed(0) + '%</span>' +
            '<span class="e">EV ' + (o.ev || 0).toFixed(1) + '</span></div>';
        }).join('');
        rs.innerHTML = (a.reasons || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
      } else {
        opts.innerHTML = '';
        rs.innerHTML = a.seat === 0 ? '<li>此牌局为导入的分享数据，不含 GTO 明细</li>' : '';
      }
    } else {
      desc = f.text || '';
      opts.innerHTML = '';
      rs.innerHTML = '';
    }
    $('r-desc').textContent = desc;
  }

  function replayStep(d) {
    var r = S.replay;
    if (!r.hand) return;
    r.idx = Math.max(0, Math.min(r.frames.length - 1, r.idx + d));
    renderReplayFrame();
  }
  function startPlay() {
    var r = S.replay;
    if (!r.hand) { toast('先选择一手牌'); return; }
    if (r.idx >= r.frames.length - 1) r.idx = 0;
    $('btn-r-play').textContent = '⏸ 暂停';
    r.timer = setInterval(function () {
      if (r.idx >= r.frames.length - 1) { stopPlay(); return; }
      replayStep(1);
    }, 1100);
  }
  function stopPlay() {
    var r = S.replay;
    if (r.timer) { clearInterval(r.timer); r.timer = null; }
    $('btn-r-play').textContent = '▶ 自动播放';
  }

  // ---------------- 分享 ----------------
  function openShare() {
    $('share-code').value = '';
    $('share-text').value = '';
    $('import-code').value = '';
    $('modal-share').classList.add('show');
  }

  // ---------------- 事件绑定 ----------------
  function bindEvents() {
    // 底部导航
    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (b) {
      b.onclick = function () {
        var v = b.getAttribute('data-view');
        Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        VIEWS.forEach(function (n) {
          $('view-' + n).classList.toggle('show', n === v);
        });
        if (v === 'range') renderRangeChart();
        if (v === 'review') renderReview();
        if (v === 'replay') {
          renderReplayList();
          if (!S.replay.hand && S.game.hands.length) {
            selectReplayHand('self', S.game.hands[S.game.hands.length - 1].no);
          }
        }
      };
    });

    // 动作按钮
    $('btn-fold').onclick = function () {
      if (!S.pending) return;
      if (S.betMode) { S.betMode = null; renderActions(); return; }  // 下注面板里当作「取消」
      onHeroAction('fold', 0);
    };
    $('btn-check').onclick = function () {
      if (!S.pending) return;
      var g = S.game;
      if (g.toCallFor(HERO) > 0) onHeroAction('call', 0);
      else onHeroAction('check', 0);
    };
    $('btn-bet').onclick = function () {
      if (!S.pending) return;
      var g = S.game, c = g.cur;
      if (!S.betMode) {
        var toCall = g.toCallFor(HERO);
        S.betMode = toCall > 0 ? 'raise' : 'bet';
        var pot = c.committed[0] + c.committed[1];
        // 默认取 GTO 建议的主动额度
        var suggest = null;
        var adv = S.pending.advice;
        for (var i = 0; i < adv.options.length; i++) {
          if (adv.options[i].action === (S.betMode === 'raise' ? 'raise' : 'bet')) { suggest = adv.options[i].size; break; }
        }
        if (!suggest) suggest = Math.round((S.betMode === 'raise' ? pot + toCall : pot) * 0.66);
        if (S.betMode === 'raise') suggest += toCall;

        var maxAll = c.stacks[HERO] + (S.betMode === 'raise' ? toCall : 0);
        // 主动下注最小为一个大盲；加注最小为合法最小加注额
        S.betMin = S.betMode === 'bet'
          ? Math.min(g.bb, c.stacks[HERO])
          : Math.min(g.minRaiseTo(HERO), maxAll);
        S.betMax = maxAll;
        S.betSize = Math.min(Math.max(suggest, S.betMin), S.betMax);
        renderActions();
      } else {
        var act = S.betMode === 'raise' ? 'raise' : 'bet';
        onHeroAction(act, S.betSize);
      }
    };
    $('btn-allin').onclick = function () {
      if (!S.pending) return;
      onHeroAction('allin', 0);
    };
    $('btn-next').onclick = function () {
      if (!S.handOver) return;
      startHand();
    };

    $('bet-slider').oninput = function () {
      S.betSize = Number(this.value);
      $('bet-val').textContent = S.betSize.toFixed(0);
      renderActions();
    };

    // 范围表模式切换
    Array.prototype.forEach.call($('seg-range').querySelectorAll('button'), function (b) {
      b.onclick = function () {
        Array.prototype.forEach.call($('seg-range').querySelectorAll('button'), function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        rangeMode = b.getAttribute('data-r');
        renderRangeChart();
      };
    });

    // 顶栏
    $('btn-coach-toggle').onclick = function () {
      S.coach = !S.coach;
      saveSettings();
      applySettingsToUI();
      renderCoach();
      toast(S.coach ? '教练模式已开启' : '教练模式已关闭（考试模式）');
    };
    $('btn-settings').onclick = function () { $('modal-settings').classList.add('show'); };
    $('btn-share').onclick = openShare;
    $('btn-new').onclick = function () {
      if (confirm('开始新的一局？当前牌局记录会被清空。')) {
        newGame(true);
        toast('已开始新局');
        switchView('game');
      }
    };

    // 设置弹窗
    $('sw-coach').onclick = function () { S.coach = !S.coach; this.classList.toggle('on', S.coach); };
    $('sw-peek').onclick = function () { S.peek = !S.peek; this.classList.toggle('on', S.peek); renderTable(); renderReplayFrame(); };
    Array.prototype.forEach.call($('seg-diff').querySelectorAll('button'), function (b) {
      b.onclick = function () {
        Array.prototype.forEach.call($('seg-diff').querySelectorAll('button'), function (x) { x.classList.remove('on'); });
        b.classList.add('on');
      };
    });
    Array.prototype.forEach.call($('seg-speed').querySelectorAll('button'), function (b) {
      b.onclick = function () {
        Array.prototype.forEach.call($('seg-speed').querySelectorAll('button'), function (x) { x.classList.remove('on'); });
        b.classList.add('on');
      };
    });
    $('btn-apply-settings').onclick = function () {
      var d = $('seg-diff').querySelector('.on');
      var sp = $('seg-speed').querySelector('.on');
      S.difficulty = d ? d.getAttribute('data-d') : S.difficulty;
      S.speed = sp ? Number(sp.getAttribute('data-s')) : S.speed;
      S.stackBB = Number($('sel-stack').value);
      saveSettings();
      if (S.game) S.game.difficulty = S.difficulty;
      $('modal-settings').classList.remove('show');
      renderTable();
      toast('设置已保存');
    };

    Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) {
      b.onclick = function () { this.closest('.modal-mask').classList.remove('show'); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('.modal-mask'), function (m) {
      m.onclick = function (e) { if (e.target === m) m.classList.remove('show'); };
    });

    // 分享弹窗
    $('btn-gen-code').onclick = async function () {
      try {
        var code = await Recorder.toShareCode(S.game);
        $('share-code').value = code;
        toast('分享码已生成（' + code.length + ' 字符）');
      } catch (e) {
        toast('生成失败：' + e.message);
      }
    };
    $('btn-copy-code').onclick = function () { copyText($('share-code').value, '分享码'); };
    $('btn-gen-text').onclick = function () {
      $('share-text').value = Recorder.toSummaryText(S.game);
      toast('文字战报已生成');
    };
    $('btn-copy-text').onclick = function () { copyText($('share-text').value, '文字战报'); };
    $('btn-export-json').onclick = function () {
      var txt = Recorder.toJSONFile(S.game);
      download('gto-poker-' + new Date().toISOString().slice(0, 10) + '.json', txt);
      toast('已导出 JSON 文件');
    };
    $('btn-import').onclick = async function () {
      var v = $('import-code').value.trim();
      if (!v) { toast('请先粘贴内容'); return; }
      try {
        var data;
        if (v[0] === '{') data = Recorder.fromJSONFile(v);
        else data = await Recorder.fromShareCode(v);
        if (!data || !data.hands) throw new Error('内容无法识别');
        applyImported(data);
      } catch (e) {
        toast('导入失败：' + e.message);
      }
    };

    // 回看控制
    $('btn-r-prev').onclick = function () { stopPlay(); replayStep(-1); };
    $('btn-r-next').onclick = function () { stopPlay(); replayStep(1); };
    $('btn-r-play').onclick = function () { S.replay.timer ? stopPlay() : startPlay(); };
    $('btn-r-first').onclick = function () { stopPlay(); S.replay.idx = 0; renderReplayFrame(); };
  }

  var importSeq = 0;
  function applyImported(data) {
    // 导入的牌局独立存放，不覆盖当前对局记录
    var id = 'imp' + Date.now() + '_' + (++importSeq);
    var d = new Date();
    var label = '导入 · ' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
      ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    S.imports.push({
      id: id,
      label: label,
      imported: true,
      bb: data.bb || 2,
      stack: data.stack || 200,
      difficulty: data.difficulty || 'standard',
      hands: data.hands
    });
    saveImports();
    switchView('replay');
    renderReplayList();
    selectReplayHand(id, data.hands[data.hands.length - 1].no);
    toast('已导入 ' + data.hands.length + ' 手牌，可在回看中查看（不影响当前牌局）');
  }

  function switchView(v) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (x) {
      x.classList.toggle('active', x.getAttribute('data-view') === v);
    });
    VIEWS.forEach(function (n) {
      $('view-' + n).classList.toggle('show', n === v);
    });
    if (v === 'range') renderRangeChart();
    if (v === 'review') renderReview();
    if (v === 'replay') renderReplayList();
  }

  function applySettingsToUI() {
    $('btn-coach-toggle').classList.toggle('active', S.coach);
    $('btn-coach-toggle').title = S.coach ? '教练模式：开启（点击进入考试模式）' : '教练模式：关闭（考试模式）';
    $('sw-coach').classList.toggle('on', S.coach);
    $('sw-peek').classList.toggle('on', S.peek);
    Array.prototype.forEach.call($('seg-diff').querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-d') === S.difficulty);
    });
    Array.prototype.forEach.call($('seg-speed').querySelectorAll('button'), function (b) {
      b.classList.toggle('on', Number(b.getAttribute('data-s')) === S.speed);
    });
    $('sel-stack').value = String(S.stackBB);
  }

  function copyText(txt, name) {
    if (!txt) { toast('没有可复制的内容'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast(name + '已复制'); },
        function () { fallbackCopy(txt, name); });
    } else fallbackCopy(txt, name);
  }
  function fallbackCopy(txt, name) {
    var ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(name + '已复制'); }
    catch (e) { toast('复制失败，请手动选择复制'); }
    document.body.removeChild(ta);
  }
  function download(filename, text) {
    var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 100);
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2000);
  }

  // 对外暴露只读句柄（供自动化测试与调试排查使用）
  window.__GTO_POKER__ = {
    get state() { return S; },
    PE: PE, Recorder: Recorder, Engine: Engine, GTO: GTO
  };

  // 启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else init();
})();
