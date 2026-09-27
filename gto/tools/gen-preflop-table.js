/*
 * 离线预计算：169 种起手牌在 heads-up 中对随机手牌的胜率（含平局一半）
 * 运行： node tools/gen-preflop-table.js
 * 输出： js/preflop-table.js
 */
const PE = require('../js/poker-eval.js');
const fs = require('fs');
const path = require('path');

const RANKS = '23456789TJQKA';
const ITER = Number(process.argv[2] || 20000);

function holeOf(key) {
  // key: "AA" / "AKs" / "AKo"
  const r1 = RANKS.indexOf(key[0]);
  const r2 = RANKS.indexOf(key[1]);
  if (key[0] === key[1]) return [r1, 13 + r1];           // 对子：♠ + ♥
  if (key[2] === 's') return [r1, 13 + r2];              // 同花：♠ + ♥（同一花色）
  return [r1, 26 + r2];                                   // 非同花：♠ + ♦
}

function buildKeys() {
  const keys = [];
  for (let i = 12; i >= 0; i--) {
    for (let j = i; j >= 0; j--) {
      const a = RANKS[i], b = RANKS[j];
      if (i === j) keys.push(a + b);
      else { keys.push(a + b + 's'); keys.push(a + b + 'o'); }
    }
  }
  return keys;
}

function simulate(hole, iter) {
  const deck = [];
  for (let c = 0; c < 52; c++) if (hole.indexOf(c) < 0) deck.push(c);
  let win = 0, tie = 0;
  const board = new Array(5);
  for (let n = 0; n < iter; n++) {
    // 部分洗牌：取前 7 张（2 张对手 + 5 张公共牌）
    for (let i = 0; i < 7; i++) {
      const j = i + ((Math.random() * (deck.length - i)) | 0);
      const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    const opp1 = deck[0], opp2 = deck[1];
    for (let k = 0; k < 5; k++) board[k] = deck[2 + k];
    const my = PE.evalBest([hole[0], hole[1], board[0], board[1], board[2], board[3], board[4]]);
    const op = PE.evalBest([opp1, opp2, board[0], board[1], board[2], board[3], board[4]]);
    if (my > op) win++; else if (my === op) tie++;
  }
  return (win + tie * 0.5) / iter;
}

const keys = buildKeys();
console.log('组合数:', keys.length, '每组模拟:', ITER);
const t0 = Date.now();
const rows = [];
for (let i = 0; i < keys.length; i++) {
  const eq = simulate(holeOf(keys[i]), ITER);
  rows.push({ key: keys[i], eq: eq });
  if ((i + 1) % 20 === 0) process.stdout.write(`\r  ${i + 1}/${keys.length}`);
}
process.stdout.write('\n');

// 按胜率排序给出排名（1 = 最强）
const sorted = rows.slice().sort((a, b) => b.eq - a.eq);
sorted.forEach((r, idx) => { r.rank = idx + 1; });
const byKey = {};
rows.forEach(r => { byKey[r.key] = r; });

const out = [];
out.push('/*');
out.push(' * preflop-table.js — 自动生成，请勿手工编辑');
out.push(' * 169 种起手牌 heads-up vs 随机手牌胜率，模拟 ' + ITER + ' 次/组合');
out.push(' * rank: 1 = 最强（按胜率排序）');
out.push(' */');
out.push('(function (root) {');
out.push('  var DATA = {');
const lineArr = sorted.map(r => `    ${JSON.stringify(r.key)}: [${r.eq.toFixed(4)}, ${r.rank}]`);
out.push(lineArr.join(',\n'));
out.push('  };');
out.push(`
  /**
   * 查询起手牌数据
   * @param {string} key 形如 "AA" / "AKs" / "AKo"
   * @returns {{key:string, equity:number, rank:number}|null}
   */
  function lookup(key) {
    var d = DATA[key];
    if (!d) return null;
    return { key: key, equity: d[0], rank: d[1] };
  }

  /** 由两张具体牌推出 key（如 As+Ks => "AKs"） */
  function keyOfCards(c1, c2) {
    var r1 = c1 % 13, r2 = c2 % 13;
    var A = '23456789TJQKA';
    var hi = r1 >= r2 ? r1 : r2, lo = r1 >= r2 ? r2 : r1;
    var a = A[hi], b = A[lo];
    if (hi === lo) return a + b;
    return a + b + ((c1 / 13 | 0) === (c2 / 13 | 0) ? 's' : 'o');
  }

  /** 排名百分位（0..1，越小越强） */
  function percentile(key) {
    var d = lookup(key);
    if (!d) return 1;
    return (d.rank - 1) / 168;
  }

  root.PreflopTable = { lookup: lookup, keyOfCards: keyOfCards, percentile: percentile, DATA: DATA, RANKS: '23456789TJQKA' };
})(typeof self !== 'undefined' ? self : globalThis);
`);
out.push('');

const outPath = path.join(__dirname, '..', 'js', 'preflop-table.js');
fs.writeFileSync(outPath, out.join('\n'), 'utf8');
console.log('耗时:', ((Date.now() - t0) / 1000).toFixed(1), 's');
console.log('已写入:', outPath);
console.log('最强 5:', sorted.slice(0, 5).map(r => r.key + ' ' + (r.eq * 100).toFixed(1) + '%').join(' | '));
console.log('最弱 5:', sorted.slice(-5).map(r => r.key + ' ' + (r.eq * 100).toFixed(1) + '%').join(' | '));
console.log('示例: AA', byKey['AA'].eq.toFixed(4), ' 72o', byKey['72o'].eq.toFixed(4), ' 22', byKey['22'].eq.toFixed(4));
