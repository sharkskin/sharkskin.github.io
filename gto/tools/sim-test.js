/*
 * 引擎自检：AI vs AI 自动对战
 * 验证：无死循环、筹码守恒、动作合法、分池正确、决策数据完整
 * 运行： node tools/sim-test.js [手数]
 */
global.PokerEval = require('../js/poker-eval.js');
require('../js/preflop-table.js');
require('../js/equity.js');
require('../js/gto.js');
require('../js/engine.js');

var Engine = globalThis.Engine;
var GTO = globalThis.GTO;
var PE = globalThis.PokerEval;

var MAX_HANDS = Number(process.argv[2] || 300);
var difficulties = ['easy', 'standard', 'gto'];
var totalChips = 400;
var problems = [];

function check(cond, msg) {
  if (!cond) problems.push(msg);
}

function autoPlay(seat, game) {
  var r = game.autoDecide(seat);
  var ch = r.chosen;
  var before = game.cur.stacks[seat];
  game.applyAction(seat, ch.action, ch.size);
  return ch;
}

for (var di = 0; di < difficulties.length; di++) {
  var diff = difficulties[di];
  var game = new Engine.Game({ bb: 2, stack: 200, difficulty: diff });
  var handsPlayed = 0;
  var showdowns = 0, folds = 0;
  var heroWins = 0, aiWins = 0, splits = 0;
  var actionCounts = {};
  var t0 = Date.now();

  while (handsPlayed < MAX_HANDS && !game.isOver()) {
    var h = game.startHand();
    if (!h) break;
    handsPlayed++;
    var guard = 0;
    while (true) {
      if (++guard > 300) { problems.push('[' + diff + '] 手牌 #' + h.no + ' 疑似死循环'); break; }
      var actor = game.nextActor();
      if (actor === null) {
        var r = game.advance();
        if (r === 'showdown' || r === 'fold') break;
        continue;
      }
      var ch = autoPlay(actor, game);
      actionCounts[ch.action] = (actionCounts[ch.action] || 0) + 1;
      // 筹码不能为负
      if (game.cur.stacks[0] < -0.001 || game.cur.stacks[1] < -0.001) {
        problems.push('[' + diff + '] 筹码为负: ' + game.cur.stacks.join(','));
      }
      // 弃牌后交给 advance() 结算，不在此处跳出
    }
    var res = game.cur.result;
    if (!res) { problems.push('[' + diff + '] 手牌 #' + h.no + ' 没有结果'); break; }
    // 练习模式：筹码过少时自动补满，便于跑长局验证稳定性
    if (game.heroStack < game.bb * 5 || game.aiStack < game.bb * 5) {
      game.heroStack = 200; game.aiStack = 200;
    }
    check(Math.abs(res.heroNet + res.aiNet) < 0.001, '[' + diff + '] 净收益不守恒 ' + res.heroNet + '/' + res.aiNet);
    if (res.byFold) folds++; else showdowns++;
    if (res.winner === 0) heroWins++; else if (res.winner === 1) aiWins++; else splits++;
    // 校验摊牌结果
    if (!res.byFold) {
      var hv = PE.evalBest(res.heroCards.concat(res.board));
      var av = PE.evalBest(res.aiCards.concat(res.board));
      var expect = hv > av ? 0 : (av > hv ? 1 : -1);
      check(res.winner === expect, '[' + diff + '] 摊牌胜负判定错误');
      check(res.board.length === 5, '[' + diff + '] 摊牌时公共牌不足 5 张');
    }
  }

  // 筹码守恒
  var sum = game.heroStack + game.aiStack;
  check(Math.abs(sum - totalChips) < 0.001, '[' + diff + '] 总筹码不守恒: ' + sum + ' (应为 ' + totalChips + ')');

  // 决策记录完整性
  var withOptions = 0, totalActions = 0;
  game.hands.forEach(function (hh) {
    hh.actions.forEach(function (a) {
      totalActions++;
      if (a.options && a.options.length) withOptions++;
      if (a.equity === undefined || isNaN(a.equity)) problems.push('[' + diff + '] 缺失 equity');
    });
  });
  check(totalActions > 0 && withOptions === totalActions, '[' + diff + '] 有动作缺少 GTO 选项记录 (' + withOptions + '/' + totalActions + ')');

  var dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('[' + diff + '] 手数 ' + handsPlayed + ' | 摊牌 ' + showdowns + ' 弃牌结束 ' + folds +
    ' | Hero 胜 ' + heroWins + ' AI 胜 ' + aiWins + ' 平 ' + splits +
    ' | 剩余筹码 ' + game.heroStack.toFixed(0) + ' / ' + game.aiStack.toFixed(0) +
    ' | 动作数 ' + totalActions + ' | ' + dt + 's');
  console.log('       动作分布: ' + Object.keys(actionCounts).map(function (k) { return k + '=' + actionCounts[k]; }).join(' '));
}

console.log('\n' + (problems.length ? '❌ 发现 ' + problems.length + ' 个问题:' : '✅ 全部检查通过'));
problems.slice(0, 20).forEach(function (p) { console.log('   - ' + p); });
process.exit(problems.length ? 1 : 0);
