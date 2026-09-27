/*
 * ui.js — 界面与交互
 */
(function () {
  'use strict';
  // 用 window.X 取值：脚本没加载/被缓存成旧版时只会得到 undefined，
  // 而不会直接抛 ReferenceError 让整个 UI 静默白屏（启动自检会给出可见提示）。
  var PE = window.PokerEval, PT = window.PreflopTable, EQ = window.Equity,
    GTO = window.GTO, Engine = window.Engine, Recorder = window.Recorder;

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
    tableSize: 2,         // 牌桌人数：2 / 3 / 4 / 6
    pending: null,        // hero 待决策 {state, advice}
    betMode: null,        // null | 'bet' | 'raise'
    betSize: 0,
    busy: false,
    handOver: false,
    imports: [],          // 导入的他人的牌局（只用于回看，不影响当前对局）
    replay: { source: 'self', hand: null, frames: [], idx: 0, timer: null }
  };

  // 座位分区：玩家（座位 0）固定在下排，其余座位按人数分配到 左 / 上 / 右 三个区域。
  // 用分区 flex 布局代替绝对定位，保证任何人数下座位都不越出牌桌边界。
  var SEAT_ZONES = {
    2: { top: [1], left: [], right: [], bottom: [0] },
    3: { top: [1, 2], left: [], right: [], bottom: [0] },
    4: { top: [2], left: [1], right: [3], bottom: [0] },
    5: { top: [2, 3], left: [1], right: [4], bottom: [0] },
    6: { top: [2, 3, 4], left: [1], right: [5], bottom: [0] }
  };
  var SEAT_ZONE_ORDER = ['top', 'left', 'right', 'bottom'];

  /**
   * 把座位渲染到四个分区容器里。
   * @param prefix 容器 ID 前缀：'seats-'（牌桌）或 'r-seats-'（回看）
   * @param n      牌桌人数
   * @param render 单个座位的 HTML 生成函数 (seat) => html
   */
  function renderSeatsInto(prefix, n, render) {
    var z = SEAT_ZONES[n] || SEAT_ZONES[2];
    SEAT_ZONE_ORDER.forEach(function (zone) {
      var el = $(prefix + zone);
      if (!el) return;
      el.innerHTML = (z[zone] || []).map(render).join('');
    });
  }

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

  /* ---------------- 启动自检 ----------------
   * 部署后最常见的问题是「index.html 与 js 版本不一致」或「浏览器缓存了旧文件」，
   * 表现为页面白屏、点什么都没反应。这里主动检查，把问题直接显示给用户。 */
  var BUILD = (document.body && document.body.getAttribute('data-build')) || '未知';
  var REQUIRED_IDS = [
    'app-title', 'table-area', 'seats-top', 'seats-left', 'seats-right', 'seats-bottom',
    'street-label', 'board-cards', 'pot-display',
    'replay-table', 'r-seats-top', 'r-seats-left', 'r-seats-right', 'r-seats-bottom',
    'r-street', 'r-board', 'r-pot',
    'seg-players', 'seg-diff', 'seg-speed', 'sel-stack', 'build-tag'
  ];
  function missingIds() {
    return REQUIRED_IDS.filter(function (id) { return !$(id); });
  }
  function showFatal(msg) {
    if ($('fatal-box')) return;
    var box = document.createElement('div');
    box.id = 'fatal-box';
    box.className = 'fatal';
    box.innerHTML =
      '<div class="fatal-card">' +
      '<h3>页面启动失败</h3>' +
      '<p class="msg">' + esc(msg) + '</p>' +
      '<p class="hint">最常见原因是浏览器或托管平台缓存了旧版本文件：' +
      'index.html 是新的，但 js / css 还是旧的（或反过来）。' +
      '点下面的按钮强制刷新；若仍不行，请在浏览器里清除该站点的缓存，或换无痕模式打开。</p>' +
      '<p class="hint">当前构建号：<b>' + esc(BUILD) + '</b></p>' +
      '<button class="btn primary" id="fatal-reload">强制刷新</button>' +
      '</div>';
    (document.body || document.documentElement).appendChild(box);
    var btn = $('fatal-reload');
    if (btn) btn.onclick = function () {
      var sep = location.search ? '&' : '?';
      location.replace(location.pathname + location.search + sep + '_cb=' + Date.now());
    };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 遍历分段控件里的按钮；容器不存在时静默跳过，避免旧版 HTML 直接让初始化崩掉
  function eachSegBtn(id, fn) {
    var el = $(id);
    if (!el) return;
    Array.prototype.forEach.call(el.querySelectorAll('button'), fn);
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
      if (d.tableSize) S.tableSize = d.tableSize;
      else if (d.players) S.tableSize = d.players;
    } catch (e) { }
  }
  function saveSettings() {
    try {
      localStorage.setItem(LS_SET, JSON.stringify({
        coach: S.coach, peek: S.peek, difficulty: S.difficulty, speed: S.speed,
        stackBB: S.stackBB, tableSize: S.tableSize
      }));
    } catch (e) { }
  }
  function saveSession() {
    if (!S.game) return;
    try {
      var d = Recorder.serialize(S.game, true);
      d.heroStack = S.game.heroStack;
      d.aiStack = S.game.aiStack;
      d.chips = S.game.chips.slice();
      d.button = S.game.button;
      d.handNo = S.game.handNo;
      d.players = S.game.n;
      localStorage.setItem(LS_SES, JSON.stringify(d));
    } catch (e) { console.warn('保存失败', e); }
  }
  function loadSession() {
    try {
      var raw = localStorage.getItem(LS_SES);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d.hands || !d.hands.length) return null;
      var n = Math.max(2, Math.min(6, d.players || 2));
      var g = new Engine.Game({ bb: d.bb || 2, stack: d.stack || 200, difficulty: d.difficulty || S.difficulty, players: n });
      var des = Recorder.deserialize(d);
      g.hands = des.hands;
      if (Array.isArray(d.chips) && d.chips.length === n) {
        for (var i = 0; i < n; i++) g.chips[i] = d.chips[i];
      } else {
        g.heroStack = d.heroStack != null ? d.heroStack : g.startStack;
        g.aiStack = d.aiStack != null ? d.aiStack : g.startStack;
      }
      g.button = d.button != null ? d.button : AI;
      g.handNo = d.handNo || des.hands.length;
      return g;
    } catch (e) { return null; }
  }

  // ---------------- 初始化 ----------------
  function init() {
    loadSettings();
    S.game = loadSession();
    if (S.game) S.tableSize = S.game.n;   // 恢复未结束的牌局时沿用其人数
    else newGame(false);
    updateTitle();
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
      difficulty: S.difficulty,
      players: S.tableSize
    });
    S.handOver = true;
    S.pending = null;
    S.betMode = null;
    // 新局与旧牌局无关，清空回看里的旧选中
    stopPlay();
    S.replay.source = 'self';
    S.replay.hand = null;
    S.replay.frames = [];
    S.replay.idx = 0;
    updateTitle();
    if (save !== false) saveSession();
    renderAll();
    startHand();
  }

  function updateTitle() {
    var el = $('app-title');
    if (!el) { console.warn('missing app-title'); return; }
    el.innerHTML = '<span class="dot"></span>GTO ' +
      (S.tableSize === 2 ? '单挑' : S.tableSize + ' 人桌') + '练习';
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
      // AI 座位（多人桌时按顺序依次决策）
      enableActions(false);
      renderTable();
      setSeatBubble(actor, '思考中…', true);
      var res = g.aiDecide(actor);
      var thinkTime = Math.min(S.speed, 900) * (S.game.n > 4 ? 0.55 : 1);
      setTimeout(function () {
        var ch = res.chosen;
        g.applyAction(actor, ch.action, ch.size);
        renderAll();
        setTimeout(loop, S.speed * 0.5);
      }, thinkTime);
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
    var n = g.n;
    var showdown = !!c.result;
    var reveal = showdown || S.peek;
    var actor = c.result ? null : g.nextActor();

    $('street-label').textContent = Engine.STREET_NAMES[c.street];
    $('table-area').className = 'table-area n' + n;

    // 公共牌
    var bh = '';
    for (var i = 0; i < 5; i++) {
      bh += i < c.board.length ? cardHTML(c.board[i], '') : '<div class="card hidden-c"></div>';
    }
    $('board-cards').innerHTML = bh;
    $('pot-display').textContent = '底池 ' + g.totalPot().toFixed(0);

    // 座位：按人数分配到上 / 左 / 右 / 下四个区域
    renderSeatsInto('seats-', n, function (s) {
      return seatHTML(g, c, s, actor, reveal, showdown);
    });
  }

  function seatHTML(g, c, seat, actor, reveal, showdown) {
    var isHero = seat === HERO;
    var cls = 'pseat';
    if (isHero) cls += ' me';
    if (actor === seat) cls += ' turn';
    if (c.folded[seat]) cls += ' folded';
    if (showdown && c.result.winners.indexOf(seat) >= 0) cls += ' winner';

    var label = c.posLabel[seat] || '';
    var isBtn = c.button === seat;
    var isBlind = (seat === c.sbSeat || seat === c.bbSeat);
    var stack = c.result ? g.chips[seat] : c.stacks[seat];
    var bet = c.streetBets[seat];

    // 手牌
    var hole = c.holes[seat] || [];
    var cardsHtml;
    if (!hole.length) {
      cardsHtml = '';
    } else if (isHero || reveal) {
      var winCls = (showdown && c.result.winners.indexOf(seat) >= 0) ? 'win' : '';
      cardsHtml = hole.map(function (x) { return cardHTML(x, winCls); }).join('');
    } else {
      cardsHtml = cardBack() + cardBack();
    }

    // 气泡：优先显示本街下注额，否则显示上一个动作
    var bubHtml = '', bubCls = 'bub';
    if (!c.result) {
      if (bet > 0) { bubCls += ' bet'; bubHtml = '下注 ' + bet.toFixed(0); }
      else {
        var last = lastActionOf(c, seat);
        if (last) bubHtml = actionText(last);
      }
    } else if (c.result.byFold && c.folded[seat]) {
      bubHtml = '弃牌';
    }
    if (!bubHtml) bubCls += ' hide';

    return '<div class="' + cls + '" id="pseat-' + seat + '">' +
      '<div class="av">' + esc(isHero ? '我' : shortName(g.players[seat].name)) +
      (isBtn ? '<span class="dealer">D</span>' : '') + '</div>' +
      '<div class="nm">' + esc(isHero ? '我' : shortName(g.players[seat].name)) +
      '<span class="tag' + (isBtn ? ' btn-tag' : '') + '">' + esc(label) + '</span></div>' +
      '<div class="ch">' + stack.toFixed(0) + '</div>' +
      '<div class="hc" id="cards-' + seat + '">' + cardsHtml + '</div>' +
      '<div class="' + bubCls + '" id="bub-' + seat + '">' + esc(bubHtml) + '</div>' +
      '</div>';
  }

  function shortName(name) {
    if (!name) return 'AI';
    return name.length > 4 ? name.slice(0, 4) : name;
  }

  function setSeatBubble(seat, text, active) {
    var el = $('bub-' + seat);
    if (!el) return;
    el.textContent = text || '';
    el.className = 'bub' + (active ? ' act' : '') + (text ? '' : ' hide');
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
    var posTxt = st.posLabel ? (st.posLabel + ' 位') : '';
    if (st.oppsAfter === 0) posTxt += ' · 最后行动（有利）';
    else if (st.oppsAfter === st.liveOpponents) posTxt += ' · 最先行动（不利）';
    else posTxt += ' · 身后还有 ' + st.oppsAfter + ' 人';
    $('coach-desc').textContent = (adv.handDesc || st.holeKey || '') +
      (posTxt ? ' · ' + posTxt : '') +
      (st.liveOpponents > 1 ? ' · ' + (st.liveOpponents + 1) + ' 人底池' : '');
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
    var pot = g.totalPot();
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
    var c = S.game.cur, g = S.game;
    if (!c || !c.result) { $('result-banner').innerHTML = ''; return; }
    var r = c.result;
    var net = r.heroNet;
    var heroWon = net > 0;
    var heroLost = net < 0;
    var txt, cls;
    if (r.winners.indexOf(HERO) >= 0 && r.winners.length === 1) { txt = '你赢了这手牌'; cls = 'win'; }
    else if (r.winners.indexOf(HERO) >= 0) { txt = '你参与平分底池'; cls = 'win'; }
    else if (r.winners.length > 1) { txt = '对手分池，你未获奖'; cls = 'lose'; }
    else if (r.winner >= 0) { txt = '座位' + r.winner + '赢了这手牌'; cls = 'lose'; }
    else { txt = '平局'; cls = ''; }

    var detail = r.byFold
      ? (r.winners.indexOf(HERO) >= 0 ? '对手弃牌' : '你弃牌')
      : (esc(r.heroHandDesc || '') + (g.n > 2 ? '' : ' vs ' + esc(r.aiHandDesc || '')));

    // 多人桌：列出各家的摊牌牌力
    var playersHtml = '';
    if (!r.byFold && r.players && r.players.length > 2) {
      playersHtml = '<div class="result-players">' + r.players.filter(function (p) {
        return !p.folded && p.handDesc;
      }).map(function (p) {
        var won = r.winners.indexOf(p.seat) >= 0;
        return '<div class="rp' + (won ? ' won' : '') + '">' +
          '<span class="who">' + esc(p.seat === 0 ? '我' : shortName(p.name)) + '</span>' +
          '<span class="hd">' + esc(p.handDesc) + '</span>' +
          (won ? '<span class="hd">· +' + p.prize.toFixed(0) + '</span>' : '') +
          '</div>';
      }).join('') + '</div>';
    }

    // 边池信息
    var potsHtml = '';
    if (r.pots && r.pots.length > 1) {
      potsHtml = '<div class="sub3">分池：' + r.pots.map(function (p, i) {
        return '池' + (i + 1) + ' ' + p.amount.toFixed(0) +
          (p.contested ? '' : '（退还）');
      }).join(' · ') + '</div>';
    }

    var html = '<div class="result-banner">' +
      '<div class="big ' + cls + '">' + txt + '　' + (net >= 0 ? '+' : '') + net.toFixed(0) +
      ' (' + (net / S.game.bb >= 0 ? '+' : '') + (net / S.game.bb).toFixed(1) + ' BB)</div>' +
      '<div class="sub2">' + detail + ' · 底池 ' + r.pot.toFixed(0) + '</div>' +
      potsHtml +
      playersHtml +
      '</div>';
    $('result-banner').innerHTML = html;

    // 有人筹码耗尽 → 全员自动补满（练习模式）
    var broke = false;
    for (var s = 0; s < g.n; s++) if (g.chips[s] <= 0) broke = true;
    if (broke) {
      setTimeout(function () {
        for (var q = 0; q < g.n; q++) g.chips[q] = g.startStack;
        saveSession();
        renderTable();
        toast('筹码已自动补满，继续练习');
      }, 700);
    }
  }

  // ---------------- 起手牌范围表 ----------------
  var RANGE_COLORS = { a: '#e2574c', c: '#2fae6d', f: '#253a52' };
  var rangeMode = 'sbopen';

  // 单挑：沿用 SB/BB 对抗模型；多人桌：按位置的开池范围
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

  // 多人桌各位置的开池范围
  var OPEN_META = {
    UTG: {
      desc: 'UTG（枪口位）：按钮左侧第一个行动，身后还有 5 个人可能 squeeze，范围最紧。这里的手牌需要能承受多人底池与不利位置。',
      labels: ['加注开池', '补齐 limp', '弃牌']
    },
    MP: {
      desc: 'MP（中间位）：身后仍有 3-4 人未行动，范围比 UTG 明显放宽，但依然要避免那些只在单挑中才有价值的牌。',
      labels: ['加注开池', '补齐 limp', '弃牌']
    },
    CO: {
      desc: 'CO（切位）：只剩按钮和小盲两个盲位，位置优势明显，开池范围可以放到接近 40%，同花连牌与中小对子都开始可玩。',
      labels: ['加注开池', '补齐 limp', '弃牌']
    },
    BTN: {
      desc: 'BTN（按钮位）：翻后永远最后一个行动，这是最有价值的位置。约一半的手牌可以开池，同花小牌、宽范围连张都在这里发挥作用。',
      labels: ['加注开池', '补齐 limp', '弃牌']
    },
    SB: {
      desc: 'SB（小盲）：已经投了半个大盲，补齐的赔率很好，但翻后要在不利位置对抗大盲。策略是混合加注与补齐，弃牌只留给最弱的牌。',
      labels: ['加注开池', '补齐 limp', '弃牌']
    }
  };

  function isRingTable() { return S.tableSize > 2; }

  function rangeRow(key) {
    var info = GTO.keyInfo(key);

    if (isRingTable() && OPEN_META[rangeMode]) {
      var w = GTO.openWeight(rangeMode, key);
      // 小盲可以补齐（limp），其余位置只有加注或弃牌
      var limpShare = (rangeMode === 'SB') ? 0.20 : 0;
      return { a: w * (1 - limpShare), c: w * limpShare, f: Math.max(0, 1 - w) };
    }

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

  // 范围表模式按钮：多人桌按位置展示开池范围，单挑展示 SB/BB 对抗模型
  function renderRangeModes() {
    var modes = isRingTable()
      ? ['UTG', 'MP', 'CO', 'BTN', 'SB']
      : ['sbopen', 'bbopen', 'vs3bet', 'vs4bet'];
    var titles = {
      UTG: 'UTG 开池', MP: 'MP 开池', CO: 'CO 开池', BTN: 'BTN 开池', SB: 'SB 开池'
    };
    if (modes.indexOf(rangeMode) < 0) rangeMode = modes[0];
    var box = $('seg-range');
    box.innerHTML = modes.map(function (m) {
      return '<button data-r="' + m + '"' + (m === rangeMode ? ' class="on"' : '') + '>' +
        esc(titles[m] || m) + '</button>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('button'), function (b) {
      b.onclick = function () {
        Array.prototype.forEach.call(box.querySelectorAll('button'), function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        rangeMode = b.getAttribute('data-r');
        renderRangeChart();
      };
    });
    renderRangeChart();
  }

  function renderRangeChart(selectedKey) {
    var meta = isRingTable() ? (OPEN_META[rangeMode] || OPEN_META.UTG) : RANGE_META[rangeMode];
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
    var modeTxt = g.n === 2 ? '单挑' : g.n + ' 人桌';

    var html = '';
    html += '<div class="section-title">总体表现 <span class="right">' + modeTxt + ' · 共 ' + rep.handCount + ' 手</span></div>';
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
      var heroWon = (h.result.winners || []).indexOf(0) >= 0;
      var resCls = heroWon ? 'w' : (net < 0 ? 'l' : 'd');
      var holes = h.holes || [h.heroCards, h.aiCards];
      html += '<div class="hand-item" data-no="' + h.no + '">' +
        '<div class="r1">' +
        '<span class="no">#' + h.no + '</span>' +
        '<span class="cards">' + (h.heroCards || []).map(function (x) { return cardHTML(x, '', true); }).join('') + '</span>' +
        '<span class="res ' + resCls + '">' + (heroWon ? '胜' : (net < 0 ? '负' : '平')) + '</span>' +
        '<span class="net" style="color:' + (net >= 0 ? 'var(--good)' : 'var(--bad)') + '">' +
        (net >= 0 ? '+' : '') + net.toFixed(0) + '</span>' +
        '</div>' +
        '<div class="r2">' +
        (g.n > 2
          ? '<span>其他底牌 ' + holes.map(function (x, i) {
              return i === 0 ? null : (x ? x.map(function (y) { return PE.cardText(y); }).join('') : '—');
            }).filter(Boolean).join(' / ') + '</span>'
          : '<span>对手 ' + (h.aiCards || []).map(function (x) { return PE.cardText(x); }).join(' ') + '</span>') +
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

  /**
   * 确保回看里选中的是当前数据源里真实存在的一手牌。
   * 切换人数开新局后，旧的选中对象会从 hands 里消失，需要重新指向最新一手。
   */
  function ensureReplaySelection() {
    var src = findSource(S.replay.source);
    if (S.replay.hand && src && src.hands.indexOf(S.replay.hand) >= 0) return;
    var self = findSource('self');
    if (self && self.hands.length) {
      selectReplayHand('self', self.hands[self.hands.length - 1].no);
      return;
    }
    S.replay.hand = null;
    S.replay.frames = [];
    S.replay.idx = 0;
    renderReplayFrame();
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
    var n = f.players || (f.holes && f.holes.length) || 2;

    $('r-street').textContent = Engine.STREET_NAMES[f.street || 0];
    $('r-pot').textContent = '底池 ' + (f.pot || 0).toFixed(0);

    var bh = '';
    for (var i = 0; i < 5; i++) {
      bh += i < (f.board || []).length ? cardHTML(f.board[i], '') : '<div class="card hidden-c"></div>';
    }
    $('r-board').innerHTML = bh;

    // 座位：逐步揭示 —— 玩家手牌始终可见，其他座位在结果帧或开启「透视」时揭示
    var revealAll = f.type === 'result' || S.peek;
    var winners = (f.result && f.result.winners) || [];
    renderSeatsInto('r-seats-', n, function (s) {
      var hole = (f.holes && f.holes[s]) || null;
      var isHero = s === 0;
      var cls = 'pseat' + (isHero ? ' me' : '') +
        (f.result && winners.indexOf(s) >= 0 ? ' winner' : '');
      var folded = (f.result && f.result.players && f.result.players[s]) ? f.result.players[s].folded : false;
      if (folded) cls += ' folded';
      var cards;
      if (!hole) cards = '';
      else if (isHero || revealAll) {
        cards = hole.map(function (x) {
          return cardHTML(x, (f.result && winners.indexOf(s) >= 0) ? 'win' : '');
        }).join('');
      } else {
        cards = cardBack() + cardBack();
      }
      var com = (f.committed && f.committed[s] != null) ? f.committed[s].toFixed(0) : '—';
      var bub = '';
      if (f.action && f.action.seat === s) bub = actionText(f.action);
      return '<div class="' + cls + '">' +
        '<div class="av">' + esc(isHero ? '我' : shortName('座位' + s)) + '</div>' +
        '<div class="nm">' + esc(isHero ? '我' : shortName('座位' + s)) + '</div>' +
        '<div class="ch">投入 ' + com + '</div>' +
        '<div class="hc" id="r-cards-' + s + '">' + cards + '</div>' +
        '<div class="bub' + (bub ? '' : ' hide') + '">' + esc(bub) + '</div>' +
        '</div>';
    });
    $('replay-table').className = 'table-area n' + n;

    $('r-step-text').textContent = (r.idx + 1) + ' / ' + r.frames.length;

    var desc = '';
    var opts = $('r-opt-list'), rs = $('r-reasons');
    if (f.type === 'result') {
      var w = f.result.winner;
      var ws = f.result.winners || [];
      desc = (ws.length > 1
        ? '平分底池：' + ws.map(function (x) { return x === 0 ? '我' : '座位' + x; }).join(' / ')
        : (w === 0 ? '玩家胜' : '座位' + w + '胜')) +
        (f.result.byFold ? '（弃牌结束）' : '');
      if (!f.result.byFold && f.result.players && f.result.players.length) {
        rs.innerHTML = f.result.players.filter(function (p) { return !p.folded && p.handDesc; })
          .map(function (p) {
            return '<li>' + esc((p.seat === 0 ? '我' : '座位' + p.seat) + '：' + p.handDesc) +
              (winners.indexOf(p.seat) >= 0 ? ' ✓' : '') + '</li>';
          }).join('');
      } else {
        rs.innerHTML = '';
      }
      opts.innerHTML = '';
    } else if (f.action) {
      var a = f.action;
      desc = (a.seat === 0 ? '我' : '座位' + a.seat) + ' ' + (Recorder.ACTION_NAMES[a.action] || a.action) +
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
          ensureReplaySelection();
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
        var pot = g.totalPot();
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

    // 范围表模式切换（按钮由 renderRangeModes 动态生成）
    renderRangeModes();

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
    eachSegBtn('seg-players', function (b) {
      b.onclick = function () {
        eachSegBtn('seg-players', function (x) { x.classList.remove('on'); });
        b.classList.add('on');
      };
    });
    eachSegBtn('seg-diff', function (b) {
      b.onclick = function () {
        eachSegBtn('seg-diff', function (x) { x.classList.remove('on'); });
        b.classList.add('on');
      };
    });
    eachSegBtn('seg-speed', function (b) {
      b.onclick = function () {
        eachSegBtn('seg-speed', function (x) { x.classList.remove('on'); });
        b.classList.add('on');
      };
    });
    $('btn-apply-settings').onclick = function () {
      var dEl = $('seg-diff'), spEl = $('seg-speed'), pbEl = $('seg-players'), stEl = $('sel-stack');
      var d = dEl ? dEl.querySelector('.on') : null;
      var sp = spEl ? spEl.querySelector('.on') : null;
      S.difficulty = d ? d.getAttribute('data-d') : S.difficulty;
      S.speed = sp ? Number(sp.getAttribute('data-s')) : S.speed;
      S.stackBB = stEl ? Number(stEl.value) : S.stackBB;
      var pb = pbEl ? pbEl.querySelector('.on') : null;
      var newSize = pb ? Number(pb.getAttribute('data-p')) : S.tableSize;
      saveSettings();
      if (S.game) S.game.difficulty = S.difficulty;
      $('modal-settings').classList.remove('show');

      if (newSize !== S.tableSize) {
        // 切换人数 = 开新的一局（不同人数的牌局记录无法继续）
        S.tableSize = newSize;
        saveSettings();
        renderRangeModes();
        newGame(true);
        switchView('game');
        toast('已切换到 ' + (newSize === 2 ? '单挑' : newSize + ' 人桌') + '，开始新的一局');
      } else {
        renderTable();
        toast('设置已保存');
      }
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
    if (v === 'replay') { renderReplayList(); ensureReplaySelection(); }
  }

  function applySettingsToUI() {
    var ct = $('btn-coach-toggle');
    if (ct) {
      ct.classList.toggle('active', S.coach);
      ct.title = S.coach ? '教练模式：开启（点击进入考试模式）' : '教练模式：关闭（考试模式）';
    }
    if ($('sw-coach')) $('sw-coach').classList.toggle('on', S.coach);
    if ($('sw-peek')) $('sw-peek').classList.toggle('on', S.peek);
    eachSegBtn('seg-diff', function (b) {
      b.classList.toggle('on', b.getAttribute('data-d') === S.difficulty);
    });
    eachSegBtn('seg-speed', function (b) {
      b.classList.toggle('on', Number(b.getAttribute('data-s')) === S.speed);
    });
    eachSegBtn('seg-players', function (b) {
      b.classList.toggle('on', Number(b.getAttribute('data-p')) === S.tableSize);
    });
    if ($('sel-stack')) $('sel-stack').value = String(S.stackBB);
    if ($('build-tag')) $('build-tag').textContent = BUILD;
    renderRangeModes();
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

  // ---------------- 启动 ----------------
  function boot() {
    try {
      var missMod = [];
      if (!PE) missMod.push('poker-eval.js');
      if (!PT) missMod.push('preflop-table.js');
      if (!EQ) missMod.push('equity.js');
      if (!GTO) missMod.push('gto.js');
      if (!Engine) missMod.push('engine.js');
      if (!Recorder) missMod.push('recorder.js');
      if (missMod.length) {
        showFatal('以下脚本没有加载到：' + missMod.join('、') + '。可能是部署时文件缺失，或浏览器缓存了旧版本。');
        return;
      }
      var miss = missingIds();
      if (miss.length) {
        showFatal('index.html 与脚本版本不一致，缺少元素：' + miss.join('、') + '。');
        return;
      }
      init();
    } catch (e) {
      showFatal('初始化异常：' + ((e && e.message) || String(e)));
      throw e;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else boot();
})();
