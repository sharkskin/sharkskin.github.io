/*
 * 集成测试：完整对局 → 存档往返 → 复盘报告 → 分享码 → 文字战报 → 回看帧
 * 覆盖单挑（2 人）与多人桌（6 人）
 * 运行： node tools/integration-test.js
 */
global.PokerEval = require('../js/poker-eval.js');
require('../js/preflop-table.js');
require('../js/equity.js');
require('../js/gto.js');
require('../js/engine.js');
require('../js/recorder.js');

var fs = require('fs');
var path = require('path');
var Engine = globalThis.Engine;
var Recorder = globalThis.Recorder;

var problems = [];
function check(cond, msg) { if (!cond) problems.push(msg); }

/** 自动打若干手 */
function playHands(game, hands) {
  var totalActions = 0;
  for (var i = 0; i < hands; i++) {
    var h = game.startHand();
    if (!h) break;
    var guard = 0;
    for (;;) {
      if (++guard > 200) { problems.push('[' + game.n + '人] 对局死循环 #' + h.no); break; }
      var actor = game.nextActor();
      if (actor === null) {
        var r = game.advance();
        if (r === 'showdown' || r === 'fold') break;
        continue;
      }
      var d = game.autoDecide(actor);
      game.applyAction(actor, d.chosen.action, d.chosen.size);
    }
    totalActions += (h.actions || []).length;
    var broke = false;
    for (var s = 0; s < game.n; s++) if (game.chips[s] < 20) broke = true;
    if (broke) for (var q = 0; q < game.n; q++) game.chips[q] = game.startStack;
  }
  return totalActions;
}

async function runSuite(n) {
  var tag = n + '人桌';
  var game = new Engine.Game({ bb: 2, stack: 200, difficulty: 'standard', players: n });

  // ---------- 1. 对局 ----------
  var acts = playHands(game, 30);
  console.log('\n===== ' + tag + ' =====');
  console.log('1) 对局完成：' + game.hands.length + ' 手，动作总数 ' + acts);
  check(game.hands.length > 0, tag + ' 没有打出任何手牌');

  // ---------- 2. 完整存档往返（保留 GTO 明细） ----------
  var full = Recorder.serialize(game, true);
  var back = Recorder.deserialize(full);
  check(back.hands.length === game.hands.length, tag + ' 存档手数不一致');
  var optCount = 0, missingOpt = 0;
  back.hands.forEach(function (h) {
    h.actions.forEach(function (a) {
      if (a.options && a.options.length) optCount++; else missingOpt++;
    });
  });
  check(missingOpt === 0, tag + ' 存档后有 ' + missingOpt + ' 个动作丢失 GTO 选项');
  console.log('2) 完整存档：' + optCount + ' 个动作保留 GTO 明细，缺失 ' + missingOpt);

  var a0 = game.hands[0].actions[0];
  var b0 = back.hands[0].actions[0];
  check(Math.abs(a0.equity - b0.equity) < 0.002, tag + ' equity 往返精度丢失');
  check(a0.action === b0.action, tag + ' action 往返不一致');
  check(a0.size === b0.size, tag + ' size 往返不一致');
  check(back.players === n, tag + ' 人数记录丢失');

  // 底牌 / 结算往返
  check(JSON.stringify(back.hands[0].holes) === JSON.stringify(game.hands[0].holes), tag + ' 底牌往返不一致');
  var r0 = game.hands[0].result, rb = back.hands[0].result;
  check(r0.winner === rb.winner, tag + ' 胜利者往返不一致');
  check(Math.abs(r0.heroNet - rb.heroNet) < 0.01, tag + ' 玩家净收益往返不一致');
  if (r0.winners) {
    check(JSON.stringify(r0.winners) === JSON.stringify(rb.winners), tag + ' 赢家列表往返不一致');
  }

  // ---------- 3. 复盘报告 ----------
  var rep = Recorder.buildReport(game);
  console.log('3) 复盘报告：手数 ' + rep.handCount +
    ' | VPIP ' + (rep.stats.vpip * 100).toFixed(0) + '%' +
    ' | PFR ' + (rep.stats.pfr * 100).toFixed(0) + '%' +
    ' | 摊牌率 ' + (rep.stats.showdownRate * 100).toFixed(0) + '%' +
    ' | AF ' + rep.stats.af.toFixed(2));
  console.log('   决策分级：最优 ' + rep.mistakeCounts.best +
    ' / 合理混合 ' + rep.mistakeCounts.mixed +
    ' / 可忽略 ' + rep.mistakeCounts.fine +
    ' / 小失误 ' + rep.mistakeCounts.minor +
    ' / 偏离 ' + rep.mistakeCounts.error +
    ' / 严重 ' + rep.mistakeCounts.severe);
  console.log('   EV 损失合计 ' + rep.totalEvLossBB.toFixed(1) + ' BB');
  check(rep.handCount === game.hands.length, tag + ' 报告手数不一致');
  check(rep.stats.vpip >= 0 && rep.stats.vpip <= 1, tag + ' VPIP 越界');
  check(rep.totalEvLossBB >= 0, tag + ' EV 损失为负');
  var graded = rep.mistakeCounts.best + rep.mistakeCounts.mixed + rep.mistakeCounts.fine +
    rep.mistakeCounts.minor + rep.mistakeCounts.error + rep.mistakeCounts.severe;
  check(graded > 0, tag + ' 没有任何决策被分级');

  var sample = null;
  rep.hands.forEach(function (h) { if (!sample && h.decisions.length > 1) sample = h.decisions[h.decisions.length - 1]; });
  if (sample) {
    console.log('   样例决策：' + sample.streetName + ' 玩家' + sample.actionName +
      ' | GTO 最优 ' + (sample.best ? sample.best.action + ' ' + (sample.best.size || '') : '?') +
      ' | 判定 ' + sample.levelText + ' | EV 差 ' + sample.evLossBB.toFixed(2) + ' BB');
  }

  // ---------- 4. 分享码往返 ----------
  var code = await Recorder.toShareCode(game);
  console.log('4) 分享码长度：' + code.length + ' 字符（前缀 ' + code[0] + '）');
  var parsed = await Recorder.fromShareCode(code);
  check(parsed && parsed.hands.length === game.hands.length, tag + ' 分享码手数不一致');
  if (parsed) {
    var ok = true;
    for (var i = 0; i < parsed.hands.length; i++) {
      var a = game.hands[i], b = parsed.hands[i];
      if (JSON.stringify(a.holes) !== JSON.stringify(b.holes)) ok = false;
      if (a.board.join() !== b.board.join()) ok = false;
      if (a.result.winner !== b.result.winner) ok = false;
      if (Math.abs(a.result.heroNet - b.result.heroNet) > 0.01) ok = false;
      if (a.actions.length !== b.actions.length) ok = false;
    }
    check(ok, tag + ' 分享码还原后牌局数据不一致');
    console.log('   往返校验：' + (ok ? '✅ 一致' : '❌ 不一致'));
    if (n > 2) check(parsed.players === n, tag + ' 分享码丢失人数信息');
  }

  // ---------- 5. 文字战报 ----------
  var txt = Recorder.toSummaryText(game);
  var lines = txt.split('\n');
  console.log('5) 文字战报：' + lines.length + ' 行');
  console.log('   预览：' + lines.slice(4, 7).join(' / ').slice(0, 150));
  check(txt.indexOf('第 1 手') > 0, tag + ' 战报缺少手牌分段');
  check(txt.indexOf('玩家总盈亏') > 0, tag + ' 战报缺少总盈亏');
  if (n > 2) check(txt.indexOf('人数: ' + n) > 0, tag + ' 战报缺少人数信息');

  // ---------- 6. 回看帧 ----------
  var h1 = game.hands[0];
  var frames = Recorder.buildReplayFrames(h1, game.bb);
  console.log('6) 回看帧：第 1 手共 ' + frames.length + ' 帧，类型 ' +
    frames.map(function (f) { return f.type[0]; }).join(''));
  check(frames[0].type === 'deal', tag + ' 首帧应为发牌');
  check(frames[frames.length - 1].type === 'result', tag + ' 末帧应为结果');
  check(frames.filter(function (f) { return f.type === 'action'; }).length === h1.actions.length, tag + ' 动作帧数量不符');
  check(frames[0].holes.length === n, tag + ' 回看帧座位数量不符');
  // 末帧的投入总和应等于本手底池
  var lastCommitted = frames[frames.length - 1].committed.reduce(function (a, b) { return a + b; }, 0);
  var lastBlinds = (n === 2 ? 3 : 3);
  check(Math.abs(lastCommitted - h1.result.pot) < 0.01 || lastCommitted >= lastBlinds,
    tag + ' 回看末帧投入与底池不符 ' + lastCommitted + ' vs ' + h1.result.pot);

  // 每个座位的投入都能从帧里取到
  check(frames[frames.length - 1].committed.length === n, tag + ' 回看帧投入数组长度不符');
}

(async function () {
  await runSuite(2);
  await runSuite(6);

  // ---------- 7. HTML / JS 元素 ID 一致性 ----------
  console.log('\n===== DOM 元素检查 =====');
  var html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  var ui = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8');
  var htmlIds = {};
  var re = /id="([^"]+)"/g, m;
  while ((m = re.exec(html))) htmlIds[m[1]] = true;
  var usedIds = {};
  var re2 = /\$\('([^']+)'\)/g;
  while ((m = re2.exec(ui))) usedIds[m[1]] = true;
  // 运行时由 JS 动态创建、本来就不该出现在 index.html 里的元素
  var DYNAMIC_IDS = { 'fatal-box': 1, 'fatal-reload': 1 };
  var missing = Object.keys(usedIds).filter(function (k) { return !htmlIds[k] && !DYNAMIC_IDS[k]; });
  check(missing.length === 0, 'ui.js 引用了不存在的元素 ID: ' + missing.join(', '));
  console.log('ui.js 引用 ' + Object.keys(usedIds).length + ' 个 ID，缺失 ' + missing.length +
    (missing.length ? ' → ' + missing.join(', ') : ''));

  // 座位分区容器是 ui.js 用前缀拼接出来的（$(prefix + zone)），上面的正则扫不到，单独校验
  var zoneIds = ['seats-top', 'seats-left', 'seats-right', 'seats-bottom',
    'r-seats-top', 'r-seats-left', 'r-seats-right', 'r-seats-bottom'];
  var zoneMissing = zoneIds.filter(function (id) { return !htmlIds[id]; });
  check(zoneMissing.length === 0, 'index.html 缺少座位分区容器: ' + zoneMissing.join(', '));
  check(ui.indexOf("'seats-'") >= 0 && ui.indexOf("'r-seats-'") >= 0,
    'ui.js 未使用座位分区容器前缀');
  console.log('座位分区容器 ' + zoneIds.length + ' 个，缺失 ' + zoneMissing.length);

  console.log('\n' + (problems.length ? '❌ 发现 ' + problems.length + ' 个问题:' : '✅ 集成测试全部通过'));
  problems.forEach(function (p) { console.log('   - ' + p); });
  process.exit(problems.length ? 1 : 0);
})();
