/**
 * vision-api —— 「视觉转文字」服务端路由（零依赖）
 *
 *   POST /api/vision
 *     请求（同源 JSON，图片与视频帧走同一个字段，统一处理）：
 *       {
 *         "kind": "image" | "video",
 *         "prompt": "可选，用户需求",
 *         "frames": [ { "dataUrl": "data:image/jpeg;base64,...", "timestamp": 1.23 | null } ]
 *       }
 *       · 图片：frames 1 项，timestamp = null
 *       · 视频：frames 6 项，timestamp = 抽帧后从 video.currentTime 读到的**实际**秒数
 *
 *     响应 200：{ "source": "vision", "kind": "image"|"video", "text": "...", "frameCount": N }
 *     响应 4xx/5xx：{ "error": "<code>", "detail": "..." }
 *        code ∈ bad-json | bad-kind | bad-frames | too-large | no-api-key | bad-base-url
 *              | upstream-<status> | upstream-error | timeout | empty-text | method-not-allowed
 *        · 上游非 2xx 一律映射为本服务 502 + error=upstream-<上游状态码>，detail 为上游原文前 600 字
 *
 *   服务端环境变量：
 *     VISION_API_KEY   必填，缺失时任何请求都回 500 no-api-key
 *     VISION_BASE_URL  可选，默认 https://dashscope.aliyuncs.com/compatible-mode/v1
 *     VISION_MODEL     可选，默认 qwen3-vl-plus
 *     VISION_TIMEOUT_MS 可选，默认 120000
 *
 *   上游调用：OpenAI 兼容 POST {VISION_BASE_URL}/chat/completions，
 *   把 N 张图（base64 data URL）与各自时间戳标注**放在同一次请求**里。
 *
 *   纯函数（buildUpstreamBody / validateVisionRequest / extractVisionText / readVisionConfig）
 *   全部具名导出，便于 Node 单测；handleVision 是唯一的 I/O 入口。
 */

export const VISION_DEFAULTS = {
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen3-vl-plus',
  timeoutMs: 120000,
  maxFrames: 12,
  maxBodyBytes: 32 * 1024 * 1024, // 6 张 1280px PNG dataURL ≈ 4MB，32MB 是宽松上限
  maxPromptChars: 4000,
};

/** data URL 白名单：只收图片，且必须是 base64（前端 canvas 产物一定是这个形状） */
export const DATA_URL_RE = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/;

export const SYSTEM_PROMPT = [
  '你是「视觉转文字」模块：把用户提供的图片或视频帧里的内容忠实转成文字。',
  '只依据画面所见，不要臆测、不要补充画面之外的信息；画面里有的文字尽量一字不漏地转出（保持原有顺序与分段）。',
  '如果用户给了具体需求（例如整理成纪要、提取表格、只找某类信息），按需求组织输出；否则输出画面中的全部文字，必要时再用一句话简述画面。',
  '直接输出结果本身，不要复述这段说明。',
].join('\n');

/* ------------------------------------------------------------------ 配置 */

export function readVisionConfig(env = process.env) {
  const baseUrl = String(env.VISION_BASE_URL || '').trim() || VISION_DEFAULTS.baseUrl;
  const model = String(env.VISION_MODEL || '').trim() || VISION_DEFAULTS.model;
  const timeoutMs = Number(env.VISION_TIMEOUT_MS) > 0 ? Number(env.VISION_TIMEOUT_MS) : VISION_DEFAULTS.timeoutMs;
  return {
    apiKey: String(env.VISION_API_KEY || '').trim(),
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    timeoutMs,
  };
}

/** 允许 BASE 直接给到 /chat/completions（省得有人多填一层），否则补上 */
export function upstreamUrl(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

/* ------------------------------------------------------ 请求校验（纯函数） */

function bad(status, error, detail) {
  return { ok: false, status, error, detail };
}

/**
 * 校验页面发来的请求体。
 * 宽容处：图片帧的 timestamp 一律规范化为 null；超长 prompt 截断而不是报错。
 * 严格处：kind / frames 数量 / dataUrl 前缀与 base64、视频帧 timestamp 必须是有限非负数。
 */
export function validateVisionRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return bad(400, 'bad-json', '请求体必须是 JSON 对象');
  }
  const kind = body.kind;
  if (kind !== 'image' && kind !== 'video') {
    return bad(400, 'bad-kind', `kind 必须是 "image" 或 "video"，收到 ${JSON.stringify(kind)}`);
  }
  const framesIn = body.frames;
  if (!Array.isArray(framesIn) || framesIn.length === 0) {
    return bad(400, 'bad-frames', 'frames 必须是非空数组（图片 1 项、视频 6 项）');
  }
  if (framesIn.length > VISION_DEFAULTS.maxFrames) {
    return bad(400, 'bad-frames', `frames 最多 ${VISION_DEFAULTS.maxFrames} 项，收到 ${framesIn.length} 项`);
  }
  const frames = [];
  for (let i = 0; i < framesIn.length; i++) {
    const f = framesIn[i];
    if (!f || typeof f !== 'object') return bad(400, 'bad-frames', `frames[${i}] 不是对象`);
    if (typeof f.dataUrl !== 'string' || !DATA_URL_RE.test(f.dataUrl.trim())) {
      return bad(400, 'bad-frames', `frames[${i}].dataUrl 必须是 data:image/<png|jpeg|jpg|webp|gif>;base64,... 形式`);
    }
    let timestamp = null;
    if (kind === 'video') {
      timestamp = typeof f.timestamp === 'number' ? f.timestamp : NaN;
      if (!Number.isFinite(timestamp) || timestamp < 0) {
        return bad(400, 'bad-frames', `frames[${i}].timestamp 必须是 ≥0 的有限秒数（视频帧需要真实时间戳）`);
      }
    }
    frames.push({ dataUrl: f.dataUrl.trim(), timestamp });
  }
  let prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (prompt.length > VISION_DEFAULTS.maxPromptChars) prompt = prompt.slice(0, VISION_DEFAULTS.maxPromptChars);
  return { ok: true, kind, prompt, frames };
}

/* ------------------------------------------------------ 上游请求（纯函数） */

/**
 * 组装 OpenAI 兼容的一次性多图请求体：
 * 开头一段文字给出帧数与全部时间戳，之后逐帧「时间戳标注 + 图片」交替排列，
 * 这样模型既能看到整体时序，也能把每个标注对准它前面那张图。
 */
export function buildUpstreamBody({ kind, prompt, frames, model }) {
  const isVideo = kind === 'video';
  const head = [];
  if (isVideo) {
    const stamps = frames.map((f) => Number(f.timestamp).toFixed(2)).join(' / ');
    head.push(`以下是一次视频抽帧结果，共 ${frames.length} 帧，已按时间顺序排列。每帧的实际时间戳（秒）：${stamps}`);
  } else {
    head.push(`以下是 ${frames.length} 张图片，已按顺序排列。`);
  }
  if (prompt) head.push(`用户需求：${prompt}`);

  const content = [{ type: 'text', text: head.join('\n') }];
  frames.forEach((f, i) => {
    const label = isVideo
      ? `[第 ${i + 1} 帧 · 时间戳 ${Number(f.timestamp).toFixed(2)}s]`
      : `[第 ${i + 1} 张图]`;
    content.push({ type: 'text', text: label });
    content.push({ type: 'image_url', image_url: { url: f.dataUrl } });
  });

  return {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content },
    ],
    temperature: 0.2,
    stream: false,
  };
}

/** 从 OpenAI 兼容响应里取出正文（content 可能是字符串，也可能是 parts 数组） */
export function extractVisionText(json) {
  const choice = json?.choices?.[0];
  let c = choice?.message?.content ?? choice?.text ?? '';
  if (Array.isArray(c)) {
    c = c
      .map((p) => (typeof p === 'string' ? p : p?.text ?? ''))
      .join('');
  }
  return String(c ?? '').trim();
}

/* ------------------------------------------------------------ 路由处理 */

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        overflow = true; // 继续把请求体排干，好让客户端能收到 413（而不是连接被重置）
        return;
      }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (overflow) {
        const err = new Error(`请求体超过 ${limit} 字节上限`);
        err.code = 'too-large';
        return reject(err);
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

/**
 * POST /api/vision 的完整处理。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ json: Function, fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv }} deps
 */
export async function handleVision(req, res, { json, fetchImpl = fetch, env = process.env } = {}) {
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'method-not-allowed', detail: 'POST /api/vision' });
  }

  let raw;
  try {
    raw = await readBody(req, VISION_DEFAULTS.maxBodyBytes);
  } catch (err) {
    const tooLarge = err?.code === 'too-large';
    return json(res, tooLarge ? 413 : 400, {
      error: tooLarge ? 'too-large' : 'bad-json',
      detail: String(err?.message || err),
    });
  }

  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return json(res, 400, { error: 'bad-json', detail: `请求体不是合法 JSON（${raw.length} 字节）` });
  }

  const v = validateVisionRequest(body);
  if (!v.ok) return json(res, v.status, { error: v.error, detail: v.detail });

  const cfg = readVisionConfig(env);
  if (!cfg.apiKey) {
    return json(res, 500, {
      error: 'no-api-key',
      detail: '服务端未配置 VISION_API_KEY，请用环境变量启动：VISION_API_KEY=... node server.mjs',
    });
  }
  if (!/^https?:\/\//i.test(cfg.baseUrl)) {
    return json(res, 500, { error: 'bad-base-url', detail: `VISION_BASE_URL 必须是 http(s) 地址，收到 ${cfg.baseUrl}` });
  }

  const url = upstreamUrl(cfg.baseUrl);
  const upstreamBody = buildUpstreamBody({ kind: v.kind, prompt: v.prompt, frames: v.frames, model: cfg.model });

  let up;
  try {
    up = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return json(res, timedOut ? 504 : 502, {
      error: timedOut ? 'timeout' : 'upstream-error',
      detail: `${timedOut ? `上游超时（>${cfg.timeoutMs}ms）` : '上游请求失败'}：${String(err?.message || err)}`,
      upstream: url,
    });
  }

  let text;
  try {
    text = await up.text();
  } catch (err) {
    return json(res, 502, { error: 'upstream-error', detail: `读取上游响应失败：${String(err?.message || err)}`, upstream: url });
  }

  if (!up.ok) {
    return json(res, 502, {
      error: `upstream-${up.status}`,
      detail: (text || '(空响应体)').slice(0, 600),
      upstream: url,
      model: cfg.model,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json(res, 502, { error: 'upstream-error', detail: `上游返回的不是 JSON：${text.slice(0, 300)}`, upstream: url });
  }

  const out = extractVisionText(parsed);
  if (!out) {
    return json(res, 502, { error: 'empty-text', detail: '上游返回了空文本（可能是图片里没有可识别的内容）', model: cfg.model });
  }

  return json(res, 200, { source: 'vision', kind: v.kind, text: out, frameCount: v.frames.length });
}
