// 图元 → 画布栅格化（本地确定性计算，不依赖模型对齐字符网格）。
//
// 为什么需要这个：实测让 deepseek-chat 直接输出 64×32 的 ASCII 网格，成功率只有 60% ——
// 它会稳定地退化成「一整块纯色 + 几个点」（对像素网格的空间对齐能力很弱），而且输出 2048 个
// 字符导致响应要 6-9 秒。改成让它只报「矩形」（6-16 个，每种带色号），本地栅格化：
//   实测 3/3 通过、响应 1.5 秒、构图明显更能看（见 test/ab-format.mjs 的对比）。
// 模型擅长的抽象层级（说「天际线 = 底部高楼 + 上部星星」）比逐像素对齐靠谱得多。

export const SHAPES = Object.freeze([
  '#FFD65A', // 0 暖黄
  '#FF8068', // 1 珊瑚
  '#E994B4', // 2 粉红
  '#AE9CEE', // 3 紫
  '#7CACED', // 4 蓝
  '#75CDA0', // 5 薄荷绿
  '#FFFFFF', // 6 白
]);

export const BG_INDEX = 7;
export const COLOR_NAMES = Object.freeze(['暖黄', '珊瑚红', '粉红', '紫', '蓝', '薄荷绿', '白']);

const clampInt = (value, lo, hi) => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
};

/** 建一块全熄灭的画布。 */
export function blankGrid(width, height) {
  return Array.from({ length: height }, () => Array(width).fill(BG_INDEX));
}

/**
 * 把模型给的图元画到网格上。
 * 容错：坐标/尺寸四舍五入并夹到画布内、越界色号忽略、缺字段忽略、w/h <= 0 忽略。
 * 图元按数组顺序叠加（后面的盖住前面的）。
 * @returns {{grid:number[][], drawn:number, skipped:number}}
 */
export function rasterizeShapes(shapes, width, height) {
  const grid = blankGrid(width, height);
  let drawn = 0;
  let skipped = 0;
  for (const shape of Array.isArray(shapes) ? shapes : []) {
    const color = Number(shape?.color);
    if (!Number.isInteger(color) || color < 0 || color > 6) { skipped++; continue; }
    const w = Math.round(Number(shape?.w));
    const h = Math.round(Number(shape?.h));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) { skipped++; continue; }
    const x0 = clampInt(shape.x, -width, width * 2);
    const y0 = clampInt(shape.y, -height, height * 2);
    let painted = 0;
    for (let dy = 0; dy < h; dy++) {
      const y = y0 + dy;
      if (y < 0 || y >= height) continue;
      for (let dx = 0; dx < w; dx++) {
        const x = x0 + dx;
        if (x < 0 || x >= width) continue;
        grid[y][x] = color;
        painted++;
      }
    }
    if (painted) drawn++; else skipped++;
  }
  return { grid, drawn, skipped };
}

/** 从模型输出里抠出 JSON 对象（容忍 ```json 围栏与前后废话）。 */
export function parseShapeJson(text) {
  const raw = String(text ?? '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], raw];
  // 再兜一层：直接截取第一个 { 到最后一个 }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const obj = JSON.parse(candidate.trim());
      if (obj && Array.isArray(obj.shapes)) return obj;
    } catch { /* 试下一个候选 */ }
  }
  return null;
}

/** 网格 → ASCII 行（给 UI 展示，也复用 ASCII 路径的解析器）。 */
export function gridToChars(grid) {
  return grid.map((row) => row.join(''));
}
