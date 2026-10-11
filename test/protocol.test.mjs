// voxway-gen 协议测试：真 HTTP 服务 + mock 上游（不发真 LLM 请求）。
// 覆盖：静态托管、参数校验、帧契约、错误映射、健康检查。
//   node test/protocol.test.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PALETTE } from '../llm-art.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP_PORT = Number(process.env.VG_TEST_PORT || 18099);
const MOCK_PORT = Number(process.env.VG_MOCK_PORT || 18899);
const BASE = `http://127.0.0.1:${APP_PORT}`;

let pass = 0;
const fails = [];
function ok(cond, label) { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fails.push(label); console.log(`  ✗ ${label}`); } }
function eq(a, b, label) { ok(a === b, `${label}（${JSON.stringify(a)} === ${JSON.stringify(b)}）`); }

// ---- mock 上游：按请求轮次返回不同结果，用来断言服务端行为 ----
let upstreamCalls = 0;
let mode = 'shapes';
const GRID = Array.from({ length: 32 }, (_, y) =>
  '# ' + Array.from({ length: 64 }, (_, x) => ((x + y) % 8 === 7 ? '7' : String((x + y) % 8))).join(''));
// 主路径：模型返回矩形图元 JSON（本地栅格化）。上下都有内容、多色，能过画质闸门。
const SHAPES = JSON.stringify({
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
  upstreamCalls++;
  let body = '';
  for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body || '{}');
  const reply = (content, status = 200) => {
    const payload = JSON.stringify({ choices: [{ message: { content } }] });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
  };
  if (mode === 'shapes') return reply(SHAPES);                    // 主路径：图元 JSON
  if (mode === 'ascii') return reply(['标题：斜条纹', ...GRID].join('\n')); // 备用路径：ASCII 网格
  if (mode === 'bad') return reply('我就是不给你任何画布');
  if (mode === 'malformed-then-good') return upstreamCalls % 2 === 1 ? reply('坏输出') : reply(SHAPES);
  if (mode === 'empty-then-good') return upstreamCalls === 1 ? reply('') : reply(SHAPES);
  if (mode === 'upstream-500') return reply('oh no', 500);
  if (mode === 'echo-model') return reply(JSON.stringify({ model: parsed.model }));
  return reply('unknown mode');
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

// ---- 起被测服务：隔离 HOME（防读到本机凭据），显式给 key，上游指向 mock ----
const fakeHome = await mkdtemp(join(tmpdir(), 'vg-proto-'));
const app = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
  env: {
    ...process.env,
    HOME: fakeHome,
    PORT: String(APP_PORT),
    HOST: '127.0.0.1',
    LLM_API_KEY: 'test-key-123',
    LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    LLM_MODEL: 'mock-model',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let appLog = '';
app.stdout.on('data', (d) => { appLog += d; });
app.stderr.on('data', (d) => { appLog += d; });
await new Promise((r) => setTimeout(r, 600));

const post = (body) => fetch(`${BASE}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const cleanup = async () => {
  app.kill('SIGTERM');
  mock.close();
  await rm(fakeHome, { recursive: true, force: true });
};

try {
  console.log('== 1. 静态托管 ==');
  {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    eq(res.status, 200, 'GET / → 200');
    ok(html.includes('voxway-gen.js'), '首页已接入 voxway-gen.js');
    ok(html.includes('vgQuestion'), '首页含提问输入框');
    const js = await fetch(`${BASE}/voxway-gen.js`);
    eq(js.status, 200, 'voxway-gen.js 可访问');
    eq(js.headers.get('content-type'), 'text/javascript; charset=utf-8', 'js 的 MIME 正确');
    const css = await fetch(`${BASE}/style.css`);
    ok((await css.text()).includes('.vg-panel'), 'style.css 含新面板样式');
    const app = await fetch(`${BASE}/app.js`);
    ok((await app.text()).includes('__voxwayApplyArt'), 'app.js 已带写入钩子');
    const missing = await fetch(`${BASE}/nope.html`);
    eq(missing.status, 404, '不存在的静态文件 → 404');
  }

  console.log('== 2. 参数校验 ==');
  {
    const r1 = await post({});
    eq(r1.status, 400, '缺问题 → 400');
    eq((await r1.json()).error, 'question-required', '错误码 question-required');

    const r2 = await post({ question: '   ' });
    eq(r2.status, 400, '空白问题 → 400');

    const r3 = await fetch(`${BASE}/api/generate`);
    eq(r3.status, 405, 'GET /api/generate → 405');

    const r4 = await fetch(`${BASE}/api/nope`);
    eq(r4.status, 404, '未知 api → 404');

    // 目录穿越：编码后的 ../ 必须被拦在 ROOT 之外
    for (const path of ['/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc%2fpasswd', '/%2e%2e%2fserver.mjs.bak']) {
      const res = await fetch(`${BASE}${path}`);
      ok(res.status === 403 || res.status === 404, `${path} → 拒绝访问（${res.status}）`);
      const body = await res.text();
      ok(!body.includes('root:'), `${path} 没有泄漏文件内容`);
    }
  }

  console.log('== 3. 生成成功路径：图元 JSON（主路径）==');
  {
    upstreamCalls = 0;
    mode = 'shapes';
    const res = await post({ question: '画一个夜晚城市', width: 64, height: 32 });
    const data = await res.json();
    eq(res.status, 200, 'POST /api/generate → 200');
    eq(data.frame.width, 64, '帧宽 64');
    eq(data.frame.height, 32, '帧高 32');
    eq(data.frame.format, 'RGB888', '帧格式 RGB888');
    eq(data.frame.pixels.length, 2048, '2048 像素');
    ok(data.frame.pixels.every((p) => /^#[0-9a-f]{6}$/i.test(p)), '全部是十六进制颜色');
    ok(data.frame.pixels.every((p) => PALETTE.includes(p)), '颜色全部落在页面调色板内（画布能显示）');
    eq(data.title, '夜色魔方', '标题来自 JSON 的 title 字段');
    eq(data.chars.length, 32, '返回 32 行字符（供 UI 展示）');
    eq(data.chars[0].length, 64, '每行 64 字符');
    eq(data.stats.total, 2048, '统计总像素');
    ok(data.stats.lit > 0, '有亮点');
    ok(data.stats.colors >= 3, `至少 3 种颜色（实际 ${data.stats.colors}）`);
    eq(data.via, 'shapes', '走的是图元路径');
    ok(data.shapes >= 6, `栅格化了 ${data.shapes} 个图元`);
    eq(data.model, 'mock-model', '模型名回显');
    eq(upstreamCalls, 1, '上游只被调用一次');
  }

  console.log('== 3b. 备用路径：模型给 ASCII 网格也能用 ==');
  {
    upstreamCalls = 0;
    mode = 'ascii';
    const data = await (await post({ question: '斜条纹', width: 64, height: 32 })).json();
    eq(data.via, 'ascii', '自动回退到 ASCII 解析');
    eq(data.title, '斜条纹', 'ASCII 路径的标题解析');
    eq(data.frame.pixels.length, 2048, 'ASCII 路径也产出 2048 像素');

    // 尺寸与 mock 输出不符 → 重试用尽后 502，验证 width/height 确实透传并参与校验
    const smallRes = await post({ question: '小屏', width: 16, height: 8 });
    eq(smallRes.status, 502, '尺寸与输出不符 → 502（说明 width/height 已透传并校验）');
  }

  console.log('== 4. 失败路径与重试 ==');
  {
    mode = 'malformed-then-good';
    upstreamCalls = 0;
    const res = await post({ question: '重试', width: 64, height: 32 });
    const data = await res.json();
    eq(res.status, 200, '坏格式后重试成功 → 200');
    eq(data.attempts, 2, 'attempts=2');
    eq(upstreamCalls, 2, '上游实际被调用两次');

    mode = 'bad';
    upstreamCalls = 0;
    const r2 = await post({ question: '一直坏', width: 64, height: 32 });
    eq(r2.status, 502, '重试用尽 → 502');
    eq((await r2.json()).error, 'generate-failed', '错误码 generate-failed');
    eq(upstreamCalls, 3, '重试用尽时上游被调用 3 次（1 次 + 2 次重试）');

    mode = 'upstream-500';
    const r3 = await post({ question: '上游挂', width: 64, height: 32 });
    eq(r3.status, 502, '上游 500 → 502');
    ok(/upstream 500/.test((await r3.json()).detail || ''), '透出上游状态码');

    mode = 'empty-then-good';
    upstreamCalls = 0;
    const r4 = await post({ question: '空回复', width: 64, height: 32 });
    eq(r4.status, 200, '上游首次空内容 → 重试后成功');
    eq(upstreamCalls, 2, '空内容也走重试');
    mode = 'bad';
    const r4b = await post({ question: '一直空', width: 64, height: 32 });
    eq(r4b.status, 502, '持续给不出画布 → 502');
  }

  console.log('== 5. 健康检查 ==');
  {
    const res = await fetch(`${BASE}/api/health`);
    const data = await res.json();
    eq(res.status, 200, 'GET /api/health → 200');
    eq(data.hasKey, true, 'hasKey=true');
    eq(data.model, 'mock-model', '模型名来自环境变量');
  }
} finally {
  await cleanup();
}

console.log(`\n${fails.length ? '✗ FAIL' : '✓ PASS'}  ${pass}/${pass + fails.length}`);
if (fails.length) {
  fails.forEach((f) => console.log('  - ' + f));
  console.log('\n--- server log ---\n' + appLog);
  process.exit(1);
}
