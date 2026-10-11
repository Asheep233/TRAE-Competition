// voxway-gen 单测：ASCII 画布解析、帧转换、容错重试。零依赖，失败退出码非 0。
//   node test/unit.test.mjs
import { PALETTE, auditArt, blankGrid, buildMessages, describeFrame, generateArt, gridToChars, gridToFrame, normalizeQuestion, parseAsciiGrid, parseShapeJson, parseTitle, rasterizeShapes } from '../llm-art.mjs';

let pass = 0;
const fails = [];
function ok(cond, label) { if (cond) { pass++; } else { fails.push(label); console.log(`  ✗ ${label}`); } }
function eq(actual, expected, label) { ok(actual === expected, `${label}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`); }
function throws(fn, re, label) {
  try { fn(); fails.push(`${label}（没有抛错）`); console.log(`  ✗ ${label}（没有抛错）`); }
  catch (error) { ok(re.test(error.message), `${label}：${error.message}`); }
}
const row = (s) => s.repeat(64).slice(0, 64);

console.log('== 1. parseAsciiGrid 正常路径 ==');
{
  const body = ['标题：小猫', '# ' + '7'.repeat(64), '# ' + '0'.repeat(64), '# 1234567'.padEnd(66, '7')].join('\n');
  const { grid, rawLineCount, malformed } = parseAsciiGrid(body, 64, 3);
  eq(grid.length, 3, '取满 3 行网格');
  eq(grid[0].length, 64, '每行 64 列');
  eq(grid[0][0], 7, '首行色号 7');
  eq(grid[1][5], 0, '第二行色号 0');
  eq(rawLineCount, 3, '识别 3 条网格行');
  eq(malformed, 0, '无长度错误的行');
}
console.log('== 2. parseAsciiGrid 容错 ==');
{
  const g = parseAsciiGrid(['```', '# ' + '3'.repeat(64), '说明文字这一行会被忽略', '# ' + '5'.repeat(64), '```'].join('\n'), 64, 2);
  eq(g.grid.length, 2, '忽略非网格行与代码块围栏');
  eq(g.grid[1][0], 5, '第二行色号 5');

  // 长度不对的行被丢弃并计数，不影响后面的正确行
  const g2 = parseAsciiGrid(['# ' + '1'.repeat(30), '# 1' + '2'.repeat(63), '# ' + '4'.repeat(64)].join('\n'), 64, 2);
  eq(g2.malformed, 1, '长度错误的行计入 malformed');
  eq(g2.grid.length, 2, '仍能取满 2 行正确网格');

  // 无分隔空格、前后留白、\r\n 也可解析
  const g3 = parseAsciiGrid('# ' + '0'.repeat(64) + '\r\n   #' + '6'.repeat(64) + '  \r\n', 64, 2);
  eq(g3.grid.length, 2, '容忍 CRLF 与首尾空白');
  eq(g3.grid[1][0], 6, '无空格前缀也可解析');
}
console.log('== 3. parseAsciiGrid 失败路径 ==');
{
  throws(() => parseAsciiGrid('我画了一幅画，但没有网格行', 64, 32), /不是合法画布|没找到/, '缺少网格行时报错');
  throws(() => parseAsciiGrid(['# ' + '1'.repeat(64)].join('\n'), 64, 32), /需要 32 条/, '行数不足时报错并说明需求');
  throws(() => parseAsciiGrid('# ' + '9'.repeat(64), 64, 1), /不是合法画布/, '色号 9 不是网格行（正则只认 0-7）');
}
console.log('== 4. gridToFrame / describeFrame ==');
{
  const grid = [[...row('7')].map(Number), [...'0'.repeat(32) + '4'.repeat(32)].map(Number)];
  const frame = gridToFrame(grid, 64, 2);
  eq(frame.format, 'RGB888', '格式 RGB888');
  eq(frame.pixels.length, 128, '像素数量 = w×h');
  eq(frame.pixels[0], PALETTE[7], '索引 7 → 熄灭色');
  eq(frame.pixels[64], PALETTE[0], '索引 0 → 暖黄');
  eq(frame.pixels[96], PALETTE[4], '索引 4 → 蓝色');
  const stats = describeFrame(frame);
  eq(stats.total, 128, '统计总像素');
  eq(stats.lit, 64, '点亮 = 非熄灭');
  eq(stats.colors, 2, '统计两种颜色');
  eq(stats.coverage, 50, '覆盖率 50%');
  throws(() => gridToFrame([[1, 2]], 64, 1), /长度不是 64/, '行宽不符时报错');
  throws(() => gridToFrame([[...'7'.repeat(64)].map(() => 9)], 64, 1), /色号非法/, '色号越界时报错');
  throws(() => gridToFrame([[...'7'.repeat(64)].map(Number)], 64, 2), /行数/, '行数不符时报错');
}
console.log('== 5. normalizeQuestion / parseTitle / buildMessages ==');
{
  eq(normalizeQuestion('  画只猫  '), '画只猫', '去掉首尾空白');
  eq(normalizeQuestion('a'.repeat(600)).length, 500, '超长问题截断到 500');
  eq(normalizeQuestion('第一行\n第二行'), '第一行\n第二行', '保留换行（模型能看懂）');
  eq(parseTitle('标题：雨里的猫\n# ...'), '雨里的猫', '解析标题');
  eq(parseTitle('没有任何前缀'), '', '无标题返回空串');
  const msgs = buildMessages('雨里的猫', 64, 32);
  eq(msgs.length, 2, '两条消息');
  ok(msgs[0].content.includes('64 列'), '提示词含 64 列');
  ok(msgs[0].content.includes('32 行'), '提示词含 32 行');
  ok(msgs[0].content.includes('恰好 64 个字符'), '提示词强调硬约束');
  eq(msgs[1].content.includes('雨里的猫'), true, '用户问题进入消息');
}

console.log('== 6. auditArt 画质闸门（实测踩过的坑）==');
{
  const H = 32, W = 64;
  // 真·实测缺陷：模型返回「整块 3 号色 + 几个白点」，格式合法但屏幕上一块糊色
  const slab = Array.from({ length: H }, (_, y) => [...(y < 19 ? '7'.repeat(W) : '7'.repeat(W - 1) + '6')].map(Number));
  const slabProblems = auditArt(slab, W, H);
  ok(slabProblems.length > 0, `整块实心色应被拦下（${slabProblems.join('；')}）`);
  ok(slabProblems.some((p) => /七成|一种颜色/.test(p)), '报出「单色填满」问题');

  // 全黑
  const black = Array.from({ length: H }, () => [...'7'.repeat(W)].map(Number));
  ok(auditArt(black, W, H).some((p) => /全黑/.test(p)), '全黑应被拦下');

  // 只有一种非背景色（哪怕形状正常）也提醒层次不足
  const mono = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => (y > 8 && y < 24 && x > 16 && x < 48 ? 1 : 7)));
  ok(auditArt(mono, W, H).some((p) => /层次/.test(p)), '单色图形报「没有层次」');

  // 正常画面：上下都有内容、3 种颜色 → 必须通过
  const good = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => {
    if (y < 3) return 6;
    if (y > 10 && y < 22 && x > 10 && x < 30) return (y + x) % 3 === 0 ? 0 : 1;
    if (y > 24 && y < 29 && x > 40 && x < 58) return 4;
    return 7;
  }));
  eq(auditArt(good, W, H).length, 0, `正常画面应通过（${auditArt(good, W, H).join('；')}）`);

  // 图形全在底部、上半屏全空 → 拦下
  // 图形全在底部、上半屏全空（顶部另有一个小点缀，避免触发其它规则）→ 只该报「上半屏空白」
  const bottomOnly = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => {
    if (y < 2 && x > 4 && x < 10) return 6;
    if (y > 26 && x > 20 && x < 54) return 2;
    return 7;
  }));
  const bottomProblems = auditArt(bottomOnly, W, H);
  eq(bottomProblems.length, 1, `只该报一个问题（实际 ${bottomProblems.join('；')}）`);
  ok(/底部/.test(bottomProblems[0]), '报的是「挤在底部」而不是单色占比');
}

console.log('== 7. generateArt（mock 上游，不发真网络请求）==');
{
  const good = [
    '标题：雨里的猫',
    '# ' + '6'.repeat(24) + '0'.repeat(40),
    ...Array.from({ length: 10 }, () => '# ' + '7'.repeat(40) + '4'.repeat(24)),
    ...Array.from({ length: 21 }, () => '# ' + '4'.repeat(44) + '1'.repeat(20)),
  ].join('\n');
  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: good } }] }) };
  };
  const result = await generateArt({ question: '雨里的猫', width: 64, height: 32, config: { apiKey: 'test-key', baseUrl: 'https://example.test/v1', model: 'mock-model' }, fetchImpl: mockFetch });
  eq(result.frame.width, 64, '帧宽 64');
  eq(result.frame.height, 32, '帧高 32');
  eq(result.frame.pixels.length, 2048, '2048 个像素');
  eq(result.attempts, 1, '一次成功');
  eq(result.title, '雨里的猫', '标题来自模型输出');
  eq(result.stats.lit, 1648, '点亮像素 = 64 + 10×24 + 21×64');
  eq(calls.length, 1, '只调用一次上游');
  eq(calls[0].headers.Authorization, 'Bearer test-key', '带 Bearer 鉴权');
  eq(calls[0].body.model, 'mock-model', '模型名透传');
  eq(calls[0].url, 'https://example.test/v1/chat/completions', 'URL 拼接正确');
}
console.log('== 8. generateArt 重试与错误 ==');
{
  // 第一次给坏格式，第二次给好格式 → 应重试一次并成功
  const good = Array.from({ length: 32 }, (_, y) => '# ' + '7'.repeat(40) + String(y % 4) + '7'.repeat(7) + String((y + 2) % 4) + '7'.repeat(15)).join('\n');
  let n = 0;
  const retryFetch = async () => { n++; const content = n === 1 ? '抱歉我不会画' : good; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }; };
  const r = await generateArt({ question: '紫色方块', width: 64, height: 32, config: { apiKey: 'k', baseUrl: 'https://x.test', model: 'm' }, fetchImpl: retryFetch });
  eq(r.attempts, 2, '失败后重试一次即成功');
  eq(n, 2, '上游被调用两次');

  // 全黑画布也算失败
  let m = 0;
  const blackFetch = async () => { m++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: Array.from({ length: 32 }, () => '# ' + '7'.repeat(64)).join('\n') } }] }) }; };
  let err = null;
  try { await generateArt({ question: '全黑', width: 64, height: 32, config: { apiKey: 'k', baseUrl: 'https://x.test', model: 'm' }, fetchImpl: blackFetch }); } catch (e) { err = e; }
  ok(err && /全黑/.test(err.message), `全黑画布应报错（实际 ${err?.message}）`);
  eq(m, 3, '全黑走满重试次数（1 次 + 2 次重试）');

  // 缺 key
  err = null;
  try { await generateArt({ question: 'x', config: { apiKey: '', baseUrl: 'https://x.test', model: 'm' }, fetchImpl: async () => { throw new Error('不该被调用'); } }); } catch (e) { err = e; }
  eq(err?.message, 'no-api-key', '缺 key 立即报 no-api-key');

  // 空问题
  err = null;
  try { await generateArt({ question: '   ', config: { apiKey: 'k', baseUrl: 'https://x.test', model: 'm' } }); } catch (e) { err = e; }
  eq(err?.message, 'question-required', '空问题报 question-required');

  // 上游 500
  err = null;
  try { await generateArt({ question: 'x', width: 64, height: 32, config: { apiKey: 'k', baseUrl: 'https://x.test', model: 'm' }, fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }) }); } catch (e) { err = e; }
  ok(/upstream 500/.test(err?.message || ''), `上游错误要透出状态码（实际 ${err?.message}）`);
}

console.log('== 9. raster 图元栅格化 ==');
{
  // 基本叠加：后面的盖住前面的
  const r1 = rasterizeShapes([{ x: 0, y: 0, w: 4, h: 2, color: 0 }, { x: 1, y: 0, w: 2, h: 1, color: 5 }], 8, 4);
  eq(r1.grid[0].join(''), '05507777', '后画的矩形覆盖先画的，其余保持熄灭(7)');
  eq(r1.grid[1].join(''), '00007777', '第二行只有第一个矩形');
  eq(r1.drawn, 2, '两个图元都被画上');
  eq(r1.skipped, 0, '没有跳过');
  eq(r1.grid.length, 4, '网格高度正确');

  // 越界裁剪：不报错，只画可见部分
  const r2 = rasterizeShapes([{ x: -2, y: -1, w: 5, h: 3, color: 1 }], 8, 4);
  eq(r2.grid[0][0], 1, '负坐标被裁剪后仍画到 (0,0)');
  eq(r2.grid[0].filter((v) => v === 1).length, 3, '可见宽度 3');
  const r3 = rasterizeShapes([{ x: 6, y: 2, w: 10, h: 10, color: 2 }], 8, 4);
  eq(r3.grid[3].filter((v) => v === 2).length, 2, '右下角越界被裁到 2 列');
  eq(r3.grid.length, 4, '越界不改变网格尺寸');

  // 坏图元：色号越界 / 缺字段 / 尺寸 0 都要被跳过而不是抛错
  const r4 = rasterizeShapes([
    { x: 0, y: 0, w: 2, h: 2, color: 9 },      // 色号越界
    { x: 0, y: 0, w: 2, h: 2 },                 // 缺 color
    { x: 0, y: 0, w: 0, h: 2, color: 3 },       // 宽 0
    { x: 0, y: 0, w: 2, h: -1, color: 3 },      // 高负数
    'not-an-object',                             // 根本不是对象
    { x: 1, y: 1, w: 2, h: 2, color: 4 },        // 唯一合法的
  ], 8, 4);
  eq(r4.drawn, 1, '只有 1 个合法图元被画上');
  eq(r4.skipped, 5, '5 个坏图元被跳过');
  eq(r4.grid[1][1], 4, '合法图元画在了正确位置');

  // 完全越界的图元不算画上
  const r5 = rasterizeShapes([{ x: 100, y: 100, w: 4, h: 4, color: 0 }], 8, 4);
  eq(r5.drawn, 0, '完全越界的图元不计入 drawn');

  // 非数组输入
  eq(rasterizeShapes(null, 8, 4).drawn, 0, 'null 输入返回空网格');
  eq(rasterizeShapes([], 8, 4).grid[0].length, 8, '空数组返回全背景网格');
}

console.log('== 10. parseShapeJson 容错 ==');
{
  const good = '{"title":"猫","shapes":[{"x":1,"y":2,"w":3,"h":4,"color":5}]}';
  eq(parseShapeJson(good)?.shapes.length, 1, '纯 JSON 可解析');
  eq(parseShapeJson('```json\n' + good + '\n```')?.title, '猫', '带 ```json 围栏可解析');
  eq(parseShapeJson('好的，我来画：\n' + good + '\n希望你喜欢！')?.shapes.length, 1, '前后有废话也能抠出 JSON');
  eq(parseShapeJson('我画不出来'), null, '没有 JSON 返回 null');
  eq(parseShapeJson('{"title":"空","shapes":[]}')?.shapes.length, 0, 'shapes 为空数组也能解析出来');
  eq(parseShapeJson(''), null, '空串返回 null');
  eq(parseShapeJson('{"a":1}'), null, '没有 shapes 字段返回 null');
}

console.log('== 11. gridToChars / blankGrid ==');
{
  eq(blankGrid(4, 2)[0].join(''), '7777', 'blankGrid 全是熄灭色号');
  eq(gridToChars([[0, 1, 7], [2, 3, 4]]).length, 2, 'gridToChars 行数正确');
  eq(gridToChars([[0, 1, 7], [2, 3, 4]])[0], '017', 'gridToChars 拼成字符串');
}

console.log(`\n${fails.length ? '✗ FAIL' : '✓ PASS'}  ${pass}/${pass + fails.length}`);
if (fails.length) { fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
