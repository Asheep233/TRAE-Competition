// voxway-gen 浏览器端 e2e：真 Windows Chrome + 真 HTTP + mock 上游，断言「生成 → 画布 → 上屏」。
//   node test/e2e.mjs
//
// 零 npm 依赖。分工：
//   - 本文件（WSL 侧）起 mock 上游、被测服务、Chrome，并汇总结果。
//   - test/cdp-driver.mjs（Windows 侧 node.exe，WSL interop）连 CDP 并跑断言。
//   为什么分开：本机 WSL2 是 NAT，两套 loopback 互不相通（详见 cdp-driver.mjs 顶部注释）。
//
// 安全：绝不 taskkill chrome.exe；只按本次唯一 user-data-dir marker 精确杀自己起的 Chrome。
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP_PORT = Number(process.env.VG_E2E_PORT || 18199);
const MOCK_PORT = Number(process.env.VG_E2E_MOCK || 18999);
const CDP_PORT = Number(process.env.VG_CDP_PORT || 19222);
const CHROME = process.env.CHROME_PATH || '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe';
const WIN_NODE = process.env.WIN_NODE || '/mnt/c/Program Files/nodejs/node.exe';

/** WSL eth0 IP —— Windows Chrome 只能用这个地址访问 WSL 里的服务（NAT 模式）。 */
function wslIp() {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) if (net.family === 'IPv4' && !net.internal) return net.address;
  }
  throw new Error('找不到 WSL 的 IPv4 地址');
}
const IP = wslIp();
const BASE = `http://${IP}:${APP_PORT}`;

// Windows 侧 node.exe 需要 Windows 盘符路径（C:\... 或 F:\...），不能喂 /mnt/f/... 给它。
const toWin = (wslPath) => wslPath.replace(/^\/mnt\/([a-z])\//, (_, d) => `${d.toUpperCase()}:\\`).replace(/\//g, '\\');
// 把 Windows 路径转成 WSL 能读的路径
const toWsl = (winPath) => winPath.replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
const winTempOut = `C:\\Windows\\Temp\\voxway-e2e-out-${Date.now()}.json`;
const wslOutPath = toWsl(winTempOut);

// ---------- mock 上游：返回矩形图元 JSON（与主路径一致）----------
const MOCK_BODY = JSON.stringify({
  title: '夜色魔方',
  shapes: [
    { x: 0, y: 0, w: 64, h: 3, color: 3 },
    { x: 4, y: 10, w: 12, h: 16, color: 4 },
    { x: 20, y: 6, w: 10, h: 20, color: 5 },
    { x: 34, y: 14, w: 14, h: 12, color: 2 },
    { x: 52, y: 9, w: 10, h: 17, color: 0 },
    { x: 0, y: 28, w: 64, h: 4, color: 1 },
    { x: 8, y: 12, w: 4, h: 4, color: 6 },
    { x: 24, y: 10, w: 3, h: 5, color: 6 },
    { x: 38, y: 18, w: 5, h: 4, color: 6 },
  ],
});
const mock = createServer(async (req, res) => {
  for await (const _ of req) { /* 排空 */ }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: MOCK_BODY } }] }));
});
await new Promise((r) => mock.listen(MOCK_PORT, '0.0.0.0', r));

// ---------- 被测服务 ----------
const fakeHome = await mkdtemp(join(tmpdir(), 'vg-e2e-'));
const app = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
  env: { ...process.env, HOME: fakeHome, PORT: String(APP_PORT), HOST: '0.0.0.0', LLM_API_KEY: 'e2e-key', LLM_BASE_URL: `http://${IP}:${MOCK_PORT}/v1`, LLM_MODEL: 'e2e-mock-model' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let appLog = '';
app.stdout.on('data', (d) => { appLog += d; });
app.stderr.on('data', (d) => { appLog += d; });

for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch { /* retry */ }
  await new Promise((r) => setTimeout(r, 150));
}
// 端口被上一次失败的运行占着时，直接给清晰错误（不要让它变成后面莫名其妙的失败）
try {
  const health = await (await fetch(`${BASE}/api/health`)).json();
  if (!health.ok) throw new Error('health 不 ok');
} catch (error) {
  console.log(`✗ FAIL  服务没起来：${error.message}\n（端口 ${APP_PORT} 可能被上次残留进程占用：pkill -f voxway-gen/server.mjs 后再跑）`);
  console.log('--- app log ---\n' + appLog.slice(-800));
  app.kill('SIGTERM'); mock.close();
  await rm(fakeHome, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
}

// ---------- 起 Windows Chrome（唯一 marker + 独立 profile）----------
const MARKER = `voxway-e2e-${Date.now()}`;
const winProfile = `C:\\Windows\\Temp\\${MARKER}`;
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  '--remote-debugging-address=127.0.0.1',
  '--remote-allow-origins=*',
  `--user-data-dir=${winProfile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--disable-features=Translate,MediaRouter', '--window-size=1280,1600',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d; });

let driverOut = '', driverErr = '', driverCode = null;
const cleanup = async () => {
  // 只按 marker 精确杀本次起的 Chrome（绝不全量 taskkill）
  try {
    await new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${MARKER}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
      { timeout: 20000 }, () => resolve());
    });
  } catch { /* ignore */ }
  try { chrome.kill(); } catch { /* ignore */ }
  app.kill('SIGTERM');
  mock.close();
  await rm(fakeHome, { recursive: true, force: true }).catch(() => {});
  await rm(`/mnt/c/Windows/Temp/${MARKER}`, { recursive: true, force: true }).catch(() => {});
  await rm(wslOutPath, { force: true }).catch(() => {});
};

let summary = null;
try {
  // 等 CDP 端口只在 Windows loopback 上，WSL 侧连不上 —— 直接交给 Windows 侧驱动去等
  const result = await new Promise((resolve) => {
    const child = spawn(WIN_NODE, [toWin(join(ROOT, 'test', 'cdp-driver.mjs')), String(CDP_PORT), BASE, winTempOut], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { driverOut += d; });
    child.stderr.on('data', (d) => { driverErr += d; });
    child.on('close', (code) => resolve(code));
  });
  driverCode = result;
  // 必须在 cleanup 删掉临时文件之前读走结果
  try { summary = JSON.parse(await readFile(wslOutPath, 'utf8')); } catch { /* 见下面的报错分支 */ }
} catch (error) {
  driverErr += `\n驱动启动失败：${error.message}`;
} finally {
  await cleanup();
}

// 打印驱动侧的逐条结果
for (const line of driverOut.split('\n')) {
  const m = line.match(/^VGFACT\|(PASS|FAIL)\|(.+)$/);
  if (m) console.log(`  ${m[1] === 'PASS' ? '✓' : '✗'} ${m[2]}`);
}

// 优先读驱动写出的结构化结果
if (!summary) {
  console.log('\n✗ FAIL  0/0 —— 驱动没有产出结果');
  console.log('--- driver stdout ---\n' + driverOut.slice(-2000));
  console.log('--- driver stderr ---\n' + driverErr.slice(-2000));
  console.log('--- chrome stderr ---\n' + chromeErr.slice(-1000));
  console.log('--- app log ---\n' + appLog.slice(-1000));
  process.exit(1);
}

const total = summary.pass + summary.fails.length;
console.log(`\n${summary.fails.length ? '✗ FAIL' : '✓ PASS'}  ${summary.pass}/${total}  (WSL IP ${IP}，driver exit ${driverCode})`);
if (summary.fails.length) {
  summary.fails.forEach((f) => console.log('  - ' + f));
  console.log('\n--- driver stderr ---\n' + driverErr.slice(-1500));
  console.log('--- chrome stderr ---\n' + chromeErr.slice(-800));
  console.log('--- app log ---\n' + appLog.slice(-1200));
  process.exit(1);
}
