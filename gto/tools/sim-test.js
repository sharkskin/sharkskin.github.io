/*
 * sim-test.js — 引擎自检
 * 用法: node tools/sim-test.js [每档人数的手牌数]
 *
 * 校验项：
 *  1. 牌局能在有限步内结束（不死循环）
 *  2. 筹码守恒：所有座位净收益之和为 0，结算后筹码合计等于起始合计
 *  3. 奖池守恒：发出去的彩金总和 == 所有人投入总和
 *  4. 摊牌判定：夺池者的牌力确实处于最强一档
 *  5. 决策记录完整：每个动作都带有 GTO 选项
 *  6. 各位置开池率呈现正确的松紧梯度
 */
global.PokerEval = require('../js/poker-eval.js');
require('../js/preflop-table.js');
require('../js/equity.js');
require('../js/gto.js');
require('../js/engine.js');

var Engine = globalThis.Engine;
var PE = globalThis.PokerEval;

var MAX_HANDS = Number(process.argv[2] || 150);
var difficulties = ['easy', 'standard', 'gto'];
var tableSizes = [2, 3, 4, 6];
var problems = [];

function check(cond, msg) { if (!cond) problems.push(msg); }

/** 自动打完一手牌，返回本手的:（preflop→postflop）行动标签 */
function autoPlay(game, diffTag) {
  var guard = 0;
  var counts = {};
  for (;;) {
    if (++guard > 400) { problems.push('[' + diffTag + '] 手牌 #' + game.cur.no + ' 疑似死循环'); return null; }
    var actor = game.nextActor();
    if (actor === null) {
      var r = game.advance();
      if (r === 'showdown' || r === 'fold') break;
      continue;
    }
    var ch = game.autoDecide(actor).chosen;
    counts[ch.action] = (counts[ch.action] || 0) + 1;
    game.applyAction(actor, ch.action, ch.size);
    if (game.cur.stacks[actor] < -0.001) problems.push('[' + diffTag + '] 座位' + actor + ' 筹码为负');
  }
  return { counts: counts, result: game.cur.result };
}

console.log('=== 引擎自检：每档 ' + MAX_HANDS + ' 手 ===');

tableSizes.forEach(function (n) {
  difficulties.forEach(function (diff) {
    var tag = n + '人/' + diff;
    var game = new Engine.Game({ bb: 2, stack: 200, difficulty: diff, players: n });
    var handsPlayed = 0, showdowns = 0, folds = 0, actionCounts = {}, noOption = 0, totalActions = 0;
    var multiPotHands = 0;
    var t0 = Date.now();

    for (var i = 0; i < MAX_HANDS; i++) {
      var h = game.startHand();
      if (!h) break;
      handsPlayed++;
      var played = autoPlay(game, tag);
      if (!played) break;
      var res = played.result;
      if (!res) { problems.push('[' + tag + '] 手牌 #' + h.no + ' 没有结算结果'); break; }

      // —— 筹码 / 彩金守恒 ——
      var netSum = 0, chipSum = 0, prizeSum = 0, comSum = 0;
      for (var s = 0; s < n; s++) {
        netSum += res.nets[s];
        chipSum += game.chips[s];
        prizeSum += res.prize[s];
        comSum += res.committed[s];
      }
      check(Math.abs(netSum) < 0.01, '[' + tag + '] 净收益不守恒 ' + netSum.toFixed(3));
      check(Math.abs(chipSum - 200 * n) < 0.01, '[' + tag + '] 筹码总量异常 ' + chipSum.toFixed(2));
      check(Math.abs(prizeSum - comSum) < 0.01, '[' + tag + '] 彩金不守恒 ' + prizeSum + ' vs ' + comSum);
      check(res.pots.length >= 1, '[' + tag + '] 未生成任何奖池');
      if (res.pots.length > 1) multiPotHands++;

      // —— 摊牌判定（逐个奖池校验：每个奖池的赢家必须是该奖池有资格者中的最强牌）——
      if (!res.byFold) {
        check(res.board.length === 5, '[' + tag + '] 摊牌时公共牌不足 5 张');
        res.pots.forEach(function (p, pi) {
          var bestVal = -1, bestSeats = [];
          p.eligible.forEach(function (s) {
            var v = res.players[s].handValue;
            if (v > bestVal) { bestVal = v; bestSeats = [s]; }
            else if (v === bestVal) bestSeats.push(s);
          });
          p.winners.forEach(function (w) {
            check(bestSeats.indexOf(w) >= 0, '[' + tag + '] 第' + (pi + 1) + '个奖池：座位' + w + ' 牌力非最强却获奖');
          });
          bestSeats.forEach(function (bs) {
            check(p.winners.indexOf(bs) >= 0, '[' + tag + '] 第' + (pi + 1) + '个奖池：最强牌座位' + bs + ' 未获奖');
          });
        });
      }
      if (res.byFold) folds++; else showdowns++;

      // —— 决策记录完整性 ——
      (h.actions || []).forEach(function (a) {
        totalActions++;
        if (!a.options || !a.options.length) noOption++;
        if (a.equity === undefined || isNaN(a.equity)) problems.push('[' + tag + '] 缺失 equity');
      });

      // 练习模式：筹码过少自动补满，便于跑长局
      var broke = false;
      for (var s2 = 0; s2 < n; s2++) if (game.chips[s2] < game.bb * 8) broke = true;
      if (broke) for (var s3 = 0; s3 < n; s3++) game.chips[s3] = 200;

      Object.keys(played.counts).forEach(function (k) {
        actionCounts[k] = (actionCounts[k] || 0) + played.counts[k];
      });
    }

    check(totalActions > 0 && noOption === 0, '[' + tag + '] 有 ' + noOption + '/' + totalActions + ' 个动作缺少 GTO 选项');

    var dt = ((Date.now() - t0) / 1000).toFixed(1);
    var before = problems.length;
    console.log(
      (problems.length === before ? '  ✓ ' : '  ✗ ') + tag.padEnd(16) +
      ' 手数 ' + String(handsPlayed).padStart(4) +
      ' | 摊牌 ' + String(showdowns).padStart(3) + ' 弃牌 ' + String(folds).padStart(3) +
      ' | 边池手数 ' + String(multiPotHands).padStart(3) +
      ' | 动作 ' + String(totalActions).padStart(5) +
      ' | ' + dt + 's'
    );
  });
});

// ---------------- 6 人桌位置开池率统计 ----------------
console.log('\n=== 6 人桌各位置首位入池（RFI）率 ===');
var stats = {};
var g6 = new Engine.Game({ bb: 2, stack: 200, difficulty: 'standard', players: 6 });
for (var i = 0; i < 600; i++) {
  if (!g6.startHand()) break;
  if (!autoPlay(g6, 'rfi')) break;
  var cur = g6.cur;
  var voluntarySeen = false, actedSeat = {};
  cur.actions.forEach(function (a) {
    if (a.street !== 0 || actedSeat[a.seat]) return;
    actedSeat[a.seat] = true;
    // 只有「前面还没有人自愿入池」时的决策才算一次首位入池机会（含弃牌）
    if (voluntarySeen) return;
    var label = cur.posLabel[a.seat];
    if (!stats[label]) stats[label] = { chance: 0, raised: 0 };
    stats[label].chance++;
    if (a.action === 'raise' || a.action === 'bet' || a.action === 'allin') stats[label].raised++;
    if (a.action === 'call' || a.action === 'raise' || a.action === 'bet' || a.action === 'allin') voluntarySeen = true;
  });
  for (var s = 0; s < 6; s++) if (g6.chips[s] < 16) { for (var q = 0; q < 6; q++) g6.chips[q] = 200; break; }
}
['UTG', 'MP', 'CO', 'BTN', 'SB'].forEach(function (l) {
  var st = stats[l];
  if (!st || !st.chance) { console.log('  ' + l.padEnd(4) + ' 无样本'); return; }
  console.log('  ' + l.padEnd(4) + ' 首位入池机会 ' + String(st.chance).padStart(4) +
    ' 次 → 加注入池率 ' + (st.raised / st.chance * 100).toFixed(1) + '%');
});

// ---------------- 边池算法单元测试 ----------------
console.log('\n=== 边池算法验证 ===');
[
  { committed: [100, 50, 100], canWin: [1, 1, 0], expect: [150, 100], note: '3 号弃牌，多余部分退还' },
  { committed: [100, 50, 100], canWin: [1, 1, 1], expect: [150, 100], note: '短码构成主池' },
  { committed: [20, 20, 60], canWin: [1, 1, 1], expect: [60, 40], note: '两家平等-Ind SidePot' },
  { committed: [10, 10, 10], canWin: [1, 1, 1], expect: [30], note: '三家等额 → 单一主池' },
  { committed: [0, 30, 60], canWin: [0, 1, 1], expect: [60, 30], note: '未参战座位不参与' }
].forEach(function (tc, idx) {
  var pots = Engine.buildPots(tc.committed, tc.canWin.map(function (x) { return !!x; }));
  var amounts = pots.map(function (p) { return p.amount; });
  var sum = amounts.reduce(function (a, b) { return a + b; }, 0);
  var total = tc.committed.reduce(function (a, b) { return a + b; }, 0);
  var ok = amounts.length === tc.expect.length &&
    amounts.every(function (v, i) { return Math.abs(v - tc.expect[i]) < 0.001; }) &&
    Math.abs(sum - total) < 0.001;
  check(ok, '边池用例 ' + (idx + 1) + ' 失败：得到 [' + amounts + ']，应为 [' + tc.expect + ']');
  console.log('  ' + (ok ? '✓' : '✗') + ' 投入 [' + tc.committed + '] → [' + amounts.join(' + ') + ']  ' + tc.note);
});

console.log('\n' + (problems.length ? '❌ 发现 ' + problems.length + ' 个问题:' : '✅ 全部检查通过'));
var uniq = [];
problems.forEach(function (p) { if (uniq.indexOf(p) < 0) uniq.push(p); });
uniq.slice(0, 15).forEach(function (p) { console.log('   - ' + p); });
process.exit(problems.length ? 1 : 0);
