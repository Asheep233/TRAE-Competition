// 真上游冒烟测试（会消耗真实 API 配额，默认不在 npm test 里跑）：
// 用真 DeepSeek 上游，跑 N 个问题，统计「一次成功 / 重试后成功 / 失败」并打印画面。
//   node test/real-llm.test.mjs
//   VG_REAL_N=5 node test/real-llm.test.mjs
//
// 判据：至少 70% 的请求最终拿到合法画布（否则提示词/闸门需要调）。
import { readFileSync } from 'node:fs';
import { generateArt, readLlmConfig } from '../llm-art.mjs';

function keyFromDshCredentials() {
  for (const file of [`${process.env.HOME}/.dsh/.credentials.yaml`, '/home/Asheep233/.dsh/.credentials.yaml']) {
    try {
      const m = readFileSync(file, 'utf8').match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m);
      if (m) return m[1];
    } catch { /* 下一个候选 */ }
  }
  return '';
}

const cfg = readLlmConfig();
if (!cfg.apiKey) cfg.apiKey = keyFromDshCredentials();
if (!cfg.apiKey) { console.log('✗ 没有可用的 LLM_API_KEY / DEEPSEEK_API_KEY，跳过'); process.exit(1); }

const N = Number(process.env.VG_REAL_N || 3);
const QUESTIONS = ['夜晚城市天际线', '一只在雨里淋湿的猫', '生日蛋糕上的蜡烛', '戴耳机听音乐的熊猫', '海面上的灯塔'];
const picked = QUESTIONS.slice(0, N);

console.log(`上游 ${cfg.baseUrl} · 模型 ${cfg.model} · 问题数 ${picked.length}\n`);

let okCount = 0, retried = 0, failCount = 0;
const timings = [];

for (const question of picked) {
  const started = Date.now();
  try {
    const r = await generateArt({ question, width: 64, height: 32, config: cfg, retries: 2 });
    const ms = Date.now() - started;
    timings.push(ms);
    okCount++;
    if (r.attempts > 1) retried++;
    console.log(`✓ ${question}  ${ms}ms  attempts=${r.attempts}  ${JSON.stringify(r.stats)}  《${r.title}》`);
    console.log(r.chars.map((row) => '  ' + row.replace(/7/g, '.')).join('\n'));
    console.log();
  } catch (error) {
    failCount++;
    console.log(`✗ ${question}  ${Date.now() - started}ms  ${error.message}\n`);
  }
}

const rate = Math.round((okCount / picked.length) * 100);
const avg = timings.length ? Math.round(timings.reduce((a, b) => a + b, 0) / timings.length) : 0;
console.log(`结果：成功 ${okCount}/${picked.length}（${rate}%）· 其中重试后成功 ${retried} · 失败 ${failCount} · 平均 ${avg}ms`);
if (rate < 70) { console.log('✗ 成功率低于 70%，需要调提示词或画质闸门'); process.exit(1); }
console.log('✓ 成功率达标');
