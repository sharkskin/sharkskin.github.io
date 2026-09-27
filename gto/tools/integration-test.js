/*
 * 集成测试：完整对局 → 存档往返 → 复盘报告 → 分享码 → 文字战报 → 回看帧
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
var PE = globalThis.PokerEval;

var problems = [];
function check(cond, msg) { if (!cond) problems.push(msg); }

// ---------- 1. 模拟完整对局（玩家侧用 autoDecide 代替点击） ----------
var game = new Engine.Game({ bb: 2, stack: 200, difficulty: 'standard' });
var HANDS = 40;
for (var i = 0; i < HANDS; i++) {
  var h = game.startHand();
  if (!h) break;
  var guard = 0;
  while (true) {
    if (++guard > 200) { problems.push('对局死循环 #' + h.no); break; }
    var actor = game.nextActor();
    if (actor === null) {
      var r = game.advance();
      if (r === 'showdown' || r === 'fold') break;
      continue;
    }
    var d = game.autoDecide(actor);
    game.applyAction(actor, d.chosen.action, d.chosen.size);
  }
  if (game.heroStack < 20 || game.aiStack < 20) { game.heroStack = 200; game.aiStack = 200; }
}
console.log('1) 对局完成：' + game.hands.length + ' 手，动作总数 ' +
  game.hands.reduce(function (s, h) { return s + h.actions.length; }, 0));

// ---------- 2. 完整存档往返（保留 GTO 明细） ----------
var full = Recorder.serialize(game, true);
var back = Recorder.deserialize(full);
check(back.hands.length === game.hands.length, '存档手数不一致');
var optCount = 0, missingOpt = 0, missingReasons = 0;
back.hands.forEach(function (h) {
  h.actions.forEach(function (a) {
    if (a.options && a.options.length) optCount++;
    else missingOpt++;
    if (!a.reasons) missingReasons++;
  });
});
check(missingOpt === 0, '存档后有 ' + missingOpt + ' 个动作丢失 GTO 选项');
console.log('2) 完整存档：' + optCount + ' 个动作保留 GTO 明细，缺失 ' + missingOpt);

// 校验数值往返精度
var a0 = game.hands[0].actions[0];
var b0 = back.hands[0].actions[0];
check(Math.abs(a0.equity - b0.equity) < 0.002, 'equity 往返精度丢失');
check(a0.action === b0.action, 'action 往返不一致');
check(a0.size === b0.size, 'size 往返不一致');

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
  ' / 错误 ' + rep.mistakeCounts.error +
  ' / 严重 ' + rep.mistakeCounts.severe);
console.log('   EV 损失合计 ' + rep.totalEvLossBB.toFixed(1) + ' BB');
check(rep.handCount === game.hands.length, '报告手数不一致');
check(rep.stats.vpip >= 0 && rep.stats.vpip <= 1, 'VPIP 越界');
check(rep.totalEvLossBB >= 0, 'EV 损失为负');
var graded = rep.mistakeCounts.best + rep.mistakeCounts.mixed + rep.mistakeCounts.fine +
  rep.mistakeCounts.minor + rep.mistakeCounts.error + rep.mistakeCounts.severe;
check(graded > 0, '没有任何决策被分级');

// 抽样打印一个决策详情
var sample = null;
rep.hands.forEach(function (h) { if (!sample && h.decisions.length > 1) sample = h.decisions[h.decisions.length - 1]; });
if (sample) {
  console.log('   样例决策：' + sample.streetName + ' 玩家' + sample.actionName +
    ' | GTO 最优 ' + (sample.best ? sample.best.action + ' ' + (sample.best.size || '') : '?') +
    ' | 判定 ' + sample.levelText + ' | EV 差 ' + sample.evLossBB.toFixed(2) + ' BB');
}

// ---------- 4. 分享码往返 ----------
(async function () {
  var shareData = Recorder.serialize(game, false);
  var fakeGame = { bb: game.bb, startStack: game.startStack, difficulty: game.difficulty, hands: game.hands };
  var code = await Recorder.toShareCode(fakeGame);
  console.log('4) 分享码长度：' + code.length + ' 字符（前缀 ' + code[0] + '）');
  var parsed = await Recorder.fromShareCode(code);
  check(parsed && parsed.hands.length === game.hands.length, '分享码手数不一致');
  if (parsed) {
    var ok = true;
    for (var i = 0; i < parsed.hands.length; i++) {
      var a = game.hands[i], b = parsed.hands[i];
      if (a.heroCards.join() !== b.heroCards.join()) ok = false;
      if (a.board.join() !== b.board.join()) ok = false;
      if (a.result.winner !== b.result.winner) ok = false;
      if (Math.abs(a.result.heroNet - b.result.heroNet) > 0.01) ok = false;
    }
    check(ok, '分享码还原后牌局数据不一致');
    console.log('   往返校验：' + (ok ? '✅ 一致' : '❌ 不一致'));
  }

  // ---------- 5. 文字战报 ----------
  var txt = Recorder.toSummaryText(fakeGame);
  var lines = txt.split('\n');
  console.log('5) 文字战报：' + lines.length + ' 行');
  console.log('   预览：' + lines.slice(0, 6).join(' / ').slice(0, 160));
  check(txt.indexOf('第 1 手') > 0, '战报缺少手牌分段');
  check(txt.indexOf('玩家总盈亏') > 0, '战报缺少总盈亏');

  // ---------- 6. 回看帧 ----------
  var h1 = game.hands[0];
  var frames = Recorder.buildReplayFrames(h1);
  console.log('6) 回看帧：第 1 手共 ' + frames.length + ' 帧，类型 ' +
    frames.map(function (f) { return f.type[0]; }).join(''));
  check(frames[0].type === 'deal', '首帧应为发牌');
  check(frames[frames.length - 1].type === 'result', '末帧应为结果');
  check(frames.filter(function (f) { return f.type === 'action'; }).length === h1.actions.length, '动作帧数量不符');

  // ---------- 7. HTML / JS 元素 ID 一致性 ----------
  var html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  var ui = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8');
  var htmlIds = {};
  var re = /id="([^"]+)"/g, m;
  while ((m = re.exec(html))) htmlIds[m[1]] = true;
  var usedIds = {};
  var re2 = /\$\('([^']+)'\)/g;
  while ((m = re2.exec(ui))) usedIds[m[1]] = true;
  var missing = Object.keys(usedIds).filter(function (k) { return !htmlIds[k]; });
  check(missing.length === 0, 'ui.js 引用了不存在的元素 ID: ' + missing.join(', '));
  console.log('7) DOM 元素检查：ui.js 引用 ' + Object.keys(usedIds).length + ' 个 ID，缺失 ' + missing.length +
    (missing.length ? ' → ' + missing.join(', ') : ''));

  console.log('\n' + (problems.length ? '❌ 发现 ' + problems.length + ' 个问题:' : '✅ 集成测试全部通过'));
  problems.forEach(function (p) { console.log('   - ' + p); });
  process.exit(problems.length ? 1 : 0);
})();
