// A/B：比较两种「让模型画 64×32 点阵」的输出格式，用真上游测成功率。
//   A = 当前 ASCII 网格（模型直接画 64×32 字符）
//   B = JSON 图元（模型只报矩形/线，本地确定性栅格化）
// 结论用于决定最小实现采用哪种表示。跑完打印对比表。
import { readFileSync } from 'node:fs';

const key = readFileSync('/home/Asheep233/.dsh/.credentials.yaml', 'utf8').match(/DEEPSEEK_API_KEY:\s*(\S+)/)[1];
const BASE = 'https://api.deepseek.com';
const MODEL = process.env.VOX_AB_MODEL || 'deepseek-chat';
const QS = ['夜晚城市天际线', '一只在雨里淋湿的猫', '海面上的灯塔'];

const PALETTE = ['橙黄', '珊瑚红', '粉红', '紫', '蓝', '薄荷绿', '白', '熄灭'];

async function call(messages, jsonMode) {
  const body = { model: MODEL, temperature: 0.9, max_tokens: 4000, messages };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`upstream ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return d.choices?.[0]?.message?.content || '';
}

// ---------- A：ASCII 网格 ----------
const A_SYS = [
  '你是点阵屏画家。画布宽 64 列、高 32 行。',
  `颜色：${PALETTE.map((n, i) => `${i}=${n}`).join(' ')}`,
  '输出恰好 32 行，每行以 "# " 开头 + 恰好 64 个数字（0-7）。7 是熄灭背景。',
  '用 3-4 种颜色分层；图形上下都要有内容；不要画成一块纯色。',
].join('\n');
function scoreA(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^#\s*([0-7]+)\s*$/);
    if (m) rows.push(m[1]);
  }
  const exact = rows.filter((r) => r.length === 64);
  if (exact.length < 32) return { ok: false, why: `网格行 ${exact.length}/32` };
  const grid = exact.slice(0, 32).map((r) => [...r].map(Number));
  return scoreGrid(grid);
}
function scoreGrid(grid) {
  const counts = new Map();
  for (const row of grid) for (const v of row) counts.set(v, (counts.get(v) || 0) + 1);
  const lit = 2048 - (counts.get(7) || 0);
  const nonBg = [...counts.keys()].filter((i) => i !== 7);
  const topLit = grid.slice(0, 16).reduce((n, row) => n + row.filter((v) => v !== 7).length, 0);
  const dominant = nonBg.length ? Math.max(...nonBg.map((i) => counts.get(i) || 0)) : 0;
  const problems = [];
  if (lit === 0) problems.push('全黑');
  if (nonBg.length < 2) problems.push(`只有 ${nonBg.length} 种颜色`);
  if (lit > 0 && topLit / lit < 0.15) problems.push(`上半屏仅 ${Math.round((topLit / lit) * 100)}%`);
  if (lit > 0 && dominant / lit > 0.95) problems.push('单色填满');
  return { ok: problems.length === 0, why: problems.join('；') || 'OK', lit, colors: nonBg.length, topPct: lit ? Math.round((topLit / lit) * 100) : 0 };
}

// ---------- B：JSON 图元 ----------
const B_SYS = [
  '你是点阵屏画家。画布宽 64 列(x: 0-63)、高 32 行(y: 0-31，y=0 是屏幕顶端)。',
  `颜色索引：0=橙黄 1=珊瑚红 2=粉红 3=紫 4=蓝 5=薄荷绿 6=白（背景保持 7=熄灭，不要画背景）`,
  '用矩形画出图形，可以叠加。字段：{"x":,"y":,"w":,"h":,"color":}。',
  '输出 JSON：{"title":"<不超过12字>","shapes":[{"x":0,"y":0,"w":64,"h":2,"color":4}, ...]}',
  '要求：6-16 个矩形；至少 3 种不同颜色；图形要占满画布上下（上部和下部都要有图元）；',
  '不要把整个画布填成一块纯色；用形状拼出可辨认的剪影（如城市：底部高楼 + 上部星星；灯塔：下部礁石 + 中部塔身 + 顶部光）。',
].join('\n');
function scoreB(text) {
  let obj;
  try {
    obj = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
  } catch { return { ok: false, why: 'JSON 解析失败' }; }
  const shapes = Array.isArray(obj?.shapes) ? obj.shapes : [];
  if (!shapes.length) return { ok: false, why: '没有 shapes' };
  const grid = Array.from({ length: 32 }, () => Array(64).fill(7));
  for (const s of shapes) {
    const x = Math.max(0, Math.min(63, Math.round(Number(s.x) || 0)));
    const y = Math.max(0, Math.min(31, Math.round(Number(s.y) || 0)));
    const w = Math.max(0, Math.round(Number(s.w) || 0));
    const h = Math.max(0, Math.round(Number(s.h) || 0));
    const c = Number(s.color);
    if (!Number.isInteger(c) || c < 0 || c > 6) continue;
    for (let dy = 0; dy < h && y + dy < 32; dy++) for (let dx = 0; dx < w && x + dx < 64; dx++) grid[y + dy][x + dx] = c;
  }
  return { ...scoreGrid(grid), shapes: shapes.length, title: obj.title };
}

console.log(`模型 ${MODEL} · 问题 ${QS.length} 个 · 格式 A(ASCII) vs B(JSON图元)\n`);
const summary = { A: { ok: 0, n: 0 }, B: { ok: 0, n: 0 } };
const usesJsonMode = process.env.VOX_AB_JSONMODE === '1';

for (const q of QS) {
  for (const fmt of ['A', 'B']) {
    const t = Date.now();
    try {
      const text = await call([{ role: 'system', content: fmt === 'A' ? A_SYS : B_SYS }, { role: 'user', content: `画：${q}` }], fmt === 'B' && usesJsonMode);
      const r = fmt === 'A' ? scoreA(text) : scoreB(text);
      summary[fmt].n++;
      if (r.ok) summary[fmt].ok++;
      console.log(`${r.ok ? '✓' : '✗'} [${fmt}] ${q}  ${Date.now() - t}ms  ${r.ok ? `lit=${r.lit} 色=${r.colors} 上屏占比=${r.topPct}%` : r.why}${r.shapes ? ` shapes=${r.shapes}` : ''}`);
      if (fmt === 'B' && r.ok) {
        // 打印 B 的栅格化结果，肉眼确认
        const obj = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
        const grid = Array.from({ length: 32 }, () => Array(64).fill(7));
        for (const s of obj.shapes) {
          const x = Math.max(0, Math.min(63, Math.round(Number(s.x) || 0))), y = Math.max(0, Math.min(31, Math.round(Number(s.y) || 0)));
          const w = Math.max(0, Math.round(Number(s.w) || 0)), h = Math.max(0, Math.round(Number(s.h) || 0)), c = Number(s.color);
          if (!Number.isInteger(c) || c < 0 || c > 6) continue;
          for (let dy = 0; dy < h && y + dy < 32; dy++) for (let dx = 0; dx < w && x + dx < 64; dx++) grid[y + dy][x + dx] = c;
        }
        console.log(grid.map((row) => '    ' + row.map((v) => (v === 7 ? '.' : v)).join('')).join('\n'));
      }
    } catch (error) {
      summary[fmt].n++;
      console.log(`✗ [${fmt}] ${q}  ${Date.now() - t}ms  ${error.message}`);
    }
  }
}
console.log(`\nA(ASCII)   ${summary.A.ok}/${summary.A.n}   B(JSON图元) ${summary.B.ok}/${summary.B.n}`);
