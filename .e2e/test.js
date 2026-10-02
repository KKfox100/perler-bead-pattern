'use strict';
/* 拼豆图案生成器 · 核心功能回归
   覆盖：加载 / 排豆 / 尺寸预设 / 宽高比锁定 / 裁剪 / 适配方式 /
        背景剔除 / 视图切换 / 显示选项 / 缩放 / 自定义色卡 / 导出 CSV / 移动端 */
const path = require('path');
const fs = require('fs');
const { launch, createChecker, sleep } = require('./cdp-client');

const ROOT = path.resolve(__dirname, '..');
const PAGE = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const SHOT = (n) => path.join(__dirname, n);

/* 等 S.result 满足条件 */
async function waitFor(ev, expr, tries, ms) {
  for (let i = 0; i < (tries || 60); i++) {
    if (await ev(expr)) return true;
    await sleep(ms || 150);
  }
  return false;
}

/* 触发一次改动，然后等页面真的重新出图了（靠 S.gen 计数，不靠猜时间） */
async function regen(ev, action) {
  const g0 = await ev('S.gen');
  await action();
  for (let i = 0; i < 80; i++) {
    if ((await ev('S.gen')) > g0) { await sleep(150); return true; }
    await sleep(100);
  }
  return false;
}

/* 改一个控件的值并派发事件 */
const setVal = (ev, id, val, evt) => regen(ev, () => ev(`(()=>{
  const el = document.getElementById(${JSON.stringify(id)});
  if (el.type === 'checkbox') el.checked = ${val ? 'true' : 'false'};
  else el.value = ${JSON.stringify(String(val))};
  el.dispatchEvent(new Event(${JSON.stringify(evt || 'input')}, {bubbles:true}));
  return true;
})()`));

/* 点一个裁剪比例按钮，等页面真的重新出图（同样靠 S.gen，不猜时间） */
async function clickRatio(ev, r) {
  const g0 = await ev('S.gen');
  await ev(`document.querySelector('#cropRatioSeg button[data-ratio=${JSON.stringify(r)}]').click()`);
  for (let i = 0; i < 60; i++) {
    if ((await ev('S.gen')) > g0) { await sleep(150); return true; }
    await sleep(100);
  }
  return false;
}

(async () => {
  const { check, failures, finish } = createChecker();
  let browser;
  try {
    browser = await launch({ width: 1440, height: 1000 });
    const ev = (expr) => browser.eval(expr);

    await browser.goto(PAGE);
    for (let i = 0; i < 40; i++) {
      if (await ev(`getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()`)) break;
      await sleep(100);
    }
    // 页面里的 alert 会阻塞 headless，全部改成记录
    await ev(`window.__alerts=[]; window.alert=(m)=>{ window.__alerts.push(String(m)); }; true`);

    console.log('\n[1] 加载与全局');
    check('页面标题正确', /拼豆/.test(await ev('document.title')), await ev('document.title'));
    check('核心全局对象存在',
      await ev(`['S','generate','exportCsv','exportPattern','opRemoveBg','bilateralFilter','pixelAlign']
        .every(k => typeof window[k] !== 'undefined' || typeof eval(k) !== 'undefined')`));
    check('初始无图片（优化区隐藏）', await ev(`document.getElementById('optCard').classList.contains('hidden')`));
    check('初始无结果', await ev('S.result === null'));

    console.log('\n[2] 示例图 → 排豆');
    await ev(`document.getElementById('btnDemo').click()`);
    check('示例图载入并出结果', await waitFor(ev, `!!S.result && S.result.colors.length > 0`));
    check('源图 480×480', (await ev('S.imgW')) === 480 && (await ev('S.imgH')) === 480);
    check('默认网格 29 × 29', await ev('S.result.cols === 29 && S.result.rows === 29'));
    check('结果区 / 清单区已展开',
      !(await ev(`document.getElementById('resultCard').classList.contains('hidden')`)) &&
      !(await ev(`document.getElementById('listCard').classList.contains('hidden')`)));
    check('图纸画布有像素', await ev(`(()=>{const c=document.getElementById('outCanvas');
      return c.width>0 && c.height>0;})()`));

    console.log('\n[3] 色数限制（核心）');
    const r1 = await ev(`(()=>{
      const R=S.result, total=R.colors.reduce((s,c)=>s+c.count,0);
      const empty=R.empty?R.empty.reduce((s,v)=>s+v,0):0;
      let sorted=true;
      for(let i=1;i<R.colors.length;i++) if(R.colors[i-1].count < R.colors[i].count) sorted=false;
      const palCodes=new Set(S.palette.map(p=>p.code));
      return { colors:R.colors.length, total, empty, sorted,
        allFromPalette:R.colors.every(c=>palCodes.has(c.code)), max:parseInt(document.getElementById('maxColors').value) };
    })()`);
    check('颜色数不超过「最多使用颜色数」', r1.colors <= r1.max, `${r1.colors} ≤ ${r1.max}`);
    check('用豆量 + 空格 = 网格总数', r1.total + r1.empty === 29 * 29, `${r1.total}+${r1.empty}`);
    check('清单按用量降序', r1.sorted === true);
    check('所有用色都来自当前色卡', r1.allFromPalette === true);
    check('颜色数 > 1（不是退化成单色）', r1.colors > 1, `${r1.colors} 色`);

    // 调低色数
    await ev(`(()=>{const m=document.getElementById('maxColors'); m.value='6';
      m.dispatchEvent(new Event('input',{bubbles:true})); return true;})()`);
    await waitFor(ev, `S.result && S.result.colors.length <= 6`);
    const r2 = await ev(`S.result.colors.length`);
    check('把色数压到 6 → 实际不超过 6', r2 <= 6, `${r2} 色`);
    await ev(`(()=>{const m=document.getElementById('maxColors'); m.value='24';
      m.dispatchEvent(new Event('input',{bubbles:true})); return true;})()`);
    await waitFor(ev, `S.result && S.result.colors.length > 6`);

    console.log('\n[4] 尺寸与宽高比');
    for (const w of ['38', '50', '57', '29']) {
      await ev(`(()=>{const b=[...document.querySelectorAll('#presetSeg button')].find(x=>x.dataset.w==='${w}');
        b.click(); return true;})()`);
      await waitFor(ev, `S.result && S.result.cols === ${w}`, 40);
      check(`预设 ${w} × ${w} 生效`, await ev(`S.result.cols === ${w} && S.result.rows === ${w}`),
        await ev(`S.result.cols+'x'+S.result.rows`));
    }

    // 关掉比例锁，手动 40×29
    await ev(`(()=>{const l=document.getElementById('lockRatio'); l.checked=false;
      l.dispatchEvent(new Event('change',{bubbles:true})); return true;})()`);
    await ev(`(()=>{const c=document.getElementById('colsInput'); c.value='40';
      c.dispatchEvent(new Event('input',{bubbles:true})); return true;})()`);
    await ev(`(()=>{const r=document.getElementById('rowsInput'); r.value='29';
      r.dispatchEvent(new Event('input',{bubbles:true})); return true;})()`);
    await waitFor(ev, `S.result && S.result.cols === 40 && S.result.rows === 29`);
    check('手动设置 40 × 29 生效', await ev('S.result.cols === 40 && S.result.rows === 29'));

    // 打开比例锁 → 高度应跟随图片（正方形图 → 40）
    // 注意：上面设成 40×29 时，裁剪框已按「成品比例」把图裁成 40:29 了，
    // 底图不再是正方形。要验"跟随图片比例"，先恢复整图把底图还原成正方形。
    await ev(`document.getElementById('btnCropReset').click()`);
    await waitFor(ev, `S.cropped === false`);
    check('「恢复整图」把底图还原成原图', await ev('S.baseW === S.imgW && S.baseH === S.imgH'));
    await ev(`(()=>{const l=document.getElementById('lockRatio'); l.checked=true;
      l.dispatchEvent(new Event('change',{bubbles:true})); return true;})()`);
    await waitFor(ev, `S.result && S.result.rows === 40`);
    check('开启比例锁后高度跟随图片比例（正方形图 → 40）',
      await ev('S.result.rows === 40'), await ev(`'rows='+S.result.rows`));

    console.log('\n[5] 裁剪');
    check('裁剪卡片在导入后出现',
      !(await ev(`document.getElementById('cropCard').classList.contains('hidden')`)));
    check('裁剪框已按原图摆好', (await ev(`parseFloat(cropFrame.style.width)`)) > 10,
      await ev(`cropFrame.style.width + ' × ' + cropFrame.style.height`));

    // 上一节结尾为了验"高度跟随图片"把裁剪恢复成了整图（自由比例），这里切回成品比例
    await clickRatio(ev, 'board');
    check('（前置）裁剪比例切回「成品比例」', (await ev('S.crop.mode')) === 'board');

    // 手动设成 57×29（宽扁成品）→ 裁剪框应自动贴合新比例
    await setVal(ev, 'lockRatio', false, 'change');
    await setVal(ev, 'colsInput', 57, 'input');
    await setVal(ev, 'rowsInput', 29, 'input');
    const cropAsp = await ev('S.baseW / S.baseH');
    check('裁剪框自动贴合成品比例（57 : 29）',
      Math.abs(cropAsp - 57 / 29) < 0.01, `底图比例 ${cropAsp.toFixed(4)}`);
    check('底图确实被裁小了', (await ev('S.cropped')) === true);
    check('裁剪信息写明了保留比例',
      /保留 \d+%/.test(await ev(`document.getElementById('cropInfo').textContent`)),
      await ev(`document.getElementById('cropInfo').textContent`));
    check('比例标注显示的是成品比例，不是像素约分出来的怪数字',
      /比例 57 : 29/.test(await ev(`document.getElementById('cropInfo').textContent`)),
      await ev(`document.getElementById('cropInfo').textContent`));

    // 底图已经是成品比例 → 三种适配方式结果应当完全一致
    const emptyNow = () => ev(`S.result.empty ? S.result.empty.reduce((s,v)=>s+v,0) : 0`);
    await setVal(ev, 'fitMode', 'contain', 'change');
    const eC2 = await emptyNow();
    await setVal(ev, 'fitMode', 'cover', 'change');
    const eK2 = await emptyNow();
    await setVal(ev, 'fitMode', 'stretch', 'change');
    const eS2 = await emptyNow();
    check('底图已是成品比例时，三种适配方式都不留空豆',
      eC2 === 0 && eK2 === 0 && eS2 === 0, `适应 ${eC2} / 铺满 ${eK2} / 拉伸 ${eS2}`);
    check('并提示「适配方式不再影响结果」',
      (await ev(`document.getElementById('fitNote').style.display`)) !== 'none');

    // 拖动裁剪框主体（垂直方向才有余量，这个裁框是贴满左右边的宽扁条）
    const gDrag = await ev('S.gen');
    const drag = await ev(`(()=>{
      const f = document.getElementById('cropFrame');
      const r = f.getBoundingClientRect();
      const before = Object.assign({}, S.crop.rect);
      const cx = r.left + r.width/2, cy = r.top + r.height/2;
      const mk = (t, y) => new PointerEvent(t, { bubbles:true, cancelable:true,
        pointerId:1, isPrimary:true, button:0, clientX:cx, clientY:y });
      f.dispatchEvent(mk('pointerdown', cy));
      f.dispatchEvent(mk('pointermove', cy + 40));
      f.dispatchEvent(mk('pointerup',   cy + 40));
      return { before, after: Object.assign({}, S.crop.rect) };
    })()`);
    await waitFor(ev, `S.gen > ${gDrag}`, 40);
    check('拖动裁剪框改变了保留区域',
      Math.abs(drag.after.y - drag.before.y) > 1e-4,
      `y ${drag.before.y.toFixed(3)} → ${drag.after.y.toFixed(3)}`);
    check('拖动后比例依然锁死在成品比例',
      Math.abs((drag.after.w * 480) / (drag.after.h * 480) - 57 / 29) < 0.01,
      `比例 ${(drag.after.w / drag.after.h).toFixed(4)}`);

    // 拖手柄缩小
    const gRz = await ev('S.gen');
    const rz = await ev(`(()=>{
      const h = document.querySelector('#cropFrame i[data-h="s"]');
      const r = h.getBoundingClientRect();
      const before = Object.assign({}, S.crop.rect);
      const cx = r.left + r.width/2, cy = r.top + r.height/2;
      const mk = (t, y) => new PointerEvent(t, { bubbles:true, cancelable:true,
        pointerId:2, isPrimary:true, button:0, clientX:cx, clientY:y });
      h.dispatchEvent(mk('pointerdown', cy));
      h.dispatchEvent(mk('pointermove', cy - 40));
      h.dispatchEvent(mk('pointerup',   cy - 40));
      return { before, after: Object.assign({}, S.crop.rect) };
    })()`);
    await waitFor(ev, `S.gen > ${gRz}`, 40);
    check('拖手柄能缩小裁剪框',
      rz.after.h < rz.before.h - 1e-4,
      `h ${rz.before.h.toFixed(3)} → ${rz.after.h.toFixed(3)}`);
    check('缩小时比例仍然精确',
      Math.abs((rz.after.w * 480) / (rz.after.h * 480) - 57 / 29) < 0.01,
      `比例 ${(rz.after.w / rz.after.h).toFixed(4)}`);

    // 切比例预设
    await clickRatio(ev, '1');
    check('切到 1 : 1 后底图变正方形',
      Math.abs((await ev('S.baseW')) - (await ev('S.baseH'))) <= 1,
      await ev(`S.baseW + ' × ' + S.baseH`));

    // 恢复整图
    await ev(`document.getElementById('btnCropReset').click()`);
    await waitFor(ev, `S.cropped === false`, 40);
    check('恢复整图后底图 = 原图',
      await ev('S.baseW === S.imgW && S.baseH === S.imgH'));
    check('恢复整图后切到自由比例', (await ev('S.crop.mode')) === 'free');
    check('「适配方式」的提示随之收起',
      (await ev(`document.getElementById('fitNote').style.display`)) === 'none');

    // 裁剪必须真的流进优化流水线：「优化前」应当是裁剪后的底图
    await clickRatio(ev, '1.3333333333');            // 480×480 裁成 4:3 → 480×360
    check('裁成 4 : 3 后底图尺寸正确',
      (await ev('S.baseW')) === 480 && (await ev('S.baseH')) === 360,
      await ev(`S.baseW + ' × ' + S.baseH`));
    if (!(await ev(`S.opt.chips.includes('bg')`))) {
      await ev(`document.querySelector('#chipBox .chip[data-opt="bg"]').click()`);
    }
    await waitFor(ev, `!!(S.optCache && S.optCache.canvas)`, 60);
    check('「优化前」用的是裁剪后的底图（不是原始照片）',
      (await ev(`document.getElementById('cmpBeforeInfo').textContent`)) === '480 × 360',
      await ev(`document.getElementById('cmpBeforeInfo').textContent`));

    // 改裁剪后，优化结果必须基于新底图重算 —— 拿旧底图优化出来的图去排豆是错的
    await clickRatio(ev, '0.75');                    // 480×480 裁成 3:4 → 360×480
    await waitFor(ev, `!!(S.optCache && S.optCache.canvas)`, 60);
    const cachedAsp = await ev(`S.optCache.canvas.width / S.optCache.canvas.height`);
    const baseAsp   = await ev('S.baseW / S.baseH');
    check('改裁剪后优化结果按新底图重算',
      Math.abs(cachedAsp - baseAsp) < 0.02,
      `缓存比例 ${cachedAsp.toFixed(3)} vs 底图 ${baseAsp.toFixed(3)}`);

    // 收尾：清掉优化选项、恢复整图 + 正方形，后面章节按老前提跑
    await ev(`(()=>{const c=document.querySelector('#chipBox .chip[data-opt="bg"]');
      if(S.opt.chips.includes('bg')) c.click(); return true;})()`);
    await waitFor(ev, `S.opt.chips.length === 0`, 40);
    await ev(`document.getElementById('btnCropReset').click()`);
    await waitFor(ev, `S.cropped === false`, 40);

    console.log('\n[6] 适配方式');
    await setVal(ev, 'lockRatio', false, 'change');
    await setVal(ev, 'colsInput', 40, 'input');
    await setVal(ev, 'rowsInput', 29, 'input');
    const emptyOf = () => ev(`S.result.empty ? S.result.empty.reduce((s,v)=>s+v,0) : 0`);
    await setVal(ev, 'fitMode', 'contain', 'change');
    const eContain = await emptyOf();
    await setVal(ev, 'fitMode', 'cover', 'change');
    const eCover = await emptyOf();
    check('「适应」会留空边（正方形图放进 40×29）', eContain > 0, `空格 ${eContain}`);
    check('「裁剪铺满」不留空边', eCover === 0, `空格 ${eCover}`);

    console.log('\n[7] 背景剔除');
    await setVal(ev, 'fitMode', 'stretch', 'change');
    const eBgOff = await emptyOf();
    await setVal(ev, 'bgRemove', true, 'change');
    const eBgOn = await emptyOf();
    check('开启「忽略背景」后空豆增加（浅色被剔掉）', eBgOn > eBgOff, `${eBgOff} → ${eBgOn}`);
    await setVal(ev, 'bgRemove', false, 'change');
    check('关掉后空豆回到 0', (await emptyOf()) === 0);

    console.log('\n[8] 视图与显示选项');
    await ev(`(()=>{const b=[...document.querySelectorAll('#presetSeg button')].find(x=>x.dataset.w==='29');
      b.click(); return true;})()`);
    await waitFor(ev, `S.result && S.result.cols === 29`);
    await ev(`document.querySelector('#viewSeg button[data-view="bead"]').click()`);
    await sleep(300);
    check('切到成品模式', (await ev('S.view')) === 'bead');
    check('成品模式高亮', await ev(`document.querySelector('#viewSeg button[data-view="bead"]').classList.contains('on')`));
    await ev(`document.querySelector('#viewSeg button[data-view="pattern"]').click()`);
    await sleep(300);
    check('切回图纸模式', (await ev('S.view')) === 'pattern');

    for (const o of ['grid', 'coord', 'code', 'board']) {
      const before = await ev(`S.opts.${o}`);
      await ev(`document.querySelector('#optSeg button[data-opt="${o}"]').click()`);
      await sleep(250);
      check(`显示选项「${o}」可切换`, (await ev(`S.opts.${o}`)) === !before,
        `${before} → ${await ev(`S.opts.${o}`)}`);
    }
    check('开色号后自动放大到能看清字', (await ev('S.lastScale')) >= 30, `scale=${await ev('S.lastScale')}`);
    for (const o of ['grid', 'coord', 'code', 'board']) {
      await ev(`document.querySelector('#optSeg button[data-opt="${o}"]').click()`);
      await sleep(150);
    }
    check('显示选项可关回默认状态',
      await ev(`S.opts.grid===true && S.opts.coord===true && S.opts.code===false && S.opts.board===true`));

    console.log('\n[9] 缩放');
    const z0 = await ev('S.zoom');
    await ev(`document.getElementById('btnZoomIn').click()`);
    await sleep(250);
    const z1 = await ev('S.zoom');
    check('放大按钮改变缩放', z1 > z0, `${z0} → ${z1}`);
    await ev(`document.getElementById('btnZoomFit').click()`);
    await sleep(250);
    check('「适应」把缩放复位', (await ev('S.zoom')) === 1);

    console.log('\n[10] 自定义色卡');
    await ev(`(()=>{const s=document.getElementById('paletteSel'); s.value='custom';
      s.dispatchEvent(new Event('change',{bubbles:true})); return true;})()`);
    await sleep(200);
    check('选自定义后输入框出现', !(await ev(`document.getElementById('customPaletteWrap').classList.contains('hidden')`)));
    await regen(ev, () => ev(`(()=>{const t=document.getElementById('customPalette');
      t.value='A1 #FF0000 正红\\nA2 #00A651 草绿\\nB1 #FFFFFF 白\\nB2 #000000 黑';
      document.getElementById('btnApplyCustom').click(); return true;})()`));
    check('自定义色卡解析出 4 色', (await ev('S.palette.length')) === 4);
    check('自定义色号被识别（6 位 HEX 不被截成 3 位）',
      await ev(`S.palette[0].code === 'A1' && S.palette[0].name === '正红' && S.palette[0].hex === '#FF0000'`),
      await ev(`S.palette[0].code + ' / ' + S.palette[0].hex + ' / ' + S.palette[0].name`));
    check('自定义颜色解析成正确 RGB',
      await ev(`S.palette[0].r === 255 && S.palette[0].g === 0 && S.palette[0].b === 0`),
      await ev(`S.palette.map(p=>p.r+','+p.g+','+p.b).join(' | ')`));
    check('排豆只用自定义色卡里的颜色',
      await ev(`S.result.colors.every(c => ['A1','A2','B1','B2'].includes(c.code))`),
      await ev(`S.result.colors.map(c=>c.code).join(',')`));
    check('色数上限被压到 4', (await ev('parseInt(document.getElementById("maxColors").max)')) === 4);

    // 回到通用色卡
    await setVal(ev, 'paletteSel', 'general', 'change');
    check('切回通用色卡（114 色）', (await ev('S.palette.length')) === 114, `${await ev('S.palette.length')} 色`);

    console.log('\n[11] 导出');
    // 拦截 createObjectURL 拿到 CSV 原始字节；行数用导出当时的颜色数比对，避免竞态
    const csvRes = await ev(`(async ()=>{
      const orig = URL.createObjectURL;
      let blob = null;
      URL.createObjectURL = function(b){ blob = b; return orig.call(URL, b); };
      const nColors = S.result.colors.length;
      const cols = S.result.cols;
      document.getElementById('btnDlCsv').click();
      URL.createObjectURL = orig;
      if(!blob) return null;
      const buf = new Uint8Array(await blob.arrayBuffer());
      return { bytes:[buf[0],buf[1],buf[2]], text: new TextDecoder('utf-8').decode(buf), nColors, cols };
    })()`);
    check('CSV 导出拿到了内容', !!csvRes && csvRes.text.length > 40,
      `${csvRes ? csvRes.text.length : 0} 字符`);
    if (csvRes) {
      check('CSV 以 UTF-8 BOM 开头（Excel 中文不乱码）',
        csvRes.bytes[0] === 0xEF && csvRes.bytes[1] === 0xBB && csvRes.bytes[2] === 0xBF,
        csvRes.bytes.join(' '));
      check('CSV 表头正确', /色号,颜色名称,HEX,用量\(颗\),占比,建议备量/.test(csvRes.text));
      check('CSV 有合计行', /合计,,,/.test(csvRes.text));
      const lines = csvRes.text.trim().split('\n');
      check('CSV 行数 = 表头 + 颜色数 + 合计 + 尺寸行',
        lines.length === csvRes.nColors + 3, `${lines.length} 行 / ${csvRes.nColors} 色`);
      const rows = lines.slice(1, 1 + csvRes.nColors).map(l => l.split(','));
      check('CSV 每行备量 = 用量 × 1.08 向上取整',
        rows.every(r => Number(r[5]) === Math.ceil(Number(r[3]) * 1.08)),
        rows.slice(0, 2).map(r => `${r[3]}→${r[5]}`).join(' , '));
      check('CSV 每行都有色号 / 名称 / HEX',
        rows.every(r => r[0] && r[1] && /^#[0-9A-F]{6}$/.test(r[2])),
        rows[0] ? rows[0].join(' | ') : '');
    }
    // 图纸 PNG：调用不应抛错，且导出后视图状态被还原
    const png = await ev(`(()=>{
      try{ const before={v:S.view,z:S.zoom,g:S.opts.grid,c:S.opts.code};
        exportPattern(false); exportPattern(true);
        const after={v:S.view,z:S.zoom,g:S.opts.grid,c:S.opts.code};
        return { ok:true, restored: JSON.stringify(before)===JSON.stringify(after),
                 w:document.getElementById('outCanvas').width };
      }catch(e){ return { ok:false, err:String(e.message||e) }; }
    })()`);
    check('图纸/成品 PNG 导出不抛错', png.ok === true, png.err || '');
    check('导出后视图与显示选项被还原', png.restored === true);
    check('导出后画布仍有内容', png.w > 0, `${png.w}px`);

    console.log('\n[12] 移动端与控制台');
    await browser.setMobile(390, 844);
    await sleep(700);   // 等 resize 防抖跑完，倍率重算
    const mob = await ev(`(()=>{const de=document.documentElement;
      const c=document.getElementById('outCanvas'), b=c.parentElement;
      return { clientW:de.clientWidth, docOver:de.scrollWidth-de.clientWidth,
               canvasW:c.clientWidth, boxW:b.clientWidth, boxOver:b.scrollWidth-b.clientWidth };})()`);
    check('（前置）视口压到 390', mob.clientW === 390);
    check('移动端无横向溢出', mob.docOver <= 1, `溢出 ${mob.docOver}px`);
    check('手机上整幅图纸塞得进预览框（不用左右拖）',
      mob.canvasW <= mob.boxW + 1, `画布 ${mob.canvasW} / 预览框 ${mob.boxW}`);
    const cropMob = await ev(`(()=>{
      const st = document.querySelector('.crop-stage');
      const f  = document.getElementById('cropFrame');
      const sr = st.getBoundingClientRect(), fr = f.getBoundingClientRect();
      return { over: st.scrollWidth - st.clientWidth,
               inside: fr.left >= sr.left - 2 && fr.right <= sr.right + 2,
               w: Math.round(fr.width), h: Math.round(fr.height) };
    })()`);
    check('手机上裁剪框收在舞台内且不撑破布局',
      cropMob.over <= 1 && cropMob.inside, JSON.stringify(cropMob));
    await browser.shot(SHOT('reg-mobile.png'));
    await browser.clearMobile();

    check('全程没有触发 alert', (await ev('window.__alerts.length')) === 0,
      await ev('window.__alerts.join(" | ").slice(0,120)'));
    const errs = browser.consoleErrors().filter(e => !/favicon/i.test(e));
    check('无控制台报错', errs.length === 0, errs.join(' | ').slice(0, 200));

    finish('核心功能回归全部通过');
  } catch (err) {
    console.error('\n💥 测试脚本异常：', err && err.message ? err.message : err);
    if (failures.length) console.error('已记录的失败：', failures.join(', '));
    process.exit(1);
  } finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
  }
})();
