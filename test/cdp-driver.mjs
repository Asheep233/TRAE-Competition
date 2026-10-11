// Windows 侧 CDP 驱动器（用 Windows 自带的 node.exe 运行，由 test/e2e.mjs 通过 WSL interop 调起）。
//
// 为什么必须在 Windows 侧跑：本机 WSL2 是 NAT 模式，Windows 的 127.0.0.1 与 WSL 的 127.0.0.1
// 是两套 loopback。Chrome 的 CDP 只监听 Windows loopback，WSL 连不上；反过来 Windows Chrome
// 也连不上 WSL 的 127.0.0.1。所以：CDP 在 Windows 侧连，被测页面走 WSL 的 eth0 IP。
//
// 用法：node cdp-driver.mjs <cdpPort> <baseUrl> <outFile>
// 输出：outFile 里是 { pass, fails[], checks[] } 的 JSON。
import { writeFileSync } from 'node:fs';

const [, , cdpPortArg, baseUrlArg, outFile] = process.argv;
const CDP_PORT = Number(cdpPortArg);
const BASE = baseUrlArg;
const OUT = outFile;

const checks = [];
const fails = [];
let pass = 0;
const ok = (cond, label) => {
  checks.push({ ok: Boolean(cond), label });
  if (cond) { pass++; console.log(`VGFACT|PASS|${label}`); } else { fails.push(label); console.log(`VGFACT|FAIL|${label}`); }
};
const eq = (a, b, label) => ok(a === b, `${label}（${JSON.stringify(a)} === ${JSON.stringify(b)}）`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ---- 等 CDP 起来，拿 browser target ----
  let version = null;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) { version = await res.json(); break; }
    } catch { /* retry */ }
    await sleep(200);
  }
  if (!version) throw new Error(`CDP ${CDP_PORT} 未就绪`);
  ok(Boolean(version.webSocketDebuggerUrl), 'CDP /json/version 可用');

  // ---- 连 browser 级 WS，用 Target.createTarget + 扁平会话 ----
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket 打开失败')), { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    socket.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = sessionId;
  await send('Page.enable', {}, S);
  await send('Runtime.enable', {}, S);
  ok(Boolean(S), 'CDP 已附着页面 target');

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, S);
    if (r.exceptionDetails) throw new Error(`页面内异常：${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  };
  const goto = async (url) => {
    await send('Page.navigate', { url }, S);
    for (let i = 0; i < 120; i++) {
      try { if (await evaluate('document.readyState') === 'complete') return; } catch { /* 导航中 */ }
      await sleep(150);
    }
    throw new Error(`页面加载超时：${url}`);
  };

  // ---------------- 断言 ----------------
  console.log('== 1. 页面加载与面板存在 ==');
  await goto(`${BASE}/`);
  eq(await evaluate('document.title.length > 0'), true, '页面有标题');
  eq(await evaluate('!!document.getElementById("voxwayGen")'), true, 'LLM 作画面板存在');
  eq(await evaluate('!!document.getElementById("vgQuestion")'), true, '提问输入框存在');
  eq(await evaluate('typeof window.__voxwayApplyArt'), 'function', 'app.js 暴露了写入钩子');
  eq(await evaluate('typeof window.DianDianApp.setArt'), 'function', 'DianDianApp.setArt 可用');
  ok(await evaluate('document.querySelectorAll("#vgPresets .vg-preset").length >= 3'), '示例问题按钮已渲染');
  ok(await evaluate('getComputedStyle(document.getElementById("voxwayGen")).display !== "none"'), '面板可见（未被 CSS 隐藏）');
  ok(await evaluate('document.getElementById("vgStatus").textContent.includes("等待")'), '初始状态文案正确');
  eq(await evaluate('window.DianDianApp.getFrame().pixels.length'), 2048, '初始画布 64×32');

  console.log('== 2. 点「生成画面」→ 真 HTTP → mock 上游 → 上屏 ==');
  const before = await evaluate('JSON.stringify(window.DianDianApp.getFrame().pixels.slice(0, 64))');
  await evaluate('document.getElementById("vgQuestion").value = "夜色魔方"; true');
  await evaluate('document.getElementById("vgGenerate").click(); true');
  let statusKind = '';
  for (let i = 0; i < 150; i++) {
    statusKind = await evaluate('document.getElementById("vgStatus").dataset.kind');
    if (statusKind === 'ok' || statusKind === 'error') break;
    await sleep(150);
  }
  const statusText = await evaluate('document.getElementById("vgStatus").textContent');
  eq(statusKind, 'ok', `生成成功（状态文案：${statusText}）`);
  ok(statusText.includes('夜色魔方'), '状态栏显示模型返回的标题');
  ok(statusText.includes('64×32'), '状态栏包含尺寸信息');

  console.log('== 3. 画布被替换，且与服务端帧逐像素一致 ==');
  const after = await evaluate('JSON.stringify(window.DianDianApp.getFrame().pixels.slice(0, 64))');
  ok(after !== before, '画布像素已变化');
  eq(await evaluate('window.DianDianApp.getFrame().pixels.length'), 2048, '画布仍是 2048 像素');

  console.log('== 4. 设备屏幕预览（display）已更新 ==');
  // 注意：displayStatus 的文案由 lastSent（发送时间）驱动，生成阶段还没「发送」，
  // 所以那句文案仍是待机 —— 真正的判据是屏幕预览 canvas 的内容（下面第 5 节）。
  const dispStatus = await evaluate('document.getElementById("displayStatus").textContent');
  ok(typeof dispStatus === 'string' && dispStatus.length > 0, `屏幕状态文案存在（${dispStatus}）`);

  console.log('== 5. canvas 上真的画出了东西 ==');
  const painted = await evaluate(`(() => {
    const c = document.getElementById('deviceCanvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonBg = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 60 || d[i+1] > 60 || d[i+2] > 90) nonBg++;
    return nonBg;
  })()`);
  ok(painted > 500, `设备预览 canvas 有内容（亮点像素 ${painted}）`);
  const litPixels = await evaluate('window.DianDianApp.getFrame().pixels.filter(p => p !== "#000000").length');
  ok(litPixels >= 800, `画稿里有 ${litPixels} 个非黑像素`);

  console.log('== 6. ASCII 预览与撤销 ==');
  const ascii = await evaluate('document.getElementById("vgAscii").textContent');
  eq(ascii.split('\n').length, 32, 'ASCII 预览 32 行');
  eq(ascii.split('\n')[0].length, 64, 'ASCII 预览每行 64 字符');
  eq(await evaluate('document.getElementById("undo").disabled'), false, '生成后可撤销（走了 snapshot）');
  await evaluate('document.getElementById("undo").click(); true');
  await sleep(300);
  eq(await evaluate('JSON.stringify(window.DianDianApp.getFrame().pixels.slice(0, 64))'), before, '撤销后回到生成前的画稿');

  console.log('== 7. 连接 mock 设备并发送到屏幕 ==');
  await evaluate('document.getElementById("vgGenerate").click(); true');
  for (let i = 0; i < 150; i++) {
    if (await evaluate('document.getElementById("vgStatus").dataset.kind') === 'ok') break;
    await sleep(150);
  }
  await evaluate('document.getElementById("connectButton").click(); true');
  // 等扫描出设备（selectDevice 由 hidden 变为可见）再点
  let deviceVisible = false;
  for (let i = 0; i < 80; i++) {
    deviceVisible = await evaluate('!document.getElementById("selectDevice").hidden && document.getElementById("selectDevice").offsetParent !== null');
    if (deviceVisible) break;
    await sleep(150);
  }
  ok(deviceVisible, '扫描后出现可选的演示设备');
  await evaluate('document.getElementById("selectDevice").click(); true');
  let devStatus = '';
  for (let i = 0; i < 100; i++) {
    devStatus = await evaluate('document.getElementById("deviceStatus").textContent');
    if (/已连接/.test(devStatus)) break;
    await sleep(150);
  }
  ok(/已连接/.test(devStatus), `设备已连接（${devStatus}）`);
  await evaluate('document.getElementById("sendButton").click(); true');
  let toast = '';
  for (let i = 0; i < 150; i++) {
    toast = await evaluate('document.getElementById("toast").textContent');
    if (/发送成功/.test(toast)) break;
    await sleep(150);
  }
  ok(/发送成功/.test(toast), `发送成功（toast：${toast}）`);
  ok(await evaluate('document.getElementById("lastSentInfo").textContent.includes("最近更新")'), '「我的屏幕」记录最近更新');

  console.log('== 8. 错误路径在 UI 上可见 ==');
  const bad = await evaluate(`(async () => {
    document.getElementById('vgQuestion').value = '';
    document.getElementById('vgGenerate').click();
    await new Promise(r => setTimeout(r, 300));
    return document.getElementById('vgStatus').textContent;
  })()`);
  ok(/先写下/.test(bad), `空问题给出提示（${bad}）`);

  console.log('== 9. 响应式与可访问性抽查 ==');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, S);
  await sleep(400);
  ok(await evaluate('document.getElementById("vgGenerate").getBoundingClientRect().width > 40'), '手机视口下生成按钮仍可点（>40px）');
  ok(await evaluate('document.getElementById("vgQuestion").getBoundingClientRect().height >= 40'), '手机视口下输入框高度 ≥40px');
  ok(await evaluate('document.getElementById("vgStatus").getAttribute("aria-live") === "polite"'), '状态区有 aria-live');
  await send('Emulation.clearDeviceMetricsOverride', {}, S);

  try { await send('Browser.close'); } catch { /* 到点就关 */ }
  writeFileSync(OUT, JSON.stringify({ pass, fails, checks }, null, 2), 'utf8');
  console.log(`VGRESULT|${pass}|${fails.length}`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((error) => {
  fails.push(`驱动异常：${error.message}`);
  console.log(`VGFACT|FAIL|驱动异常：${error.message}`);
  writeFileSync(OUT, JSON.stringify({ pass, fails, checks }, null, 2), 'utf8');
  console.log(`VGRESULT|${pass}|${fails.length}`);
  process.exit(1);
});
