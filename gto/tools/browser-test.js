/*
 * 浏览器实测：用系统 Chrome 打开页面，自动打若干手牌，验证渲染/交互/复盘/回看/分享
 * 运行： node tools/browser-test.js
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function serve() {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      res.end(fs.readFileSync(f));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

const problems = [];
function check(cond, msg) { if (!cond) problems.push(msg); else console.log('  ✓ ' + msg); }

/**
 * 客观校验座位布局：座位之间不能重叠，也不能越出牌桌容器边界。
 * 比看截图更可靠 —— 直接比对每个座位的 boundingRect。
 */
async function measureLayout(page, containerSel) {
  return await page.evaluate(sel => {
    const box = document.querySelector(sel);
    if (!box) return { count: 0, overlap: 0, outside: 0, h: 0, w: 0 };
    const br = box.getBoundingClientRect();
    const seats = [...box.querySelectorAll('.pseat')].map(e => {
      const r = e.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    let overlap = 0, outside = 0;
    for (let i = 0; i < seats.length; i++) {
      const a = seats[i];
      if (a.x < br.left - 0.5 || a.y < br.top - 0.5 ||
        a.x + a.w > br.right + 0.5 || a.y + a.h > br.bottom + 0.5) outside++;
      for (let j = i + 1; j < seats.length; j++) {
        const b = seats[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 0.5 && oy > 0.5) overlap++;
      }
    }
    return {
      count: seats.length, overlap, outside,
      h: Math.round(br.height), w: Math.round(br.width)
    };
  }, containerSel);
}

(async () => {
  const server = await serve();
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/index.html`;
  console.log('页面地址:', url);

  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 420, height: 920 } });

  const errors = [];
  page.on('pageerror', e => errors.push('JS 异常: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('控制台错误: ' + m.text()); });

  await page.goto(url);
  await page.waitForTimeout(2000);

  // ---- 1. 初始渲染 ----
  console.log('\n[1] 初始渲染');
  const init = await page.evaluate(() => {
    const q = id => document.getElementById(id);
    return {
      seats: document.querySelectorAll('#table-area .pseat').length,
      heroCards: q('cards-0').children.length,
      aiCards: q('cards-1').children.length,
      board: q('board-cards').children.length,
      pot: q('pot-display').textContent,
      street: q('street-label').textContent,
      chipHero: document.querySelector('#pseat-0 .ch').textContent.trim(),
      opts: q('opt-list').children.length,
      equity: q('stat-equity').textContent,
      reasons: q('reasons').children.length
    };
  });
  console.log('   ', JSON.stringify(init));
  check(init.seats === 2, '单挑模式渲染 2 个座位');
  check(init.heroCards === 2, '玩家手牌渲染 2 张');
  check(init.aiCards === 2, 'AI 手牌渲染 2 张（背面）');
  check(init.board === 5, '公共牌槽位 5 个');
  check(init.opts > 0, '教练面板给出 ' + init.opts + ' 个行动选项');
  check(init.reasons > 0, '教练面板给出 ' + init.reasons + ' 条理由');
  check(/%$/.test(init.equity), '胜率已计算: ' + init.equity);

  // ---- 2. 自动打牌 ----
  console.log('\n[2] 自动对局（模拟点击）');
  let handsPlayed = 0;
  let heroActions = 0;
  const seen = new Set();
  for (let step = 0; step < 300 && handsPlayed < 12; step++) {
    const st = await page.evaluate(() => {
      const q = id => document.getElementById(id);
      const vis = el => el && el.offsetParent !== null;
      return {
        next: vis(q('btn-next')),
        canFold: vis(q('btn-fold')) && !q('btn-fold').disabled,
        canCheck: vis(q('btn-check')) && !q('btn-check').disabled,
        canBet: vis(q('btn-bet')) && !q('btn-bet').disabled,
        checkText: q('btn-check').textContent,
        betMode: vis(q('bet-ui')),
        street: q('street-label').textContent,
        banner: q('result-banner').textContent.trim().slice(0, 40)
      };
    });
    if (st.next) {
      handsPlayed++;
      seen.add(st.banner);
      await page.click('#btn-next');
      await page.waitForTimeout(500);
      continue;
    }
    if (st.canCheck || st.canFold) {
      const r = Math.random();
      if (st.betMode) {
        await page.click('#btn-bet');            // 确认下注
      } else if (r < 0.55 && st.canCheck) {
        await page.click('#btn-check');
      } else if (r < 0.78 && st.canBet) {
        await page.click('#btn-bet');            // 打开下注面板
        await page.waitForTimeout(120);
        const hasSlider = await page.isVisible('#bet-slider');
        if (hasSlider) {
          const preset = await page.$('#bet-presets .bet-btn');
          if (preset) await preset.click();
          await page.click('#btn-bet');          // 确认
        }
      } else if (st.canFold) {
        await page.click('#btn-fold');
      } else {
        await page.click('#btn-check');
      }
      heroActions++;
      await page.waitForTimeout(600);
    } else {
      await page.waitForTimeout(400);
    }
  }
  console.log('    完成 ' + handsPlayed + ' 手，玩家点击动作 ' + heroActions + ' 次');
  check(handsPlayed >= 10, '完成 ' + handsPlayed + ' 手牌');
  check(heroActions > 10, '玩家动作按钮可用');

  const mid = await page.evaluate(() => {
    const q = id => document.getElementById(id);
    return { chip: document.querySelector('#pseat-0 .ch').textContent.trim(), handNo: q('board-cards').children.length };
  });
  console.log('    当前筹码:', mid.chip);

  // ---- 2b. 牌面渲染一致性 ----
  console.log('\n[2b] 渲染一致性');
  const consist = await page.evaluate(() => {
    const S = window.__GTO_POKER__.state;
    const PE = window.PokerEval;
    const SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };
    const expect = c => PE.RANK_NAMES[c % 13] + SYM[PE.SUIT_CHARS[(c / 13) | 0]];
    const c = S.game.cur;
    const norm = s => s.replace(/\s/g, '');
    const heroDom = [...document.querySelectorAll('#cards-0 .card')].map(e => norm(e.textContent));
    const boardDom = [...document.querySelectorAll('#board-cards .card')]
      .filter(e => !e.classList.contains('hidden-c')).map(e => norm(e.textContent));
    return {
      heroOk: JSON.stringify(heroDom) === JSON.stringify(c.heroCards.map(expect)),
      boardOk: JSON.stringify(boardDom) === JSON.stringify(c.board.map(expect)),
      heroDom, expectHero: c.heroCards.map(expect),
      boardDom, expectBoard: c.board.map(expect),
      handNo: S.game.hands.length,
      difficulty: S.game.difficulty
    };
  });
  console.log('    玩家手牌 DOM', consist.heroDom, '数据', consist.expectHero);
  console.log('    公共牌 DOM', consist.boardDom, '数据', consist.expectBoard);
  check(consist.heroOk, '玩家手牌渲染与数据一致');
  check(consist.boardOk, '公共牌渲染与数据一致');

  // ---- 2c. 范围表 ----
  console.log('\n[2c] 起手牌范围表');
  await page.click('[data-view="range"]');
  await page.waitForTimeout(600);
  const rng = await page.evaluate(() => ({
    cells: document.querySelectorAll('.range-cell').length,
    first: document.querySelector('.range-cell').textContent,
    last: [...document.querySelectorAll('.range-cell')].pop().textContent,
    desc: document.getElementById('range-desc').textContent.slice(0, 50),
    legend: [document.getElementById('lg-a').textContent, document.getElementById('lg-c').textContent, document.getElementById('lg-f').textContent]
  }));
  console.log('    格子数:', rng.cells, '| 首格:', rng.first, '| 末格:', rng.last);
  console.log('    图例:', rng.legend.join(' / '));
  check(rng.cells === 169, '范围表渲染 169 个格子');
  check(rng.first === 'AA', '矩阵首格为 AA（实际 ' + rng.first + '）');
  check(rng.last === '22', '矩阵末格为 22（实际 ' + rng.last + '）');
  check(rng.legend[0].indexOf('加注') === 0, '图例随模式变化');

  await page.click('.range-cell[data-k="AA"]');
  await page.waitForTimeout(300);
  const rngDetail = await page.evaluate(() => {
    const d = document.querySelector('#range-detail .range-detail-card');
    return d ? d.textContent.replace(/\s+/g, ' ').slice(0, 150) : null;
  });
  console.log('    AA 详情:', rngDetail);
  check(rngDetail && rngDetail.indexOf('AA') === 0, '点击格子显示手牌详情');

  // 切换模式
  await page.click('#seg-range button[data-r="bbopen"]');
  await page.waitForTimeout(400);
  const rng2 = await page.evaluate(() => document.getElementById('lg-a').textContent);
  check(rng2 === '3bet', '切换模式后图例更新为 ' + rng2);
  await page.click('#seg-range button[data-r="sbopen"]');
  await page.waitForTimeout(300);
  await page.click('[data-view="game"]');
  await page.waitForTimeout(400);

  // ---- 3. 复盘视图 ----
  console.log('\n[3] 复盘视图');
  await page.click('[data-view="review"]');
  await page.waitForTimeout(600);
  const review = await page.evaluate(() => {
    const el = document.getElementById('review-scroll');
    return {
      text: el.textContent.replace(/\s+/g, ' ').slice(0, 200),
      cards: el.querySelectorAll('.cardx').length,
      hands: el.querySelectorAll('.hand-item').length,
      hasVPIP: el.textContent.indexOf('VPIP') >= 0,
      hasPFR: el.textContent.indexOf('PFR') >= 0
    };
  });
  console.log('   ', review.text.slice(0, 160));
  check(review.cards >= 8, '复盘统计卡片 ' + review.cards + ' 个');
  check(review.hands > 0, '复盘列出 ' + review.hands + ' 手牌');
  check(review.hasVPIP && review.hasPFR, '复盘含 VPIP / PFR 统计');

  // 展开一手牌详情
  await page.click('#review-scroll .hand-item');
  await page.waitForTimeout(300);
  const detail = await page.evaluate(() => {
    const d = document.querySelector('#review-scroll .hand-item .detail');
    return d ? { text: d.textContent.replace(/\s+/g, ' ').slice(0, 160), items: d.querySelectorAll('.decision-item').length } : null;
  });
  console.log('    详情:', detail ? detail.text.slice(0, 150) : '无');
  check(detail && detail.items > 0, '展开决策详情 ' + (detail ? detail.items : 0) + ' 条');

  // ---- 4. 回看视图 ----
  console.log('\n[4] 回看视图');
  await page.click('[data-view="replay"]');
  await page.waitForTimeout(600);
  const rep1 = await page.evaluate(() => ({
    step: document.getElementById('r-step-text').textContent,
    desc: document.getElementById('r-desc').textContent.slice(0, 80),
    board: document.getElementById('r-board').children.length,
    heroCards: document.getElementById('r-cards-0').children.length,
    seats: document.querySelectorAll('#replay-table .pseat').length,
    listBtns: document.querySelectorAll('#r-hand-list [data-h]').length
  }));
  console.log('   ', JSON.stringify(rep1));
  check(rep1.board === 5, '回看公共牌区 5 槽位');
  check(rep1.heroCards === 2, '回看玩家手牌 2 张');
  check(rep1.seats === 2, '回看渲染 2 个座位');
  check(rep1.listBtns > 0, '回看牌局列表 ' + rep1.listBtns + ' 手');
  const repLay = await measureLayout(page, '#replay-table');
  check(repLay.overlap === 0 && repLay.outside === 0,
    '回看座位布局正常（重叠 ' + repLay.overlap + ' / 越界 ' + repLay.outside + '）');

  await page.click('#btn-r-next');
  await page.click('#btn-r-next');
  await page.waitForTimeout(300);
  const rep2 = await page.evaluate(() => document.getElementById('r-step-text').textContent);
  console.log('    步进后:', rep1.step, '→', rep2);
  check(rep2 !== rep1.step, '回看步进生效');

  await page.click('#btn-r-first');
  await page.waitForTimeout(200);
  const rep3 = await page.evaluate(() => document.getElementById('r-step-text').textContent);
  check(rep3.indexOf('1 /') === 0, '回到开头生效: ' + rep3);

  // ---- 5. 分享 ----
  console.log('\n[5] 分享与导出');
  await page.click('#btn-share');
  await page.waitForTimeout(300);
  await page.click('#btn-gen-code');
  await page.waitForTimeout(1200);
  const code = await page.inputValue('#share-code');
  console.log('    分享码长度:', code.length, '前缀:', code[0]);
  check(code.length > 50, '分享码已生成 (' + code.length + ' 字符)');

  await page.click('#btn-gen-text');
  await page.waitForTimeout(400);
  const txt = await page.inputValue('#share-text');
  console.log('    战报预览:', txt.split('\n').slice(0, 3).join(' / ').slice(0, 110));
  check(txt.indexOf('第 1 手') > 0, '文字战报含手牌记录');
  check(txt.indexOf('玩家总盈亏') > 0, '文字战报含总盈亏');

  // 导入刚生成的分享码（应独立存放，不覆盖当前牌局）
  const beforeImport = await page.evaluate(() => window.__GTO_POKER__.state.game.hands.length);
  await page.fill('#import-code', code);
  await page.click('#btn-import');
  await page.waitForTimeout(1200);
  const imported = await page.evaluate(() => ({
    selfHands: window.__GTO_POKER__.state.game.hands.length,
    importCount: window.__GTO_POKER__.state.imports.length,
    step: document.getElementById('r-step-text').textContent,
    listBtns: document.querySelectorAll('#r-hand-list [data-h]').length,
    hasImportGroup: document.getElementById('r-hand-list').textContent.indexOf('导入') >= 0,
    toast: document.getElementById('toast').textContent
  }));
  console.log('    导入结果:', JSON.stringify(imported));
  check(imported.listBtns > 0, '分享码导入成功，回看列表共 ' + imported.listBtns + ' 手');
  check(imported.selfHands === beforeImport && beforeImport > 0,
    '导入未覆盖当前牌局（仍为 ' + imported.selfHands + ' 手）');
  check(imported.importCount === 1, '导入牌局独立存放');
  check(imported.hasImportGroup, '回看列表显示导入分组');

  // 先关弹窗，否则遮罩会挡住后续点击
  await page.click('#modal-share [data-close]');
  await page.waitForTimeout(300);

  // 导入后当前牌局的复盘数据应仍然可用
  await page.click('[data-view="review"]');
  await page.waitForTimeout(500);
  const reviewAfter = await page.evaluate(() => {
    const el = document.getElementById('review-scroll');
    return { hasStats: el.textContent.indexOf('VPIP') >= 0, hands: el.querySelectorAll('.hand-item').length };
  });
  check(reviewAfter.hasStats && reviewAfter.hands === beforeImport, '导入后当前牌局复盘数据仍完整');
  await page.click('[data-view="replay"]');
  await page.waitForTimeout(400);
  await page.waitForTimeout(200);

  // ---- 6. 设置与教练开关 ----
  console.log('\n[6] 设置与教练开关');
  await page.click('#btn-coach-toggle');
  await page.waitForTimeout(300);
  const coachOff = await page.evaluate(() => ({
    hidden: document.getElementById('coach-panel').style.display === 'none',
    label: document.getElementById('btn-coach-toggle').textContent
  }));
  check(coachOff.hidden, '教练模式可关闭（考试模式）: ' + coachOff.label);
  await page.click('#btn-coach-toggle');
  await page.waitForTimeout(200);

  await page.click('#btn-settings');
  await page.waitForTimeout(300);
  await page.click('#seg-diff button[data-d="gto"]');
  await page.click('#btn-apply-settings');
  await page.waitForTimeout(300);
  const diff = await page.evaluate(() => document.getElementById('toast').textContent);
  check(diff.indexOf('设置') >= 0, '设置保存: ' + diff);

  // ---- 6b. 切换到 6 人桌 ----
  console.log('\n[6b] 多人桌（6 人）');
  await page.click('#btn-settings');
  await page.waitForTimeout(300);
  await page.click('#seg-players button[data-p="6"]');
  await page.click('#btn-apply-settings');
  await page.waitForTimeout(1500);
  const multiInit = await page.evaluate(() => {
    const S = window.__GTO_POKER__.state;
    const seats = [...document.querySelectorAll('#table-area .pseat')];
    return {
      seats: seats.length,
      players: S.game.n,
      tableSize: S.tableSize,
      title: document.getElementById('app-title').textContent,
      labels: seats.map(s => (s.querySelector('.tag') || {}).textContent),
      holeCounts: seats.map(s => s.querySelector('.hc').children.length),
      areaClass: document.getElementById('table-area').className
    };
  });
  console.log('   ', JSON.stringify(multiInit));
  check(multiInit.seats === 6, '6 人桌渲染 6 个座位');
  check(multiInit.players === 6 && multiInit.tableSize === 6, '引擎切换到 6 人');
  check(multiInit.title.indexOf('6 人') >= 0, '标题跟随人数变化: ' + multiInit.title);
  check(multiInit.holeCounts.every(x => x === 2), '每个座位都有 2 张牌');
  const labelsOk = multiInit.labels.filter(Boolean).length === 6;
  check(labelsOk, '座位位置标签: ' + multiInit.labels.join(','));
  check(multiInit.areaClass.indexOf('n6') >= 0, '牌桌容器切换到多人布局');

  // 打几手多人牌，验证多 AI 依次行动、底池与结算
  let multiHands = 0, multiActions = 0, multiStreets = new Set();
  for (let step = 0; step < 260 && multiHands < 6; step++) {
    const st = await page.evaluate(() => {
      const q = id => document.getElementById(id);
      const vis = el => el && el.offsetParent !== null;
      return {
        next: vis(q('btn-next')),
        canCheck: vis(q('btn-check')) && !q('btn-check').disabled,
        canFold: vis(q('btn-fold')) && !q('btn-fold').disabled,
        canBet: vis(q('btn-bet')) && !q('btn-bet').disabled,
        street: q('street-label').textContent
      };
    });
    multiStreets.add(st.street);
    if (st.next) {
      multiHands++;
      await page.click('#btn-next');
      await page.waitForTimeout(450);
      continue;
    }
    if (st.canCheck) { await page.click('#btn-check'); multiActions++; }
    else if (st.canFold) { await page.click('#btn-fold'); multiActions++; }
    else if (st.canBet) {
      await page.click('#btn-bet');
      await page.waitForTimeout(120);
      const preset = await page.$('#bet-presets .bet-btn');
      if (await page.isVisible('#bet-slider') && preset) {
        await preset.click();
        await page.click('#btn-bet');
      } else {
        await page.click('#btn-fold');
      }
      multiActions++;
    } else {
      await page.waitForTimeout(350);
    }
    await page.waitForTimeout(500);
  }
  console.log('    完成 ' + multiHands + ' 手，玩家动作 ' + multiActions + ' 次，经历街: ' +
    [...multiStreets].join('→'));
  check(multiHands >= 4, '6 人桌完成 ' + multiHands + ' 手');
  check(multiActions > 4, '6 人桌玩家可正常行动');

  const multiState = await page.evaluate(() => {
    const S = window.__GTO_POKER__.state;
    const g = S.game;
    const hands = g.hands.slice(-3);
    const chips = g.chips.slice();
    return {
      hands: g.hands.length,
      chipSum: chips.reduce((a, b) => a + b, 0),
      expect: g.startStack * g.n,
      negChips: chips.filter(c => c < 0).length,
      lastResults: hands.map(h => ({
        winners: h.result.winners,
        pots: h.result.pots.length,
        pot: h.result.pot,
        netSum: h.result.nets.reduce((a, b) => a + b, 0)
      })),
      allSeatsActed: hands.every(h => new Set(h.actions.map(a => a.seat)).size >= 2)
    };
  });
  console.log('   ', JSON.stringify(multiState.lastResults));
  check(multiState.negChips === 0, '无负筹码');
  check(Math.abs(multiState.chipSum - multiState.expect) < 0.01,
    '筹码守恒 ' + multiState.chipSum + ' / ' + multiState.expect);
  check(multiState.lastResults.every(r => Math.abs(r.netSum) < 0.01), '每手净收益之和为 0');
  check(multiState.lastResults.every(r => r.winners.length >= 1), '每手牌都有赢家');
  check(multiState.allSeatsActed, '每手牌至少有两个座位行动过');

  // 多人桌的复盘与回看
  await page.click('[data-view="review"]');
  await page.waitForTimeout(500);
  const multiReview = await page.evaluate(() => {
    const el = document.getElementById('review-scroll');
    return {
      hasVPIP: el.textContent.indexOf('VPIP') >= 0,
      mode: (el.querySelector('.section-title') || {}).textContent,
      hands: el.querySelectorAll('.hand-item').length
    };
  });
  check(multiReview.hasVPIP && multiReview.hands > 0,
    '多人桌复盘可用（' + multiReview.hands + ' 手）');
  check((multiReview.mode || '').indexOf('6 人桌') >= 0, '复盘标题标注人数: ' + multiReview.mode);

  await page.click('[data-view="replay"]');
  await page.waitForTimeout(600);
  const multiReplay = await page.evaluate(() => ({
    seats: document.querySelectorAll('#replay-table .pseat').length,
    areaClass: document.getElementById('replay-table').className
  }));
  check(multiReplay.seats === 6, '回看渲染 6 个座位');
  check(multiReplay.areaClass.indexOf('n6') >= 0, '回看容器切换多人布局');
  const multiRepLay = await measureLayout(page, '#replay-table');
  check(multiRepLay.overlap === 0 && multiRepLay.outside === 0,
    '6 人桌回看座位布局正常（重叠 ' + multiRepLay.overlap + ' / 越界 ' + multiRepLay.outside + '）');

  // 多人桌的范围表应切换为按位置
  await page.click('[data-view="range"]');
  await page.waitForTimeout(600);
  const multiRange = await page.evaluate(() => ({
    modes: [...document.querySelectorAll('#seg-range button')].map(b => b.textContent),
    legend: document.getElementById('lg-a').textContent,
    desc: document.getElementById('range-desc').textContent.slice(0, 40)
  }));
  console.log('    范围模式:', multiRange.modes.join(' / '), '| 图例:', multiRange.legend);
  check(multiRange.modes.length === 5 && multiRange.modes[0].indexOf('UTG') >= 0,
    '多人桌范围表按位置展示: ' + multiRange.modes.join(','));
  check(multiRange.legend.indexOf('开池') >= 0, '范围图例为开池频率: ' + multiRange.legend);

  // ---- 6c. 座位布局：各人数下不重叠、不越界 ----
  console.log('\n[6c] 座位布局检查（2 / 3 / 4 / 6 人）');
  for (const size of [2, 3, 4, 6]) {
    await page.click('#btn-settings');
    await page.waitForTimeout(250);
    await page.click(`#seg-players button[data-p="${size}"]`);
    await page.click('#btn-apply-settings');
    await page.waitForTimeout(1200);
    await page.click('[data-view="game"]');
    await page.waitForTimeout(400);
    const lay = await measureLayout(page, '#table-area');
    console.log(`    ${size} 人：座位 ${lay.count} 个 · 牌桌 ${lay.w}×${lay.h}px · 重叠 ${lay.overlap} 处 · 越界 ${lay.outside} 处`);
    check(lay.count === size, `${size} 人桌渲染 ${lay.count} 个座位`);
    check(lay.overlap === 0, `${size} 人桌座位互不重叠`);
    check(lay.outside === 0, `${size} 人桌座位未越出牌桌边界`);
  }

  // ---- 7. 截图 ----
  await page.click('[data-view="game"]');
  await page.waitForTimeout(700);
  await page.click('[data-view="game"]');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(__dirname, '..', 'screenshot-game.png') });
  await page.click('[data-view="range"]');
  await page.waitForTimeout(500);
  await page.click('.range-cell[data-k="AKs"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, '..', 'screenshot-range.png'), fullPage: true });
  await page.click('[data-view="review"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(__dirname, '..', 'screenshot-review.png'), fullPage: false });
  await page.click('[data-view="replay"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(__dirname, '..', 'screenshot-replay.png') });
  await page.click('[data-view="game"]');
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(__dirname, '..', 'screenshot-multi.png') });
  console.log('\n    截图已保存');

  console.log('\n[错误检查] JS 异常 / 控制台错误: ' + errors.length);
  errors.slice(0, 10).forEach(e => console.log('   ! ' + e));
  check(errors.length === 0, '无 JS 运行时错误');

  await browser.close();
  server.close();

  console.log('\n' + (problems.length ? '❌ 发现 ' + problems.length + ' 个问题:' : '✅ 浏览器实测全部通过'));
  problems.forEach(p => console.log('   - ' + p));
  process.exit(problems.length ? 1 : 0);
})().catch(e => {
  console.error('测试脚本异常:', e);
  process.exit(1);
});
