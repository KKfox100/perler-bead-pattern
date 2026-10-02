'use strict';
/* 拼豆图案生成器 · 图片优化步骤 —— 算法数值验证 + UI 流程验证 */
const path = require('path');
const fs = require('fs');
const { launch, createChecker, sleep } = require('./cdp-client');

const ROOT = path.resolve(__dirname, '..');
const PAGE = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const SHOT = (n) => path.join(__dirname, n);

/* 页面侧工具：造图 + 统计，作为字符串注入 */
const HELPERS = `
function __mk(w,h,draw){
  const c=document.createElement('canvas'); c.width=w; c.height=h;
  const g=c.getContext('2d',{willReadFrequently:true}); g.clearRect(0,0,w,h); draw(g,w,h);
  return c;
}
function __stats(id){
  const d=id.data; let n=0,sr=0,sg=0,sb=0,trans=0; const set=new Set();
  for(let i=0;i<d.length;i+=4){
    if(d[i+3]<20){ trans++; continue; }
    sr+=d[i];sg+=d[i+1];sb+=d[i+2];n++;
    set.add((d[i]>>2<<12)|(d[i+1]>>2<<6)|(d[i+2]>>2));
  }
  if(!n) return {n:0,trans,uniq:0,mean:[0,0,0],std:0};
  const mr=sr/n,mg=sg/n,mb=sb/n;
  let v=0;
  for(let i=0;i<d.length;i+=4){
    if(d[i+3]<20) continue;
    const L=d[i]*0.299+d[i+1]*0.587+d[i+2]*0.114;
    v+=(L-(mr*0.299+mg*0.587+mb*0.114))**2;
  }
  return {n,trans,uniq:set.size,mean:[mr,mg,mb],std:Math.sqrt(v/n)};
}
// 平均梯度强度，用来衡量锐化/降噪
function __grad(id){
  const d=id.data,w=id.width,h=id.height; let s=0,c=0;
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
    const i=(y*w+x)*4, j=(y*w+x+1)*4, k=((y+1)*w+x)*4;
    s+=Math.abs(d[i]-d[j])+Math.abs(d[i]-d[k]); c++;
  }
  return s/c;
}
function __noise(id,x0,y0,x1,y1){
  // 局部方差均值：噪点越多越高。
  // 必须能限定区域 —— 全图统计会把「硬边」本身的方差算进来，
  // 而保边正是双边滤波的设计目标，混在一起量不出降噪效果。
  const d=id.data,w=id.width,h=id.height;
  x0=x0==null?1:x0; y0=y0==null?1:y0; x1=x1==null?w-1:x1; y1=y1==null?h-1:y1;
  let s=0,c=0;
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
    let sum=0,sum2=0;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const p=((y+dy)*w+(x+dx))*4; const L=d[p]*0.299+d[p+1]*0.587+d[p+2]*0.114;
      sum+=L; sum2+=L*L;
    }
    s+=sum2/9-(sum/9)**2; c++;
  }
  return s/c;
}
`;

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
    await ev(HELPERS);

    /* ================= A. 算法层：逐个验证真的起作用 ================= */
    console.log('\n[A] 本地算法数值验证');

    // A1 去背
    const r1 = await ev(`(() => {
      const c = __mk(64,64,(g)=>{ g.fillStyle='#ffffff'; g.fillRect(0,0,64,64);
        g.fillStyle='#cc2222'; g.fillRect(16,16,32,32); });
      const g = c.getContext('2d',{willReadFrequently:true});
      let id = g.getImageData(0,0,64,64);
      const before = __stats(id);
      const cornerBefore = id.data[3];
      id = opRemoveBg(id, 64, 64, 32);
      const after = __stats(id);
      const at = (x,y)=>{ const p=(y*64+x)*4; return [id.data[p],id.data[p+1],id.data[p+2],id.data[p+3]]; };
      return { before, after, cornerBefore, corner: at(2,2), center: at(32,32) };
    })()`);
    check('去背：背景角落被置为透明', r1.corner[3] === 0, `alpha=${r1.corner[3]}`);
    check('去背：主体中心保留不透明', r1.center[3] > 200, `alpha=${r1.center[3]}`);
    check('去背：透明像素数 > 0', r1.after.trans > 0, `trans=${r1.after.trans}`);
    check('去背：保留了主体（非透明像素数约等于 32×32）',
      Math.abs(r1.after.n - 32 * 32) < 32 * 32 * 0.35, `n=${r1.after.n}`);

    // A2 去背不会挖掉主体内部的同色区域（连通域判断）
    const r1b = await ev(`(() => {
      const c = __mk(64,64,(g)=>{ g.fillStyle='#ffffff'; g.fillRect(0,0,64,64);
        g.fillStyle='#cc2222'; g.fillRect(10,10,44,44);          // 红底
        g.fillStyle='#ffffff'; g.fillRect(26,26,12,12); });      // 红底中间挖个白洞
      const g = c.getContext('2d',{willReadFrequently:true});
      let id = g.getImageData(0,0,64,64);
      id = opRemoveBg(id, 64, 64, 32);
      const at=(x,y)=>{const p=(y*64+x)*4; return id.data[p+3];};
      return { hole: at(32,32), corner: at(2,2) };
    })()`);
    check('去背：主体内部同色区域不被误删（连通域生效）',
      r1b.hole > 200 && r1b.corner === 0, `hole=${r1b.hole} corner=${r1b.corner}`);

    // A3 自动调色：暗调低对比图 —— 色阶拉伸应该同时抬高对比度和平均亮度
    // （用中灰做输入的话平均亮度本来就在 127.5 附近，断言"变亮"没有意义）
    const r2 = await ev(`(() => {
      const c = __mk(64,64,(g)=>{ const gr=g.createLinearGradient(0,0,64,0);
        gr.addColorStop(0,'#3c3c3c'); gr.addColorStop(1,'#6e6e6e');
        g.fillStyle=gr; g.fillRect(0,0,64,64); });
      const g = c.getContext('2d',{willReadFrequently:true});
      let id = g.getImageData(0,0,64,64);
      const before = __stats(id);
      id = opAutoColor(id, 64, 64);
      const after = __stats(id);
      return { before, after };
    })()`);
    check('自动调色：对比度（亮度标准差）提升',
      r2.after.std > r2.before.std * 1.15,
      `${r2.before.std.toFixed(1)} → ${r2.after.std.toFixed(1)}`);
    check('自动调色：暗部被拉开（平均亮度提升）',
      r2.after.mean[0] > r2.before.mean[0] + 10,
      `${r2.before.mean[0].toFixed(1)} → ${r2.after.mean[0].toFixed(1)}`);

    // A4 自动调色：白平衡能纠正色偏
    const r2b = await ev(`(() => {
      const c = __mk(48,48,(g)=>{ g.fillStyle='#c8a06e'; g.fillRect(0,0,48,48); });
      const g = c.getContext('2d',{willReadFrequently:true});
      let id = g.getImageData(0,0,48,48);
      const before = __stats(id);
      id = opAutoColor(id, 48, 48);
      const after = __stats(id);
      const spread = (m)=>Math.max(...m)-Math.min(...m);
      return { spreadBefore: spread(before.mean), spreadAfter: spread(after.mean) };
    })()`);
    check('自动调色：色偏被收敛（通道间差缩小）',
      r2b.spreadAfter < r2b.spreadBefore,
      `${r2b.spreadBefore.toFixed(1)} → ${r2b.spreadAfter.toFixed(1)}`);

    // A5 双边滤波：降噪但保边
    const r3 = await ev(`(() => {
      const c = __mk(64,64,(g)=>{
        g.fillStyle='#808080'; g.fillRect(0,0,64,64);
        // 左半边加噪点
        for(let y=0;y<64;y++)for(let x=0;x<32;x++){
          const v=128+Math.round((Math.random()-0.5)*90);
          g.fillStyle='rgb('+v+','+v+','+v+')'; g.fillRect(x,y,1,1);
        }
        // 右半边加一条硬边
        g.fillStyle='#ffffff'; g.fillRect(48,0,16,64);
      });
      const g = c.getContext('2d',{willReadFrequently:true});
      let id = g.getImageData(0,0,64,64);
      // 噪声只统计左半边（x 2..30），右半边的白块硬边留给下一条断言
      const noiseBefore = __noise(id, 2, 2, 30, 62);
      id = bilateralFilter(id, 64, 64, 3, 40);
      const noiseAfter = __noise(id, 2, 2, 30, 62);
      const at=(x,y)=>{const p=(y*64+x)*4; return id.data[p];};
      return { noiseBefore, noiseAfter, edgeLeft: at(46,32), edgeRight: at(52,32) };
    })()`);
    check('双边滤波：噪声方差下降',
      r3.noiseAfter < r3.noiseBefore * 0.6,
      `${r3.noiseBefore.toFixed(0)} → ${r3.noiseAfter.toFixed(0)}`);
    check('双边滤波：硬边两侧仍保持对比（未被糊掉）',
      r3.edgeRight - r3.edgeLeft > 60, `${r3.edgeLeft} vs ${r3.edgeRight}`);

    // A6 色阶量化：颜色数下降
    const r4 = await ev(`(() => {
      const c = __mk(64,64,(g)=>{ const gr=g.createLinearGradient(0,0,64,64);
        gr.addColorStop(0,'#ff0000'); gr.addColorStop(1,'#0000ff');
        g.fillStyle=gr; g.fillRect(0,0,64,64); });
      const g = c.getContext('2d',{willReadFrequently:true});
      let id = g.getImageData(0,0,64,64);
      const before = __stats(id).uniq;
      id = posterize(id, 64, 64, 7);
      const after = __stats(id).uniq;
      return { before, after };
    })()`);
    check('色阶量化：颜色数明显减少',
      r4.after < r4.before * 0.5 && r4.after > 1,
      `${r4.before} → ${r4.after}`);

    // A7 锐化：梯度增强
    const r5 = await ev(`(() => {
      const c = __mk(64,64,(g)=>{ g.fillStyle='#404040'; g.fillRect(0,0,64,64);
        g.fillStyle='#b0b0b0'; g.fillRect(24,24,16,16); });
      const g = c.getContext('2d',{willReadFrequently:true});
      let id = g.getImageData(0,0,64,64);
      const before = __grad(id);
      id = unsharp(id, 64, 64, 0.8);
      const after = __grad(id);
      return { before, after };
    })()`);
    check('锐化：平均梯度增强', r5.after > r5.before * 1.05,
      `${r5.before.toFixed(2)} → ${r5.after.toFixed(2)}`);

    // A8 像素预对齐：输出比例与网格一致，且格子内颜色统一
    const r6 = await ev(`(() => {
      const c = __mk(120,80,(g)=>{ const gr=g.createLinearGradient(0,0,120,0);
        gr.addColorStop(0,'#000000'); gr.addColorStop(1,'#ffffff');
        g.fillStyle=gr; g.fillRect(0,0,120,80); });
      const out = pixelAlign(c, 20, 12, 'stretch', 160, 96);
      const g2 = out.getContext('2d',{willReadFrequently:true});
      const id = g2.getImageData(0,0,out.width,out.height);
      // 检查每个 8×8 块内部是否同色（最近邻放大的特征）
      let nonUniform = 0, blocks = 0;
      for(let by=0;by<12;by++)for(let bx=0;bx<20;bx++){
        const vals=new Set();
        for(let y=0;y<8;y++)for(let x=0;x<8;x++){
          const p=((by*8+y)*160+(bx*8+x))*4;
          vals.add(id.data[p]+','+id.data[p+1]+','+id.data[p+2]);
        }
        blocks++; if(vals.size>1) nonUniform++;
      }
      return { w: out.width, h: out.height, blocks, nonUniform };
    })()`);
    check('像素预对齐：输出尺寸符合设定', r6.w === 160 && r6.h === 96, `${r6.w}×${r6.h}`);
    check('像素预对齐：每个格子内部颜色唯一（最近邻特征）',
      r6.nonUniform === 0, `${r6.nonUniform}/${r6.blocks} 个格子不均匀`);

    // A9 性能护栏：双边滤波是整条流水线唯一的瓶颈（其余步骤都 <50ms），
    // 它一退化，「实时预览」就不实时了。取 3 次最好成绩，减少机器抖动的干扰。
    const r7 = await ev(`(() => {
      const c = drawTo(makeDemoImage(), 720, 720, true);
      const g = c.getContext('2d',{willReadFrequently:true});
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const id = g.getImageData(0,0,720,720);
        const t0 = performance.now();
        bilateralFilter(id, 720, 720, 3, 42);
        const dt = performance.now() - t0;
        if (dt < best) best = dt;
      }
      return Math.round(best);
    })()`);
    check('性能护栏：720px 双边滤波 < 420ms（实时预览的前提）', r7 < 420, `${r7}ms`);

    /* ================= B. UI 流程 ================= */
    console.log('\n[B] UI 流程');
    await ev(`document.getElementById('btnDemo').click()`);
    for (let i = 0; i < 80; i++) {
      if (await ev(`typeof S!=='undefined' && S.result && S.result.colors.length>0`)) break;
      await sleep(150);
    }
    check('优化区块在选图后显示', !(await ev(`document.getElementById('optCard').classList.contains('hidden')`)));
    check('默认无选中方案（等于直出）', (await ev('S.opt.chips.length')) === 0);
    check('默认引擎为本地算法', (await ev('S.opt.engine')) === 'local');
    check('默认 AI 面板隐藏', await ev(`document.getElementById('aiPanel').classList.contains('hidden')`));
    check('默认本地参数面板可见', !(await ev(`document.getElementById('localParams').classList.contains('hidden')`)));

    // 多选
    const clickChip = (id) => ev(`document.querySelector('#chipBox .chip[data-opt="${id}"]').click()`);
    await clickChip('bg');
    check('选中「去背」', JSON.stringify(await ev('S.opt.chips')) === '["bg"]');
    await clickChip('cartoon');
    check('多选生效：去背 + 卡通化', JSON.stringify(await ev('S.opt.chips')) === '["bg","cartoon"]');
    await clickChip('bg');
    check('再点一次取消选中', JSON.stringify(await ev('S.opt.chips')) === '["cartoon"]');

    // 直出排他
    await clickChip('none');
    check('选「直出」清空其它选项', JSON.stringify(await ev('S.opt.chips')) === '["none"]');
    check('「直出」chip 高亮', await ev(`document.querySelector('#chipBox .chip[data-opt="none"]').classList.contains('on')`));
    await clickChip('none');
    check('再点「直出」取消选中', (await ev('S.opt.chips.length')) === 0);

    /* ================= B2. 实时预览 ================= */
    console.log('\n[B2] 实时预览');
    // 等一轮优化结果落地：靠 S.optGen 计数，不靠猜时间
    const afterOpt = async (action) => {
      const g0 = await ev('S.optGen');
      await action();
      for (let i = 0; i < 120; i++) {
        if ((await ev('S.optGen')) > g0) { await sleep(150); return true; }
        await sleep(100);
      }
      return false;
    };
    const setParam = (id, val, evt) => ev(`(()=>{const el=document.getElementById('${id}');
      el.value='${val}'; el.dispatchEvent(new Event('${evt || 'input'}',{bubbles:true})); return true;})()`);

    // 只勾选，全程不点按钮
    check('勾选方案后不点按钮就自动出结果', (await afterOpt(() => clickChip('bg'))) === true);
    check('实时预览确实换了工作图', await ev('S.workImg !== S.img'));
    check('对比视图在实时预览时就已经显示',
      !(await ev(`document.getElementById('compareBox').classList.contains('hidden')`)));
    const cmp = await ev(`({b:document.getElementById('cmpBefore').width, a:document.getElementById('cmpAfter').width,
      bi:document.getElementById('cmpBeforeInfo').textContent, ai:document.getElementById('cmpAfterInfo').textContent})`);
    check('对比视图两侧都有内容', cmp.b > 0 && cmp.a > 0, `${cmp.b} / ${cmp.a}`);
    check('对比信息显示尺寸', /\d+ × \d+/.test(cmp.bi) && /\d+ × \d+/.test(cmp.ai), `${cmp.bi} | ${cmp.ai}`);
    check('状态条标明这是实时预览',
      /实时预览/.test(await ev(`document.getElementById('opStatus').innerText`)),
      await ev(`document.getElementById('opStatus').innerText`));

    // 排豆结果也跟着重算
    const g0 = await ev('S.gen');
    check('加选方案会再跑一轮预览', (await afterOpt(() => clickChip('cartoon'))) === true);
    check('排豆结果同步重算', (await ev('S.gen')) > g0);
    check('实时预览受 720px 上限约束（不按 workRes 全速跑）',
      (await ev('S.optCache.canvas.width')) <= 720, `${await ev('S.optCache.canvas.width')}px`);

    // 拖参数也实时
    check('拖动「去背容差」会自动重跑', (await afterOpt(() => setParam('cutTol', 60))) === true);
    check('切换「卡通化强度」会自动重跑', (await afterOpt(() => setParam('cartoonLv', 3))) === true);
    check('参数确实传进了流水线', (await ev('S.opt.cartoonLv')) === 3 && (await ev('S.opt.cutTol')) === 60);

    // 连续点多个方案 → 防抖合并，只跑最后一轮
    const gb = await ev('S.optGen');
    await ev(`(()=>{const c=document.getElementById('chipBox');
      ['color','denoise','sharpen'].forEach(k=>c.querySelector('.chip[data-opt="'+k+'"]').click());
      return true;})()`);
    for (let i = 0; i < 60; i++) { if ((await ev('S.optGen')) > gb) break; await sleep(120); }
    await sleep(700);
    const rounds = (await ev('S.optGen')) - gb;
    check('连续点三个方案只跑一轮（防抖合并）', rounds === 1, `跑了 ${rounds} 轮`);
    check('最终结果与当前勾选一致',
      await ev(`JSON.stringify(S.optCache.chips) === JSON.stringify(S.opt.chips)`),
      await ev(`JSON.stringify(S.optCache.chips) + ' vs ' + JSON.stringify(S.opt.chips)`));

    // 取消全部勾选 → 立刻回到原图
    await ev(`(()=>{const c=document.getElementById('chipBox');
      ['bg','cartoon','color','denoise','sharpen','align'].forEach(k=>{
        const el=c.querySelector('.chip[data-opt="'+k+'"]'); if(el.classList.contains('on')) el.click();
      }); return true;})()`);
    for (let i = 0; i < 60; i++) { if (await ev('S.workImg === S.img')) break; await sleep(150); }
    check('取消全部方案后立刻回到原图', await ev('S.workImg === S.img'));
    check('回到原图后隐藏对比视图', await ev(`document.getElementById('compareBox').classList.contains('hidden')`));
    check('回到原图后状态回到 idle', (await ev(`document.getElementById('opStatus').className`)).includes('idle'));

    // 参数复位，免得影响后面的用例
    await setParam('cutTol', 32);
    await setParam('cartoonLv', 2);
    await sleep(400);

    // 应用优化
    console.log('\n[C] 应用优化（本地引擎）');
    await clickChip('bg');
    await clickChip('cartoon');
    await clickChip('align');
    const chipsBefore = await ev('JSON.stringify(S.opt.chips)');
    await ev(`document.getElementById('btnOptimize').click()`);
    let done = false;
    for (let i = 0; i < 120; i++) {
      const st = await ev(`document.getElementById('opStatus').className`);
      if (st.includes('ok') || st.includes('err')) { done = true; break; }
      await sleep(200);
    }
    check('优化流程跑完（未卡住）', done === true);
    const stCls = await ev(`document.getElementById('opStatus').className`);
    check('优化状态为成功', stCls.includes('ok'), await ev(`document.getElementById('opStatus').innerText`));
    check('排豆已切换到优化后的图', await ev('S.workImg !== S.img'));

    // 示例图是整幅风景，没有「主体 + 纯色底」的结构 —— 去背在它身上本来就该一无所获。
    // 这里验证的不是"去背生效"，而是产品在无能为力时有没有如实说，而不是假装成功。
    const hint = await ev(`({hidden: document.getElementById('opHint').classList.contains('hidden'),
      text: document.getElementById('opHint').innerText})`);
    check('背景复杂时如实提示「去背没找到背景」',
      hint.hidden === false && /去背/.test(hint.text), hint.hidden ? '(提示条未显示)' : hint.text);

    // 像素预对齐 → workImg 比例应与网格一致
    const alignRatio = await ev(`(() => {
      const gridAsp = S.result.cols / S.result.rows;
      const imgAsp = S.workW / S.workH;
      return { gridAsp, imgAsp, diff: Math.abs(gridAsp - imgAsp) };
    })()`);
    check('像素预对齐：工作图比例 = 网格比例', alignRatio.diff < 0.02,
      `grid=${alignRatio.gridAsp.toFixed(3)} img=${alignRatio.imgAsp.toFixed(3)}`);

    /* 像素预对齐的"块结构"探针：
       对齐后的工作图是「先降到 cols×rows 再最近邻放大」，所以每一行的同色游程
       必然等于格子宽度、色变点必然落在格子边界上。
       直接数「不同色变 x 坐标的个数」应该正好等于 cols-1。
       这比比较画布宽高靠谱 —— 对齐前后画布尺寸是不变的。 */
    const alignProbe = () => ev(`(() => {
      const g = S.workImg.getContext('2d',{willReadFrequently:true});
      const W = S.workImg.width, H = S.workImg.height;
      const d = g.getImageData(0,0,W,H).data;
      const xs = new Set(); const runs = [];
      for(let y=0;y<H;y++){
        let run = 1;
        for(let x=1;x<W;x++){
          const p=(y*W+x)*4, q=p-4;
          if(d[p]!==d[q]||d[p+1]!==d[q+1]||d[p+2]!==d[q+2]){ xs.add(x); runs.push(run); run=1; }
          else run++;
        }
        runs.push(run);
      }
      runs.sort((a,b)=>a-b);
      return { W, cols: S.result.cols, distinctX: xs.size,
               medRun: runs[runs.length>>1], expectRun: W / S.result.cols };
    })()`);

    const apBefore = await alignProbe();
    check('像素预对齐：29 格时块结构符合 29 列',
      apBefore.cols === 29 && apBefore.distinctX === 28,
      `cols=${apBefore.cols} 色变点=${apBefore.distinctX} 块宽=${apBefore.medRun}`);

    // 网格尺寸变化 → 自动重对齐（块结构必须跟着变细）
    await ev(`(() => { const b=[...document.querySelectorAll('#presetSeg button')].find(x=>x.dataset.w==='57');
      b.click(); return true; })()`);
    for (let i = 0; i < 60; i++) {
      if (await ev('S.result && S.result.cols === 57')) break;
      await sleep(150);
    }
    const apAfter = await alignProbe();
    const newRatio = await ev(`Math.abs(S.result.cols/S.result.rows - S.workW/S.workH)`);
    check('改网格尺寸后自动重跑像素预对齐（块结构细化到 57 列）',
      apAfter.cols === 57 && apAfter.distinctX === 56 && apAfter.distinctX > apBefore.distinctX * 1.5,
      `${apBefore.cols}格→${apBefore.distinctX}色变点 / ${apAfter.cols}格→${apAfter.distinctX}色变点`);
    check('重对齐后块宽 = 画布宽 / 网格列数',
      Math.abs(apAfter.medRun - apAfter.expectRun) <= 1,
      `块宽=${apAfter.medRun} 期望≈${apAfter.expectRun.toFixed(2)}`);
    check('重对齐后比例仍与网格一致', newRatio < 0.02, `diff=${newRatio.toFixed(4)}`);

    await browser.shot(SHOT('opt-1-after-local.png'));

    // 恢复原图
    await ev(`document.getElementById('btnResetOpt').click()`);
    await sleep(500);
    check('恢复原图后 workImg 回到原图', await ev('S.workImg === S.img'));
    check('恢复原图后清空选项', (await ev('S.opt.chips.length')) === 0);
    check('恢复原图后隐藏对比视图', await ev(`document.getElementById('compareBox').classList.contains('hidden')`));
    check('恢复原图后状态回到 idle', (await ev(`document.getElementById('opStatus').className`)).includes('idle'));
    check('恢复原图后提示条被清掉', await ev(`document.getElementById('opHint').classList.contains('hidden')`));

    /* ================= C2. 去背端到端（走真实文件输入） ================= */
    console.log('\n[C2] 去背端到端（纯色背景图，走 fileInput）');
    // 示例风景图验不了"去背生效"，这里换成一张白底主体图，
    // 并且真的走 File + change 事件，而不是直接改 S.img。
    await ev(`(async () => {
      const c = __mk(200,200,(g)=>{
        g.fillStyle='#ffffff'; g.fillRect(0,0,200,200);
        g.fillStyle='#2b6cb0'; g.beginPath(); g.arc(100,100,62,0,Math.PI*2); g.fill();
        g.fillStyle='#f6c344'; g.beginPath(); g.arc(100,78,20,0,Math.PI*2); g.fill();
      });
      const blob = await new Promise(r=>c.toBlob(r,'image/png'));
      const dt = new DataTransfer(); dt.items.add(new File([blob],'synthetic.png',{type:'image/png'}));
      const inp = document.getElementById('fileInput');
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change',{bubbles:true}));
      return true;
    })()`);
    let loaded = false;
    for (let i = 0; i < 60; i++) {
      if (await ev(`S.imgW === 200 && S.imgH === 200 && !!S.result`)) { loaded = true; break; }
      await sleep(150);
    }
    check('合成图已通过文件输入载入', loaded, `imgW=${await ev('S.imgW')}`);

    await clickChip('bg');
    check('只选「去背」', JSON.stringify(await ev('S.opt.chips')) === '["bg"]');
    // 实时预览会自动跑，这里刻意不点按钮，直接等结果
    let ok3 = false;
    for (let i = 0; i < 120; i++) {
      const s = await ev(`document.getElementById('opStatus').className`);
      if (s.includes('ok')) { ok3 = true; break; }
      if (s.includes('err')) break;
      await sleep(200);
    }
    check('纯色背景图去背成功（实时预览，未点按钮）', ok3 === true,
      await ev(`document.getElementById('opStatus').innerText`));
    check('去背成功时不显示提示条', await ev(`document.getElementById('opHint').classList.contains('hidden')`));

    const bgAlpha = await ev(`(() => {
      const g = S.workImg.getContext('2d',{willReadFrequently:true});
      const W = S.workImg.width, H = S.workImg.height;
      const d = g.getImageData(0,0,W,H).data;
      let t=0, n=0;
      for(let i=3;i<d.length;i+=4){ if(d[i]<20) t++; else n++; }
      const at=(x,y)=>{const p=(y*W+x)*4; return d[p+3];};
      return { trans:t, opaque:n, corner: at(2,2), center: at(W>>1, H>>1) };
    })()`);
    check('优化结果里存在透明像素（去背真的执行了）', bgAlpha.trans > 0,
      `透明 ${bgAlpha.trans} / 不透明 ${bgAlpha.opaque}`);
    check('四角被去掉、主体中心保留',
      bgAlpha.corner < 20 && bgAlpha.center > 200,
      `corner=${bgAlpha.corner} center=${bgAlpha.center}`);
    check('去背删掉的是背景而不是整张图',
      bgAlpha.trans > bgAlpha.opaque * 0.5 && bgAlpha.opaque > 0,
      `透明 ${bgAlpha.trans} vs 不透明 ${bgAlpha.opaque}`);
    check('去背后的透明区域在图纸里变成空豆（不用再手动勾「忽略背景」）',
      (await ev(`S.result.empty ? S.result.empty.reduce((s,v)=>s+v,0) : 0`)) > 0,
      `空豆 ${await ev(`S.result.empty ? S.result.empty.reduce((s,v)=>s+v,0) : 0`)}`);

    /* ================= C3. 预览分辨率 vs 完整分辨率 ================= */
    console.log('\n[C3] 预览分辨率 vs 完整分辨率');
    // 需要一张比 720 大的图，否则两种路径的输出尺寸一样，测不出区别
    await ev(`(async () => {
      const c = __mk(1200,900,(g)=>{
        const gr=g.createLinearGradient(0,0,1200,0);
        gr.addColorStop(0,'#ffffff'); gr.addColorStop(1,'#7fb2d9');
        g.fillStyle=gr; g.fillRect(0,0,1200,900);
        g.fillStyle='#c94f3d'; g.beginPath(); g.arc(600,450,220,0,Math.PI*2); g.fill();
      });
      const blob = await new Promise(r=>c.toBlob(r,'image/png'));
      const dt = new DataTransfer(); dt.items.add(new File([blob],'big.png',{type:'image/png'}));
      const inp = document.getElementById('fileInput');
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change',{bubbles:true}));
      return true;
    })()`);
    let bigLoaded = false;
    for (let i = 0; i < 80; i++) {
      if (await ev(`S.imgW === 1200 && !!S.result`)) { bigLoaded = true; break; }
      await sleep(150);
    }
    check('大图（1200×900）已载入', bigLoaded, `imgW=${await ev('S.imgW')}`);

    // 裁剪默认跟着成品比例走，会把这个 4:3 的原图收一点点边（29:22 ≠ 4:3）。
    // 收得很少，措辞要如实说"几乎没裁"，不能吓唬用户说"裁剪后 保留 99%"。
    check('非正方形照片导入只收极少边，措辞如实',
      /几乎没裁/.test(await ev(`document.getElementById('cropInfo').textContent`)),
      await ev(`document.getElementById('cropInfo').textContent`));

    // 这一节要测的是"大图走 720 预览 / 1000 完整"两条路径，先恢复整图，
    // 否则测的其实是 1186×900，名不副实。
    await ev(`document.getElementById('btnCropReset').click()`);
    for (let i = 0; i < 40; i++) { if (await ev('S.cropped === false')) break; await sleep(100); }
    check('（前置）恢复整图，底图就是 1200×900 原图',
      await ev('S.baseW === 1200 && S.baseH === 900'),
      await ev(`S.baseW + ' × ' + S.baseH`));

    await clickChip('bg');
    check('(前置) 只选「去背」', JSON.stringify(await ev('S.opt.chips')) === '["bg"]');

    // 选「精细 1000px」→ 实时预览仍然封顶在 720
    check('切到 1000px 后自动重跑预览', (await afterOpt(() => setParam('workRes', '1000', 'change'))) === true);
    check('实时预览封顶在 720px', (await ev('S.optCache.canvas.width')) === 720,
      `${await ev('S.optCache.canvas.width')}px`);
    check('状态条注明这是降分辨率预览',
      /720px 预览/.test(await ev(`document.getElementById('opStatus').innerText`)),
      await ev(`document.getElementById('opStatus').innerText`));

    // 点「高清重跑」→ 完整分辨率
    await ev(`document.getElementById('btnOptimize').click()`);
    let fullDone = false;
    for (let i = 0; i < 150; i++) {
      if ((await ev(`S.optCache && S.optCache.canvas.width`)) === 1000) { fullDone = true; break; }
      await sleep(200);
    }
    check('点「高清重跑」用完整分辨率（1000px）', fullDone,
      `${await ev('S.optCache && S.optCache.canvas.width')}px`);
    const fullTx = await ev(`document.getElementById('opStatus').innerText`);
    check('完整分辨率下状态条改为「已应用」', /已应用/.test(fullTx), fullTx);
    check('高清重跑后按钮没有被预览覆盖回 720',
      (await ev('S.optCache.canvas.width')) === 1000,
      `${await ev('S.optCache.canvas.width')}px`);

    await setParam('workRes', '720', 'change');
    await sleep(500);

    /* ================= D. AI 引擎 UI ================= */
    console.log('\n[D] 第三方 AI 引擎');
    // C2 结束时 chips 还是 ['bg']，先清干净；否则下面再点一次「去背」
    // 是把它取消掉，随后的「缺 Key 报错」用例会因为没选方案而直接跳过。
    await ev(`document.getElementById('btnResetOpt').click()`);
    await sleep(400);
    await ev(`document.querySelector('#engineSeg button[data-engine="ai"]').click()`);
    await sleep(200);
    check('切到 AI 引擎后显示配置面板', !(await ev(`document.getElementById('aiPanel').classList.contains('hidden')`)));
    check('切到 AI 引擎后隐藏本地参数', await ev(`document.getElementById('localParams').classList.contains('hidden')`));
    check('S.opt.engine 已切换', (await ev('S.opt.engine')) === 'ai');

    const ep = await ev(`document.getElementById('aiEndpoint').value`);
    check('OpenAI 预设端点已自动填入', /openai\.com/.test(ep), ep);
    check('按钮文案随引擎切换为「调用 AI 优化」',
      /调用 AI/.test(await ev(`document.getElementById('btnOptimize').textContent`)),
      await ev(`document.getElementById('btnOptimize').textContent`));

    // AI 引擎不能跟着勾选自动跑 —— 花的是用户自己的额度
    const gAI = await ev('S.optGen');
    await clickChip('bg');
    await sleep(800);
    check('AI 引擎下勾选方案不会自动调用接口', (await ev('S.optGen')) === gAI,
      `optGen ${gAI} → ${await ev('S.optGen')}`);
    check('AI 引擎下状态提示需要点按钮',
      /调用 AI/.test(await ev(`document.getElementById('opStatus').innerText`)),
      await ev(`document.getElementById('opStatus').innerText`));

    await ev(`(() => { const s=document.getElementById('aiProvider'); s.value='removebg';
      s.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
    await sleep(150);
    const ep2 = await ev(`document.getElementById('aiEndpoint').value`);
    check('切换服务商后端点跟着变', /remove\.bg/.test(ep2), ep2);
    await browser.shot(SHOT('opt-2-ai-panel.png'));   // AI 面板可见时截图

    // 没填 Key 就点应用 → 应该给出明确错误而不是静默失败
    await ev(`document.getElementById('aiKey').value=''; S.ai.key='';`);
    if (!(await ev(`S.opt.chips.includes('bg')`))) await clickChip('bg');
    check('(前置) 已选中「去背」', await ev(`S.opt.chips.includes('bg')`),
      await ev(`JSON.stringify(S.opt.chips)`));
    await ev(`document.getElementById('btnOptimize').click()`);
    let errShown = false;
    for (let i = 0; i < 40; i++) {
      const s = await ev(`document.getElementById('opStatus').className`);
      if (s.includes('err')) { errShown = true; break; }
      await sleep(150);
    }
    const errText = await ev(`document.getElementById('opStatus').innerText`);
    check('缺少 API Key 时给出明确报错', errShown && /API Key/.test(errText), errText);

    // 填了 Key 但端点不可达 → 应报网络/接口错误，且不崩溃
    // 注意：不能用 9 这种被浏览器列入限制名单的端口，那样报的是
    // ERR_UNSAFE_PORT（根本没发包），测不到真实的网络失败。
    await ev(`(() => {
      const k=document.getElementById('aiKey'); k.value='test-key-123';
      k.dispatchEvent(new Event('input',{bubbles:true}));
      const e=document.getElementById('aiEndpoint'); e.value='http://127.0.0.1:59999/nope';
      e.dispatchEvent(new Event('input',{bubbles:true}));
      return true;
    })()`);
    await ev(`document.getElementById('btnOptimize').click()`);
    let errShown2 = false;
    for (let i = 0; i < 60; i++) {
      const s = await ev(`document.getElementById('opStatus').className`);
      if (s.includes('err')) { errShown2 = true; break; }
      await sleep(200);
    }
    const errText2 = await ev(`document.getElementById('opStatus').innerText`);
    check('接口不可达时报错且不崩溃', errShown2 && errText2.length > 8, errText2.slice(0, 90));
    check('失败后仍可用（页面未卡死）', (await ev('typeof S === "object"')) === true);

    // 回到本地引擎，确认还能正常出图
    await ev(`document.querySelector('#engineSeg button[data-engine="local"]').click()`);
    await sleep(150);
    await ev(`document.getElementById('btnOptimize').click()`);
    let ok2 = false;
    for (let i = 0; i < 120; i++) {
      const s = await ev(`document.getElementById('opStatus').className`);
      if (s.includes('ok')) { ok2 = true; break; }
      if (s.includes('err')) break;
      await sleep(200);
    }
    check('切回本地引擎后仍能正常优化', ok2 === true, await ev(`document.getElementById('opStatus').innerText`));
    await browser.shot(SHOT('opt-4-back-to-local.png'));

    /* ================= E. 移动端 + 控制台 ================= */
    console.log('\n[E] 移动端与控制台');
    await browser.setMobile(390, 844);
    await sleep(700);
    const mob = await ev(`(() => {
      const de = document.documentElement;
      const wrap = document.querySelector('.wrap');
      const chip = document.querySelector('#chipBox .chip');
      const c = document.getElementById('outCanvas'), b = c.parentElement;
      return { clientW: de.clientWidth,
        docOver: de.scrollWidth - de.clientWidth,
        wrapOver: wrap.scrollWidth - wrap.clientWidth,
        canvasW: c.clientWidth, boxW: b.clientWidth,
        chipW: chip ? Math.round(chip.getBoundingClientRect().width) : 0 };
    })()`);
    check('（前置）视口被压到 390', mob.clientW === 390);
    check('移动端无横向溢出', mob.docOver <= 1 && mob.wrapOver <= 1, `${mob.docOver}/${mob.wrapOver}`);
    check('优化选项在手机上是单列可点', mob.chipW > 240, `${mob.chipW}px`);
    check('手机上整幅图纸塞得进预览框', mob.canvasW <= mob.boxW + 1, `画布 ${mob.canvasW} / 预览框 ${mob.boxW}`);
    await browser.shot(SHOT('opt-3-mobile.png'));
    await browser.clearMobile();

    // 上面的用例是故意访问一个不存在的端点，浏览器必然记一条 net::ERR_*，
    // 这是被测行为本身，不是页面缺陷 —— 过滤掉，只留真正意外的报错。
    const errs = browser.consoleErrors()
      .filter(e => !/favicon|net::ERR_|Failed to load resource/i.test(e));
    check('无控制台报错', errs.length === 0, errs.join(' | ').slice(0, 200));

    finish('图片优化步骤：算法 + UI 全部通过');
  } catch (err) {
    console.error('\n💥 测试脚本异常：', err && err.message ? err.message : err);
    if (failures.length) console.error('已记录的失败：', failures.join(', '));
    process.exit(1);
  } finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
  }
})();
