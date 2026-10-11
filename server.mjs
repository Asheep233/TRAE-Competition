// voxway-gen 最小服务：静态托管 voxway-web + 一个让 LLM 作画的接口。
//
//   node server.mjs                 # http://127.0.0.1:8799
//   LLM_API_KEY=... node server.mjs
//   LLM_MODEL=deepseek-chat         # 可选
//   LLM_API_KEY 缺省时从 ~/.dsh/.credentials.yaml 的 DEEPSEEK_API_KEY 兜底读取。
//
// 路由：
//   POST /api/generate  {question, width, height} → {title, text, frame, stats, model, elapsedMs}
//   GET  /api/health                             → {ok, model, hasKey}

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateArt, readLlmConfig, DEFAULTS } from './llm-art.mjs';
import { handleHub, readHubConfig } from './hub-api.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT || 8799);
const HOST = process.env.HOST || '127.0.0.1';

/** LLM_API_KEY 优先；没有则回落到 DSH 凭据文件里的 DEEPSEEK_API_KEY。 */
function resolveConfig(env = process.env) {
  const cfg = readLlmConfig(env);
  if (cfg.apiKey) return cfg;
  for (const file of [join(process.env.HOME || '', '.dsh', '.credentials.yaml'), '/home/Asheep233/.dsh/.credentials.yaml']) {
    try {
      const text = readFileSync(file, 'utf8');
      const m = text.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m);
      if (m) return { ...cfg, apiKey: m[1], keySource: file };
    } catch { /* 下一个候选 */ }
  }
  return cfg;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

const sendJson = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store' });
  res.end(payload);
};

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body-too-large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const target = resolve(ROOT, '.' + pathname);
  if (!target.startsWith(ROOT + sep) && target !== ROOT) { sendJson(res, 403, { error: 'forbidden' }); return; }
  try {
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': MIME[extname(pathname).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'not-found', path: pathname });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/health') {
      const cfg = resolveConfig();
      const hub = readHubConfig(process.env, (file) => readFileSync(file, 'utf8'));
      sendJson(res, 200, {
        ok: true,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        hasKey: Boolean(cfg.apiKey),
        hub: { provider: hub.provider, model: hub.model, baseUrl: hub.baseUrl, hasKey: Boolean(hub.apiKey) },
      });
      return;
    }
    // LLM 中枢（多模态）：文字 + 图片/视频/音频 → 一个 LLM，可对话也可反手作画。
    // 请求体自带 base64 媒体，所以由 handleHub 自己读流（不经过 readBody 的 64KB 上限）。
    if (url.pathname === '/api/hub') {
      await handleHub(req, res, { json: sendJson });
      return;
    }
    if (url.pathname === '/api/generate') {
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method-not-allowed' }); return; }
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (error) {
        sendJson(res, 400, { error: 'bad-request', detail: error.message });
        return;
      }
      const question = String(body?.question ?? '').trim();
      if (!question) { sendJson(res, 400, { error: 'question-required', detail: '请先写下你想让屏幕生成什么' }); return; }
      const width = Number(body?.width ?? 64);
      const height = Number(body?.height ?? 32);
      const cfg = resolveConfig();
      if (!cfg.apiKey) {
        sendJson(res, 500, { error: 'no-api-key', detail: '服务端没有配置 LLM_API_KEY（或 ~/.dsh/.credentials.yaml 里的 DEEPSEEK_API_KEY）' });
        return;
      }
      const started = Date.now();
      try {
        const result = await generateArt({ question, width, height, config: cfg });
        console.log(`[voxway-gen] "${question.slice(0, 40)}" ${width}×${height} → ${result.stats.lit} 点亮像素 / ${result.stats.colors} 色 / ${Date.now() - started}ms / 尝试 ${result.attempts} 次`);
        sendJson(res, 200, {
          title: result.title,
          text: result.text,
          chars: result.chars,
          frame: result.frame,
          stats: result.stats,
          model: cfg.model,
          attempts: result.attempts,
          via: result.via,
          shapes: result.shapes,
          elapsedMs: Date.now() - started,
        });
      } catch (error) {
        const noKey = error?.message === 'no-api-key';
        console.error('[voxway-gen] 生成失败:', error?.message);
        sendJson(res, noKey ? 500 : 502, { error: noKey ? 'no-api-key' : 'generate-failed', detail: error?.message || String(error) });
      }
      return;
    }
    if (url.pathname.startsWith('/api/')) { sendJson(res, 404, { error: 'unknown-endpoint' }); return; }
    await serveStatic(req, res);
  } catch (error) {
    console.error('[voxway-gen] 未捕获错误:', error);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal', detail: String(error?.message || error) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const cfg = resolveConfig();
  console.log(`[voxway-gen] http://${HOST}:${PORT}/`);
  console.log(`[voxway-gen] 上游 ${cfg.baseUrl} · 模型 ${cfg.model} · key ${cfg.apiKey ? '已配置' : '缺失（生成会 500）'}`);
});

export { server, resolveConfig, DEFAULTS };
