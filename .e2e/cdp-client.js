'use strict';

/**
 * 零依赖 CDP 浏览器客户端
 * ------------------------------------------------------------------
 * 用系统已安装的 Chrome / Edge 做真实浏览器验证，不需要 Playwright。
 * 依赖：Node >= 22（全局 WebSocket）
 *
 * 用法：
 *   const { launch } = require('./cdp-client');
 *   const browser = await launch();          // 自动探测浏览器
 *   await browser.goto('http://127.0.0.1:5178/');
 *   console.log(await browser.eval('document.title'));
 *   await browser.shot('shot.png');
 *   await browser.close();
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 探测浏览器可执行文件
 * ------------------------------------------------------------------ */

function detectBrowser() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = process.platform === 'win32'
    ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
    : process.platform === 'darwin'
      ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('没有找到 Chrome / Edge，可用 CHROME_PATH 环境变量指定');
  return hit;
}

/* ------------------------------------------------------------------ *
 * CDP 连接
 * ------------------------------------------------------------------ */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params, timeoutMs) {
    this.seq += 1;
    const id = this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
      }, timeoutMs || 30000);
    });
  }

  /** 执行页面 JS 并取回值；页面抛错会在这里变成异常 */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails;
      const detail = ex.exception ? (ex.exception.description || ex.exception.value) : ex.text;
      throw new Error('页面异常: ' + detail);
    }
    return res.result.value;
  }

  /** 导航并等待 load 事件（不要只 sleep） */
  async goto(url, timeoutMs) {
    this.events = [];
    await this.send('Page.navigate', { url });
    const deadline = Date.now() + (timeoutMs || 15000);
    while (Date.now() < deadline) {
      if (this.events.some((e) => e.method === 'Page.loadEventFired')) return;
      await sleep(60);
    }
    throw new Error('页面加载超时: ' + url);
  }

  async shot(file, opts) {
    const params = Object.assign({ format: 'png' }, opts || {});
    const res = await this.send('Page.captureScreenshot', params);
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    return file;
  }

  /** 页面滚动容器在内部时，用这个滚到底再截图 */
  async scrollToBottom(selector) {
    await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) el.scrollTop = el.scrollHeight;
      else window.scrollTo(0, document.body.scrollHeight);
      return true;
    })()`);
    await sleep(300);
  }

  /** 移动端视口 */
  setMobile(width, height) {
    return this.send('Emulation.setDeviceMetricsOverride', {
      width: width || 390,
      height: height || 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
  }

  clearMobile() {
    return this.send('Emulation.clearDeviceMetricsOverride');
  }

  consoleErrors() {
    return this.events
      .filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
      .map((e) => e.params.entry.text);
  }
}

/* ------------------------------------------------------------------ *
 * 启动 / 关闭
 * ------------------------------------------------------------------ */

/** 这个端口上已经有人在监听了吗？ */
function portInUse(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * 关掉这台浏览器。
 *
 * ⚠️ 别指望 spawn 出来的那个 PID：Windows 上 chrome.exe 常常是个**启动器**，
 * 它把真正的浏览器进程拉起来之后自己就退了（exitCode 立刻变 0）。于是
 *   ① 「exitCode !== null 就跳过」的守卫会让收尾整个变成空操作；
 *   ② taskkill /PID <那个已死的 pid> /T /F 也找不到任何东西，真正的浏览器
 *      带着十几个子进程继续活着（实测残留 12 个），还占着调试端口和临时目录。
 * 而且 taskkill 的 COMMANDLINE 过滤器在中文 Windows 上不支持，没法按
 * --user-data-dir 认人。
 *
 * 有效的是让浏览器自己关自己：CDP 的 Browser.close。实测 12 个进程 → 0，
 * 跨平台，不需要 PID。ws 是浏览器级连接，所以这个命令直接可用。
 * 连不上时才退回按 PID 杀 —— POSIX 上这一条本来就是对的。
 */
async function closeBrowser(ws, child) {
  if (ws) {
    try {
      await new Promise((resolve) => {
        /* ⚠️ id 必须是**数字**。CDP 会静默忽略字符串 id —— 命令不执行、也不报错，
           连回包都没有（实测：'pl-close' 石沉大海，987654321 立刻生效）。
           一个不生效又不报错的关浏览器命令，比没有更糟：它会让人以为收尾做了。 */
        const id = 987654321;
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(done, 5000);
        const onMsg = (ev) => {
          try { if (JSON.parse(ev.data).id === id) done(); } catch (e) { /* 不是回包 */ }
        };
        ws.addEventListener('message', onMsg);
        try { ws.send(JSON.stringify({ id, method: 'Browser.close' })); } catch (e) { done(); }
      });
    } catch (e) { /* 下面还有兜底 */ }
  }
  try { if (child && child.pid && child.exitCode === null) child.kill(); } catch (e) { /* 已经没了 */ }
  await sleep(600);   // 等文件句柄松开，接着的 rmSync 才不会半路失败
}

/**
 * 拿到这台浏览器**真正**在监听的调试端口。
 *
 * ⚠️ 就绪信号不能用「端口能连上」—— 端口被残留进程占着时那个条件也成立，
 * 于是你会连上**别人**的浏览器，量到它停着的那一页，报出来的却是一堆
 * 「页面缺元素 / 文案不对」之类完全无关的失败。
 *
 * 传 0 时 Chrome 会自己挑一个空闲端口，并把它写进 user-data-dir 里的
 * DevToolsActivePort。那个目录每次都是新生成的时间戳目录，所以这个文件
 * 只可能是我们 spawn 的这台写的 —— 它等于一张收据。
 */
async function resolveDebugPort(port, userDir, proc) {
  if (port) return port;                 // 显式端口：调用方那边已经自检过没被占
  const portFile = path.join(userDir, 'DevToolsActivePort');
  for (let i = 0; i < 80; i += 1) {
    try {
      const line = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (line) return Number(line);
    } catch (err) { /* 还没写出来 */ }
    /* ⚠️ 这里**不能**「进程一退出就报错」。
       Windows 上 Chrome 启动时会把活交给另一个进程，被 spawn 的那一个
       很快就 exit 0 —— 实测：**222ms 退出，而端口文件 507ms 才写出来**。
       那个判据必然抢在端口文件之前触发，报「浏览器进程提前退出」，
       而浏览器其实好好的。`browser-check.js` 里同一段没有这一行，
       所以它一直好着 —— 三个脚本挂两个、好一个，差别就在这一行。
       进程退出只是**提示**，判据只有端口文件。 */
    await sleep(250);
  }
  throw new Error('浏览器没写出 ' + portFile + ' —— 调试端口没起来'
    + (proc.exitCode !== null ? '（被 spawn 的进程已退出 exit ' + proc.exitCode + '，这只说明它把活交出去了）' : ''));
}

async function launch(opts) {
  const options = opts || {};
  /* ⚠️ 默认 0 = 「让 Chrome 自己挑一个空闲端口」，不再固定 9333。
   *
   * 固定端口的坑：上一次跑崩（node 被强杀，close() 跑不到）会留下没退干净的
   * 浏览器继续占着这个端口。下一次启动的浏览器抢不到端口，而下面的连接
   * **照样成功** —— 连到的是那台残留实例，它停在哪一页就量哪一页。
   * 端路由 Chrome 分配之后，两台浏览器不可能互相污染。
   *
   * 要固定端口（比如从外面 attach 进来调试）就传 options.port 或设 CDP_PORT，
   * 那时会先自检端口有没有被占，占了就直接报错，不会闷声连错。
   */
  const port = (options.port !== undefined && options.port !== null)
    ? Number(options.port)
    : (process.env.CDP_PORT ? Number(process.env.CDP_PORT) : 0);
  const executable = options.executable || detectBrowser();
  const userDir = path.join(os.tmpdir(), 'cdp-profile-' + Date.now());

  if (port && await portInUse(port)) {
    throw new Error('调试端口 ' + port + ' 已被占用 —— 多半是上一次跑崩留下的浏览器没退干净。\n'
      + '  继续跑会连上那台残留实例、量到它停着的那一页，报出一堆无关的失败。\n'
      + '  处理：杀掉 --user-data-dir 指向临时目录的浏览器；或换个端口；或干脆不传 port 让 Chrome 自选。');
  }

  const proc = spawn(executable, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    `--window-size=${options.width || 1440},${options.height || 940}`,
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDir,
    'about:blank',
  ], { stdio: 'ignore' });

  // 先确认「自己那台」的调试端口起来了，再往上连（见 resolveDebugPort 的注释）
  let debugPort;
  try {
    debugPort = await resolveDebugPort(port, userDir, proc);
  } catch (err) {
    await closeBrowser(null, proc);      // 还没连上 ws，只能按 PID 兜底
    throw err;
  }

  // 端口就绪不等于页面就绪，这里再轮询一次 target 列表
  let targets = null;
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      targets = await res.json();
      if (targets && targets.length) break;
    } catch (err) { /* 继续等 */ }
    await sleep(250);
  }
  if (!targets || !targets.length) {
    await closeBrowser(null, proc);      // 还没连上 ws，只能按 PID 兜底
    throw new Error('无法连接到浏览器调试端口 ' + debugPort);
  }

  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  if (options.log !== false) await cdp.send('Log.enable');

  /* ⚠️ 必须收**整棵**进程树：`proc.kill()` 在 Windows 上只杀得掉主进程，
   * 渲染 / GPU / crashpad 那些子进程会留下来继续占着调试端口 ——
   * 这正是「下一次跑连到残留浏览器、量错页面」的源头。 */
  cdp.close = async () => {
    await closeBrowser(ws, proc);
    // 不清理会占用调试端口和临时目录，导致下次运行失败
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
  };

  return cdp;
}

/* ------------------------------------------------------------------ *
 * 断言小工具
 * ------------------------------------------------------------------ */

function createChecker() {
  const failures = [];
  const check = (label, cond, extra) => {
    console.log((cond ? '  ✓ ' : '  ✗ ') + label + (cond || !extra ? '' : '  → ' + extra));
    if (!cond) failures.push(label);
  };
  return {
    check,
    failures,
    finish(title) {
      console.log('\n' + '='.repeat(56));
      if (failures.length) {
        console.log(`失败 ${failures.length} 项：`);
        failures.forEach((f) => console.log('  - ' + f));
        process.exit(1);
      }
      console.log((title || '全部通过') + ' ✓');
      process.exit(0);
    },
  };
}

module.exports = { launch, detectBrowser, CDP, createChecker, sleep };
