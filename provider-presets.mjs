/**
 * 供应商预设：一个开关决定「中枢 / 视觉 / 作画 / 转写」四条链分别用谁。
 *
 *   HUB_PROVIDER=gemini   → 四条链全走 Gemini（OpenAI 兼容端点，充钱即通）
 *   HUB_PROVIDER=deepseek → 中枢与作画走 DeepSeek；视觉/转写需另配（DeepSeek 无视觉）
 *   不设                   → 默认 gemini
 *
 * 显式环境变量永远优先于预设：设了 HUB_API_KEY / VISION_BASE_URL / ART_MODEL 等，
 * 就用你设的，不会被预设覆盖。
 *
 * Gemini 的 OpenAI 兼容端点是 /v1beta/openai；模型名会随账号可用性漂移，
 * 所以可用 HUB_GEMINI_MODEL / VISION_MODEL 覆盖（2026-10-11 实测可用：gemini-flash-latest）。
 */

export const PROVIDER_PRESETS = Object.freeze({
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-flash-latest',
    visionModel: 'gemini-flash-latest',
    visionBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: ['HUB_API_KEY', 'VISION_API_KEY', 'GEMINI_API_KEY', 'ART_API_KEY'],
    transcribeBaseUrl: null, // Gemini 的 OpenAI 兼容层暂无 /audio/transcriptions；音频走浏览器原生识别
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    visionModel: null, // 没有视觉
    visionBaseUrl: null,
    keyEnv: ['HUB_API_KEY', 'ART_API_KEY', 'DEEPSEEK_API_KEY'],
    transcribeBaseUrl: null,
  },
  dashscope: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    visionModel: 'qwen3-vl-plus',
    visionBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyEnv: ['HUB_API_KEY', 'VISION_API_KEY'],
    transcribeBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
});

export const DEFAULT_PROVIDER = 'gemini';

/** 当前生效的预设。 */
export function activePreset(env = process.env) {
  const name = String(env.HUB_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase();
  return { name, preset: PROVIDER_PRESETS[name] || PROVIDER_PRESETS[DEFAULT_PROVIDER] };
}

/**
 * 从 DSH 凭据文件里取某个 key（本机开发便利；VOICEWEB_NO_DSH_CREDENTIALS=1 可关）。
 * @param {string[]} names 候选变量名，按优先级
 * @param {(file:string)=>string} readFile 注入的文件读取器（纯 ESM，不 require）
 */
export function dshCredential(names, env = process.env, readFile = null) {
  if (!readFile) return null;
  if (env.VOICEWEB_NO_DSH_CREDENTIALS === '1') return null;
  const { homedir } = { homedir: () => env.HOME || '' };
  const paths = [env.DSH_CREDENTIALS, `${homedir()}/.dsh/.credentials.yaml`, '/home/Asheep233/.dsh/.credentials.yaml'].filter(Boolean);
  for (const file of paths) {
    let text;
    try { text = readFile(file); } catch { continue; }
    for (const name of names) {
      const m = text.match(new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, 'm'));
      if (m) return { value: m[1], source: `${file}#${name}` };
    }
  }
  return null;
}

/**
 * 解析「中枢」的 baseUrl / model / apiKey，显式 env 优先，其次预设，最后 DSH 凭据。
 * @returns {{provider:string, baseUrl:string, model:string, apiKey:string, keySource:string|null, visionModel:string|null, transcribeBaseUrl:string|null}}
 */
export function resolveEngine(env = process.env, readFile = null) {
  const { name, preset } = activePreset(env);
  const pick = (explicit, fallback) => (explicit && String(explicit).trim()) || fallback;
  // 注意：**不能用 VISION_BASE_URL 推导中枢地址** —— 视觉可以在另一个厂商/另一个 mock 端点，
  // 一旦把它写进中枢的 baseUrl，中枢的 chat/completions 就会打到视觉端点上（实测踩过这个坑）。
  const baseUrl = pick(env.HUB_BASE_URL, pick(env.ART_BASE_URL, preset.baseUrl));
  const model = pick(env.HUB_MODEL, pick(env.ART_MODEL, preset.model));
  let apiKey = pick(env.HUB_API_KEY, env.ART_API_KEY);
  let keySource = apiKey ? 'env' : null;
  if (!apiKey) {
    const found = dshCredential(preset.keyEnv, env, readFile);
    if (found) { apiKey = found.value; keySource = found.source; }
  }
  return {
    provider: name,
    baseUrl,
    model,
    apiKey,
    keySource,
    visionModel: pick(env.VISION_MODEL, preset.visionModel),
    visionBaseUrl: pick(env.VISION_BASE_URL, preset.visionBaseUrl),
    transcribeBaseUrl: pick(env.HUB_TRANSCRIBE_BASE_URL, preset.transcribeBaseUrl),
  };
}
