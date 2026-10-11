// 把「一句话问题」变成 voxway 彩色点阵屏上的一幅画。
//
// 链路：HTTP /api/generate → 本模块 → OpenAI 兼容上游 /chat/completions → 解析成
//      {width,height,format:'RGB888',pixels[]}（就是 device-service 的帧格式）。
//
// 上游环境变量：
//   LLM_API_KEY   必填。缺失时任何生成请求都返回 500 no-api-key。
//   LLM_BASE_URL  可选，默认 https://api.deepseek.com
//   LLM_MODEL     可选，默认 deepseek-chat
//
// 设计取舍：不让模型输出 JSON 的像素数组（2048 个十六进制字符串会淹没在 token 里、
// 也容易截断）。改用「ASCII 画布」：每条网格行写成 "# " + 恰好 W 个颜色索引字符，
// 模型天然擅长对齐字符网格，人也能直接读。索引 0..7 映射到页面调色板 COLORS。

export const PALETTE = Object.freeze([
  '#FFD65A', // 0 暖黄
  '#FF8068', // 1 珊瑚
  '#E994B4', // 2 粉红
  '#AE9CEE', // 3 紫
  '#7CACED', // 4 蓝
  '#75CDA0', // 5 薄荷绿
  '#FFFFFF', // 6 白
  '#000000', // 7 熄灭
]);

// 图元路径（主）与 ASCII 网格路径（备）共用同一套颜色定义，避免两处漂移。
export { BG_INDEX, COLOR_NAMES, blankGrid, gridToChars, parseShapeJson, rasterizeShapes, SHAPES } from './raster.mjs';
import { COLOR_NAMES, parseShapeJson, rasterizeShapes, gridToChars } from './raster.mjs';

export const DEFAULTS = Object.freeze({
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
});

const HEX_TO_INDEX = new Map(PALETTE.map((hex, index) => [hex.toLowerCase(), index]));

/** 读取上游配置；apiKey 缺失不算致命，留到请求时再报 no-api-key。 */
export function readLlmConfig(env = process.env) {
  return {
    baseUrl: String(env.LLM_BASE_URL || '').trim() || DEFAULTS.baseUrl,
    model: String(env.LLM_MODEL || '').trim() || DEFAULTS.model,
    apiKey: String(env.LLM_API_KEY || '').trim(),
  };
}

/** 把任意用户问题收敛成一句安全的提示；只取首行、限长。 */
export function normalizeQuestion(raw, max = 500) {
  const text = String(raw ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim();
  return text.slice(0, max);
}

/** 构造要求模型「用矩形拼出画面」的提示词（主路径，实测成功率远高于 ASCII 网格）。 */
export function buildShapeMessages(question, width, height) {
  const legend = COLOR_NAMES.map((name, i) => `${i}=${name}`).join('  ');
  const system = [
    '你是「橙子旅伴 voxway」头箍上的彩色点阵屏画家。屏幕很小，全靠色块剪影说话。',
    `画布：宽 ${width} 列（x: 0–${width - 1}）、高 ${height} 行（y: 0–${height - 1}，y=0 是屏幕顶端）。`,
    `图元颜色（color 就是色号）：${legend}；背景保持熄灭，不要专门画背景。`,
    '',
    '输出一个 JSON 对象，不要代码块、不要多余解释：',
    `{"title":"<不超过12字>","shapes":[{"x":0,"y":28,"w":${width},"h":4,"color":4}, ...]}`,
    '每个图元就是一个实心矩形：x/y 是左上角，w/h 是宽高，单位是像素。',
    '',
    '构图要求：',
    `- 用 6-16 个矩形拼出可辨认的剪影；用 ${Math.round(height * 0.5)}–${Math.round(height * 0.85)} 行的高度去画主体，别只画一小坨。`,
    '- 至少用 3 种不同颜色（主体一种、阴影/细节一种、高光或点缀一种），不要整个画布一块纯色。',
    '- 画面上下都要有内容：上部放天空/顶部细节，下部放地面/底座。',
    '- 举例：城市天际线 = 底部一排高低不同的楼（几种颜色）+ 上部零散的小方块当窗户/星星；',
    '  灯塔 = 底部礁石 + 中部塔身 + 顶部光圈 + 天上几颗星；蛋糕 = 底部盘子 + 蛋糕身 + 顶部蜡烛 + 火苗。',
    '- 除非用户明确要求文字，不要尝试拼字母。',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: `请根据这句话作画：${question}` },
  ];
}

/** 构造要求模型「画一幅点阵画」的提示词（ASCII 网格，备用路径）。 */
export function buildMessages(question, width, height) {
  const legend = PALETTE.map((hex, i) => (i === 7 ? `${i}=熄灭(背景)` : `${i}=${hex}`)).join('  ');
  const system = [
    '你是「橙子旅伴 voxway」头箍上的彩色点阵屏画家。屏幕很小，全靠色块剪影说话。',
    `画布：宽 ${width} 列、高 ${height} 行，共 ${width * height} 个像素。`,
    `可用颜色（数字即色号）：${legend}`,
    '',
    '输出格式（必须是这个形状，不要代码块、不要表格、不要多余解释）：',
    `第 1 行：一句话说明你画了什么，格式如 标题：<不超过12字>`,
    `第 2 行：说明画的内容,不限制字数`,
    `接下来恰好 ${height} 行：每行以 "# " 开头，后面是恰好 ${width} 个数字字符。`,
    '第 1 条网格行 = 屏幕上边缘，最后一条 = 屏幕下边缘；每行内从左到右。',
    '',
    '构图要求：',
    `- 每行必须恰好 ${width} 个字符，这是最重要的硬约束；多用 7（熄灭）留白。`,
    '- 画具体可辨认的图形/场景/表情，轮廓贴近边缘一点，占满屏幕，不要画成一小坨。',
    '- 用 3-4 种颜色分层（主体、阴影/高光、点缀），避免全屏一种颜色或一整块纯色。',
    '- 画面要上下都有内容，别把图形全堆在底部、上半屏空着。',
    '- 不要写标题文字像素（点阵太小看不清），除非用户明确要求文字。',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: `请根据这句话作画：${question}` },
  ];
}

/**
 * 解析模型输出里的 ASCII 网格行。
 * 容忍：代码块围栏、"# " 或 "#" 前缀、首尾空格、中文标点。
 * 忽略：行内混入其它字符的行（模型偶尔会写解释），不算错误。
 * @returns {{grid:number[][], note:string, rawLineCount:number, malformed:number}}
 */
export function parseAsciiGrid(text, width, height) {
  const lines = String(text ?? '').split(/\r?\n/);
  const candidates = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // "# 777..." 或 "#777..." —— 只认井号后跟颜色索引的行
    const m = trimmed.match(/^#\s*([0-7]+)\s*$/);
    if (m) candidates.push(m[1]);
  }
  const exact = candidates.filter((row) => row.length === width);
  const malformed = candidates.length - exact.length;
  if (exact.length < height) {
    const found = candidates.length ? `找到 ${candidates.length} 条网格行、其中 ${exact.length} 条长度正确` : '没找到任何 "# " 开头的网格行';
    throw new Error(`生成结果不是合法画布（${found}，需要 ${height} 条 × ${width} 字符）`);
  }
  const grid = exact.slice(0, height).map((row) => [...row].map((ch) => Number(ch)));
  return { grid, malformed, rawLineCount: candidates.length };
}

/** 网格 → RGB888 帧（device-service 契约）。 */
export function gridToFrame(grid, width, height) {
  if (!Array.isArray(grid) || grid.length !== height) throw new Error('grid 行数与屏幕高度不符');
  const pixels = [];
  for (let y = 0; y < height; y++) {
    const row = grid[y];
    if (!Array.isArray(row) || row.length !== width) throw new Error(`grid 第 ${y + 1} 行长度不是 ${width}`);
    for (let x = 0; x < width; x++) {
      const index = row[x];
      if (!Number.isInteger(index) || index < 0 || index >= PALETTE.length) throw new Error(`grid 第 ${y + 1} 行第 ${x + 1} 列色号非法：${row[x]}`);
      pixels.push(PALETTE[index]);
    }
  }
  return { width, height, format: 'RGB888', pixels };
}

/** 从模型输出里取标题（形如 标题：xxx）。 */
export function parseTitle(text) {
  const m = String(text ?? '').match(/标题\s*[:：]\s*(.+)/);
  if (!m) return '';
  return m[1].replace(/[#*`\s]+$/g, '').trim().slice(0, 24);
}

/** 画面统计，给前端显示「用了多少像素/几种颜色」，也用于断言不是全空图。 */
export function describeFrame(frame) {
  const counts = new Map();
  for (const hex of frame.pixels) counts.set(hex, (counts.get(hex) || 0) + 1);
  const lit = frame.pixels.length - (counts.get(PALETTE[7]) || 0);
  return {
    total: frame.pixels.length,
    lit,
    colors: [...counts.keys()].filter((hex) => hex !== PALETTE[7]).length,
    coverage: Math.round((lit / frame.pixels.length) * 100),
  };
}

/** 某一行是否整行熄灭（当前未用于判据，保留给后续扩展）。 */

/**
 * 画质闸门：把「格式合法但画得没法看」的结果判为失败，触发重画。
 * 实测踩到的坑：模型会把整张画布涂成一块 2 色的实心方块（`夜晚城市天际线` 一次输出
 * 13 行全 3 号色 + 6 个白点），格式完全合法，但屏幕上就是一块糊掉的颜色。
 * 判据只取「明确没法看」的情况，不追求好看，避免误伤合理构图。
 * @returns {string[]} 问题列表，空数组表示通过
 */
export function auditArt(grid, width, height) {
  const problems = [];
  const counts = new Map();
  for (const row of grid) for (const index of row) counts.set(index, (counts.get(index) || 0) + 1);
  const lit = width * height - (counts.get(7) || 0);
  const nonBg = [...counts.keys()].filter((i) => i !== 7);

  if (lit === 0) problems.push('画布全黑，没有任何内容');
  if (nonBg.length < 2) problems.push(`只用了 ${nonBg.length} 种非背景色，画面没有层次`);

  let topLit = 0;
  for (let y = 0; y < Math.ceil(height / 2); y++) for (const index of grid[y]) if (index !== 7) topLit++;
  // 上半屏太空 —— 屏幕上会像「一条横杠掉在下面」。
  // 用像素量而不是「有没有空白行」：第 6 行才开始画是正常构图，整片空才是问题。
  if (lit > 0 && topLit < lit * 0.15) problems.push(`上半屏只有 ${topLit} 个亮像素（占全图 ${Math.round((topLit / lit) * 100)}%），画面挤在底部`);

  // 单色实心块：最大单一非背景色占比过高，且没有第二种颜色做轮廓
  if (nonBg.length >= 1) {
    const dominant = Math.max(...nonBg.map((i) => counts.get(i) || 0));
    if (dominant / lit > 0.95) problems.push(`点亮区域 ${Math.round((dominant / lit) * 100)}% 是同一种颜色，像色块而不是图形`);
  }
  return problems;
}

/** 归一化模型可能给出的十六进制颜色（备用路径，暂未在提示词里启用）。 */
export function hexToPaletteIndex(hex) {
  return HEX_TO_INDEX.get(String(hex || '').toLowerCase()) ?? null;
}

/**
 * 调一次上游并拿回文本，带超时与重试的公共部分。
 * @returns {string} 模型返回的正文
 */
async function callUpstream({ url, config, messages, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, messages, temperature: 0.9, max_tokens: 4000 }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`upstream ${res.status}${detail ? `：${detail.slice(0, 200)}` : ''}`);
    }
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('上游返回空内容');
    return raw;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`上游超时（${timeoutMs} ms）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 一轮「图元 → 网格」尝试：解析 JSON 图元（解析不出则退回 ASCII 网格解析），
 * 栅格化后过画质闸门。
 * @returns {{grid:number[][], title:string, problems:string[], shapeCount:number, via:string}|null}
 */
function interpretOnce(raw, { width, height, question }) {
  const obj = parseShapeJson(raw);
  let grid = null;
  let title = '';
  let shapeCount = 0;
  let via = 'shapes';
  if (obj && obj.shapes.length) {
    const { grid: g, drawn } = rasterizeShapes(obj.shapes, width, height);
    if (drawn > 0) { grid = g; shapeCount = drawn; }
  }
  if (!grid) {
    // 兜底：模型偶尔仍会给 ASCII 网格（尤其小模型或强格式提示下）
    try {
      const parsed = parseAsciiGrid(raw, width, height);
      grid = parsed.grid;
      via = 'ascii';
    } catch { return null; }
  }
  title = String(obj?.title || '').trim().slice(0, 24) || parseTitle(raw) || question.slice(0, 12);
  return { grid, title, problems: auditArt(grid, width, height), shapeCount, via };
}

/**
 * 让上游画一幅画：主路径「矩形图元」→ 失败则 ASCII 网格 → 再失败带纠正信息重试。
 * @returns {{text:string,title:string,frame:object,chars:string[],stats:object,attempts:number,via:string,shapes:number}}
 */
export async function generateArt({ question, width = 64, height = 32, config = readLlmConfig(), fetchImpl = fetch, timeoutMs = 90_000, retries = 2 } = {}) {
  if (!config.apiKey) throw new Error('no-api-key');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8 || width > 128 || height > 128) {
    throw new Error('屏幕宽高需要是 8–128 之间的整数');
  }
  const clean = normalizeQuestion(question);
  if (!clean) throw new Error('question-required');

  const url = new URL('chat/completions', config.baseUrl.endsWith('/') ? config.baseUrl : config.baseUrl + '/').href;
  const messages = buildShapeMessages(clean, width, height);
  const attemptsTotal = retries + 1;
  let lastError = null;
  let attempts = 0;

  for (let i = 0; i < attemptsTotal; i++) {
    attempts++;
    let raw;
    try {
      raw = await callUpstream({ url, config, messages, fetchImpl, timeoutMs });
    } catch (error) {
      lastError = error;
      continue; // 网络/上游错误：直接重试
    }

    const result = interpretOnce(raw, { width, height, question: clean });
    if (result && result.problems.length === 0) {
      const frame = gridToFrame(result.grid, width, height);
      return {
        text: raw.trim(),
        title: result.title,
        chars: gridToChars(result.grid),
        frame,
        stats: describeFrame(frame),
        attempts,
        via: result.via,
        shapes: result.shapeCount,
      };
    }

    lastError = new Error(result ? `画面不合格：${result.problems.join('；')}` : '模型既没给出可用图元、也没给出 ASCII 网格');
    messages.push({ role: 'assistant', content: raw.slice(0, 4000) });
    messages.push({
      role: 'user',
      content: [
        `上一次输出不能用：${lastError.message}。请重新画一次，严格要求：`,
        `- 只输出一个 JSON 对象 {"title":"...","shapes":[...]}，不要代码块。`,
        `- shapes 里放 6-16 个矩形，每个 {"x":0-${width - 1},"y":0-${height - 1},"w":,"h":,"color":0-6}。`,
        '- 至少 3 种颜色，图形要占满画布上下（上部和下部都有矩形），不要整块纯色。',
      ].join('\n'),
    });
  }
  throw lastError || new Error('生成失败');
}
