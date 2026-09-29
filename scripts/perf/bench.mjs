// 性能验收（需求文档 7.1）：启动发布版，经 WebView2 远程调试接口在页面里测量
// 用法：node scripts/perf/bench.mjs <Spark.exe> <测试笔记库> [vault|idle|empty]
//   vault：完整流程（冷启动、索引、搜索、打开笔记、输入延迟、内存）
//   idle： 打开笔记库后不做任何操作，只测冷启动与内存
//   empty：不打开笔记库，测空闲内存
// 运行前请关闭正在运行的 Spark。脚本会临时改写应用设置让程序打开测试库，结束时自动恢复。
// 环境变量 EXTRA_WV2 可追加 WebView2 启动参数，例如 --disable-gpu。
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EXE = process.argv[2];
const VAULT = process.argv[3];
const MODE = process.argv[4] ?? "vault";
if (!EXE || !VAULT || !["vault", "idle", "empty"].includes(MODE)) {
  console.error("用法：node scripts/perf/bench.mjs <Spark.exe> <测试笔记库> [vault|idle|empty]");
  process.exit(1);
}
const PORT = 9333;
const SETTINGS = path.join(process.env.APPDATA, "com.spark.app", "settings.json");
const BACKUP = `${SETTINGS}.perf-backup`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
/** 无论正常结束、出错还是按 Ctrl+C，都恢复原来的设置 */
process.on("exit", () => {
  child?.kill();
  if (fs.existsSync(BACKUP)) fs.renameSync(BACKUP, SETTINGS);
});
process.on("SIGINT", () => process.exit(130));

function writeSettings() {
  fs.copyFileSync(SETTINGS, BACKUP);
  const cur = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  cur.lastVault = MODE === "empty" ? null : VAULT;
  cur.openLastVault = true;
  cur.restoreTabs = false;
  cur.vaults = {};
  fs.writeFileSync(SETTINGS, JSON.stringify(cur));
}

async function target() {
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await sleep(20);
  }
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      }
    };
  }
  open() {
    return new Promise((r) => (this.ws.onopen = r));
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((r) => this.pending.set(id, r));
  }
  async eval(expr) {
    const res = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
    return res.result?.result?.value;
  }
}

/** Spark.exe 及其所有子进程（WebView2）的内存 */
function memory(pid) {
  const out = execFileSync("powershell", ["-NoProfile", "-Command", `
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name
    $ids = @(${pid}); $added = $true
    while ($added) { $added = $false; foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $added = $true } } }
    $procs = Get-Process -Id $ids -ErrorAction SilentlyContinue
    $cmd = @{}; Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | ForEach-Object { $cmd[[int]$_.ProcessId] = $_.CommandLine }
    foreach ($p in $procs) {
      $type = if ($cmd[$p.Id] -match '--type=([a-z-]+)') { $matches[1] } else { 'main' }
      "{0}|{1}|{2}|{3}" -f $p.ProcessName, $type, $p.PrivateMemorySize64, $p.WorkingSet64
    }
  `]).toString().trim();
  const rows = out.split(/\r?\n/).map((l) => l.split("|")).map(([name, type, priv, ws]) => ({ name, type, privateMB: +(priv / 1048576).toFixed(1), workingSetMB: +(ws / 1048576).toFixed(1) }));
  const sum = (k) => +rows.reduce((n, r) => n + r[k], 0).toFixed(1);
  return { privateMB: sum("privateMB"), workingSetMB: sum("workingSetMB"), processes: rows };
}

const firstRun = MODE === "vault" && !fs.existsSync(path.join(VAULT, ".ttnote", "cache", "index.db"));
writeSettings();
const t0 = performance.now();
child = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} ${process.env.EXTRA_WV2 ?? ""}` },
  detached: false,
});
const page = await target();
const cdp = new Cdp(page.webSocketDebuggerUrl);
await cdp.open();

const result = { mode: MODE };
// 冷启动：直到文件树出现（打开了笔记库）或空状态出现
const readySel = MODE === "empty" ? ".side-empty" : ".tree .row";
for (;;) {
  const ok = await cdp.eval(`!!document.querySelector(${JSON.stringify(readySel)})`).catch(() => false);
  if (ok) break;
  await sleep(10);
}
result.coldStartMs = Math.round(performance.now() - t0);
result.pageReadyMs = Math.round(await cdp.eval("performance.now()"));

if (MODE === "vault") {
  const inv = (cmd, args) => `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`;
  result.firstRun = firstRun;
  if (firstRun) {
    // 首次建索引期间打开笔记，验证不阻塞编辑
    await sleep(1500);
    result.openNoteDuringIndexMs = await cdp.eval(`(async () => {
      const row = [...document.querySelectorAll('.tree .row')].find((r) => r.textContent.trim() === '大笔记');
      const t = performance.now();
      row.click();
      for (;;) {
        await new Promise((r) => requestAnimationFrame(r));
        const pm = document.querySelector('.pm');
        if (pm && pm.textContent.length > 100000) return Math.round(performance.now() - t);
        if (performance.now() - t > 10000) return -1;
      }
    })()`);
  }
  // 首次建索引（或增量同步）完成的时间：等待与界面同时发起的同步结束
  const idx0 = performance.now();
  const stats = await cdp.eval(inv("index_sync", { root: VAULT }));
  result.indexWaitMs = Math.round(performance.now() - idx0);
  result.indexSinceLaunchMs = Math.round(performance.now() - t0);
  result.indexStats = stats;

  // 搜索（含 IPC）
  const queries = ["同步 冲突", "索引", "#搜索", "path:分类050 编辑器", "sync", "回收站 历史 版本"];
  result.search = [];
  for (const q of queries) {
    const ms = await cdp.eval(`(async () => { const t = performance.now(); const r = await ${inv("index_search", { root: VAULT, query: q, limit: 50 })}; return [performance.now() - t, r.length]; })()`);
    result.search.push({ q, ms: +ms[0].toFixed(1), hits: ms[1] });
  }

  // 打开普通笔记（先打开它，保证后面打开大笔记时是重新加载）
  result.openNoteMs = await cdp.eval(`(async () => {
    const dir = [...document.querySelectorAll('.tree .row')].find((r) => r.textContent.trim() === '分类000');
    dir.click();
    await new Promise((r) => setTimeout(r, 300));
    const row = [...document.querySelectorAll('.tree .row')].find((r) => r.textContent.trim() === '笔记0-1');
    const t = performance.now();
    row.click();
    for (;;) {
      await new Promise((r) => requestAnimationFrame(r));
      const pm = document.querySelector('.pm');
      if (pm && pm.textContent.includes('fn main')) return Math.round(performance.now() - t);
      if (performance.now() - t > 10000) return -1;
    }
  })()`);
  // 打开约 1MB 的大笔记：点击文件树里的“大笔记”，直到正文渲染出来
  result.openBigNoteMs = await cdp.eval(`(async () => {
    const row = [...document.querySelectorAll('.tree .row')].find((r) => r.textContent.trim() === '大笔记');
    const t = performance.now();
    row.click();
    for (;;) {
      await new Promise((r) => requestAnimationFrame(r));
      const pm = document.querySelector('.pm');
      if (pm && pm.textContent.length > 100000) return Math.round(performance.now() - t);
      if (performance.now() - t > 10000) return -1;
    }
  })()`);

  // 输入延迟：在大笔记里连续输入，记录每帧间隔
  await cdp.eval(`(async () => {
    const row = [...document.querySelectorAll('.tree .row')].find((r) => r.textContent.trim() === '大笔记');
    row.click();
    await new Promise((r) => setTimeout(r, 800));
    const pm = document.querySelector('.pm');
    pm.focus();
    const sel = window.getSelection(); sel.selectAllChildren(pm.querySelector('p')); sel.collapseToEnd();
    window.__frames = []; let last = performance.now(); window.__rec = true;
    const loop = (t) => { window.__frames.push(t - last); last = t; if (window.__rec) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  })()`);
  for (let i = 0; i < 40; i++) {
    await cdp.send("Input.insertText", { text: "测" });
    await sleep(40);
  }
  result.typing = await cdp.eval(`(() => { window.__rec = false; const f = window.__frames.slice(2).sort((a, b) => a - b); return { frames: f.length, p50: +f[Math.floor(f.length * .5)].toFixed(1), p95: +f[Math.floor(f.length * .95)].toFixed(1), max: +f[f.length - 1].toFixed(1) }; })()`);
  // 撤销输入，避免修改测试笔记
  for (let i = 0; i < 3; i++) await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", modifiers: 2, windowsVirtualKeyCode: 90 });
}

if (MODE === "idle") {
  const inv = (cmd, args) => `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`;
  const idx0 = performance.now();
  await cdp.eval(inv("index_sync", { root: VAULT }));
  result.incrementalSyncMs = Math.round(performance.now() - idx0);
}
await sleep(10000);
result.memory = memory(child.pid);
console.log(JSON.stringify(result, null, 2));
child.kill();
process.exit(0);

