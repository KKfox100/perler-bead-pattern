'use strict';
/* 整页截图：确认配色、裁剪交互与实时预览的最终观感 */
const path = require('path');
const { launch, sleep } = require('./cdp-client');

const ROOT = path.resolve(__dirname, '..');
const PAGE = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const SHOT = (n) => path.join(__dirname, n);

(async () => {
  const browser = await launch({ width: 1280, height: 1400 });
  try {
    const ev = (e) => browser.eval(e);
    await browser.goto(PAGE);
    for (let i = 0; i < 40; i++) {
      if (await ev(`getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()`)) break;
      await sleep(100);
    }
    await ev(`window.__alerts=[]; window.alert=m=>window.__alerts.push(String(m)); true`);

    await ev(`document.getElementById('btnDemo').click()`);
    for (let i = 0; i < 80; i++) { if (await ev('S.result && S.result.colors.length>0')) break; await sleep(150); }

    await ev(`window.scrollTo(0,0)`); await sleep(400);
    await browser.shot(SHOT('shot-0-top.png'));

    // 裁剪卡片：默认状态（成品比例，29×29 正方形图 → 整图不裁）
    await ev(`document.getElementById('cropCard').scrollIntoView({block:'start'})`);
    await sleep(500);
    await browser.shot(SHOT('shot-1-crop.png'));

    // 裁成 4:3 —— 看裁剪框和压暗效果
    await ev(`document.querySelector('#cropRatioSeg button[data-ratio="1.3333333333"]').click()`);
    await sleep(700);
    await ev(`document.getElementById('cropCard').scrollIntoView({block:'start'})`);
    await sleep(400);
    await browser.shot(SHOT('shot-2-crop-43.png'));

    await ev(`document.getElementById('optCard').scrollIntoView({block:'start'})`);
    await sleep(500);
    await browser.shot(SHOT('shot-3-opt.png'));

    // 勾上方案 → 等实时预览出结果
    await ev(`(()=>{['bg','cartoon','align'].forEach(k=>
      document.querySelector('#chipBox .chip[data-opt="'+k+'"]').click()); return true;})()`);
    for (let i = 0; i < 80; i++) { if (await ev(`S.optCache && S.optCache.chips.length===3`)) break; await sleep(150); }
    await sleep(400);
    await ev(`document.getElementById('optCard').scrollIntoView({block:'start'})`);
    await sleep(300);
    await browser.shot(SHOT('shot-4-live.png'));

    await ev(`document.getElementById('resultCard').scrollIntoView({block:'start'})`);
    await sleep(400);
    await browser.shot(SHOT('shot-5-result.png'));

    // 57×57 + 成品模式
    await ev(`(()=>{const b=[...document.querySelectorAll('#presetSeg button')].find(x=>x.dataset.w==='57');
      b.click(); return true;})()`);
    for (let i = 0; i < 60; i++) { if (await ev('S.result && S.result.cols===57')) break; await sleep(150); }
    await ev(`document.querySelector('#viewSeg button[data-view="bead"]').click()`);
    await sleep(600);
    await ev(`document.getElementById('resultCard').scrollIntoView({block:'start'})`);
    await sleep(400);
    await browser.shot(SHOT('shot-6-bead57.png'));

    await ev(`document.getElementById('listCard').scrollIntoView({block:'start'})`);
    await sleep(400);
    await browser.shot(SHOT('shot-7-list.png'));

    console.log('统计：', JSON.stringify(await ev(`({cols:S.result.cols, rows:S.result.rows,
      colors:S.result.colors.length, total:S.result.colors.reduce((s,c)=>s+c.count,0),
      cropped:S.cropped, base:S.baseW+'x'+S.baseH, alerts: window.__alerts})`)));
    console.log('截图完成');
  } finally {
    try { await browser.close(); } catch (e) {}
  }
})();
