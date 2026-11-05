// 对已发布的线上地址做冒烟验证：能否正常启动、能否切多人桌、能否打完并回看
// 用法: node tools/live-smoke.js [url]
const { chromium } = require('playwright-core');

const URL = process.argv[2] || 'https://gto-poker-18668.app.workbuddy.host/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const problems = [];
function check(cond, msg) { if (!cond) problems.push(msg); else console.log('  ✓ ' + msg); }

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const boot = await page.evaluate(() => ({
    build: document.body.getAttribute('data-build'),
    fail: !!document.getElementById('boot-fail'),
    failText: (document.getElementById('boot-fail') || {}).textContent || '',
    seats: document.querySelectorAll('.pseat').length,
    heroCards: (document.getElementById('cards-0') || {}).children
      ? document.getElementById('cards-0').children.length : -1,
    equity: (document.getElementById('stat-equity') || {}).textContent || '',
    // 4 个按钮：弃牌 / 过牌·跟注（同一按钮按场景切换）/ 下注·加注（同上）/ 全下
    btns: document.querySelectorAll('#btn-fold,#btn-check,#btn-bet,#btn-allin').length,
    playersSeg: !!document.getElementById('seg-players')
  }));

  console.log('\n[1] 启动');
  check(boot.build === '2026.09.27-c', '线上构建号 ' + boot.build);
  check(!boot.fail, '无启动失败提示' + (boot.fail ? ' → ' + boot.failText.slice(0, 200) : ''));
  check(boot.seats === 2, '默认 2 个座位（实际 ' + boot.seats + '）');
  check(boot.heroCards === 2, '玩家手牌已发 ' + boot.heroCards + ' 张');
  check(/%$/.test(boot.equity), '胜率已计算 ' + boot.equity);
  check(boot.btns === 4, '操作按钮 ' + boot.btns + ' 个（弃牌 / 过牌·跟注 / 下注·加注 / 全下）');
  check(boot.playersSeg, '存在「牌桌人数」控件');

  console.log('\n[2] 切到 6 人桌');
  await page.click('#btn-settings');
  await page.waitForTimeout(300);
  await page.click('#seg-players button[data-p="6"]');
  await page.waitForTimeout(200);
  await page.click('#btn-apply-settings');
  await page.waitForTimeout(900);
  const six = await page.evaluate(() => ({
    seats: document.querySelectorAll('.pseat').length,
    title: (document.getElementById('app-title') || {}).textContent || '',
    cards0: document.getElementById('cards-0') ? document.getElementById('cards-0').children.length : -1,
    area: (document.getElementById('table-area') || {}).className || '',
    chips: [...document.querySelectorAll('.pseat .ch')].map(e => e.textContent)
  }));
  check(six.seats === 6, '6 人桌渲染 ' + six.seats + ' 个座位');
  check(/6/.test(six.title), '标题: ' + six.title);
  check(six.cards0 === 2, '玩家手牌 ' + six.cards0 + ' 张');
  check(six.area.indexOf('n6') >= 0, '容器 class: ' + six.area);
  check(six.chips.length === 6, '六个座位都有筹码显示');

  console.log('\n[3] 6 人桌自动打 3 手');
  for (let h = 0; h < 3; h++) {
    await page.evaluate(() => {
      const g = window.GTO_POKER && window.GTO_POKER.game;
      if (g) return;
    });
    // 用 UI 走：反复点「过牌/跟注/弃牌」直到本手结束
    for (let step = 0; step < 80; step++) {
      const done = await page.evaluate(() => {
        const b = document.getElementById('btn-next');
        return !!(b && !b.disabled && b.style.display !== 'none');
      });
      if (done) break;
      const clicked = await page.evaluate(() => {
        const pick = ['btn-check', 'btn-call', 'btn-fold', 'btn-allin'];
        for (const id of pick) {
          const b = document.getElementById(id);
          if (b && !b.disabled && b.offsetParent !== null) { b.click(); return id; }
        }
        return null;
      });
      if (!clicked) await page.waitForTimeout(200);
      await page.waitForTimeout(180);
    }
    await page.waitForTimeout(400);
    const ok = await page.evaluate(() => {
      const b = document.getElementById('btn-next');
      const r = document.getElementById('result-banner');
      return !!(b && !b.disabled && r && r.innerHTML.trim().length > 0);
    });
    check(ok, '第 ' + (h + 1) + ' 手正常结束并显示结果');
    await page.click('#btn-next').catch(() => {});
    await page.waitForTimeout(600);
  }

  const fin = await page.evaluate(() => ({
    total: [...document.querySelectorAll('.pseat .ch')].reduce((a, e) => {
      const m = e.textContent.match(/(\d+)/); return a + (m ? +m[1] : 0);
    }, 0),
    seats: document.querySelectorAll('.pseat').length
  }));
  check(fin.seats === 6, '打完仍是 6 人桌');
  console.log('  · 六座位剩余筹码合计 ' + fin.total);

  console.log('\n[4] 回看');
  await page.click('[data-view="replay"]');
  await page.waitForTimeout(700);
  const rep = await page.evaluate(() => ({
    seats: document.querySelectorAll('#replay-table .pseat').length,
    list: document.querySelectorAll('#r-hand-list [data-h]').length
  }));
  check(rep.seats === 6, '回看渲染 ' + rep.seats + ' 个座位');
  check(rep.list > 0, '回看牌局列表 ' + rep.list + ' 手');

  console.log('\n[5] JS 错误');
  check(errors.length === 0, '零 JS 运行时错误' + (errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''));

  await browser.close();
  console.log('\n' + (problems.length ? '✗ ' + problems.length + ' 项失败:\n - ' + problems.join('\n - ') : '✓ 线上冒烟全部通过'));
  process.exit(problems.length ? 1 : 0);
})().catch(e => { console.error('运行失败:', e); process.exit(2); });
