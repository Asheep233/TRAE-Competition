# 橙子旅伴 voxway · 功能与接口总览

输入一句话 → 服务端 LLM 生成 64×32 彩色点阵画 → 写入画布 → 「确定并发送到屏幕」。

项目由「纯静态前端页面」+「一个可选的最小 Node 服务」组成：不开服务时双击 `index.html` 也能用全部手工创作功能，只是 AI 作画不可用。

---

## 1. 快速开始

| 方式 | 命令 | 说明 |
| --- | --- | --- |
| 静态打开 | 双击 `index.html` | 无需依赖、无网络请求；AI 作画不可用 |
| 本地 HTTP | `python -m http.server 8000` | 访问 `http://localhost:8000` |
| 带 AI 作画 | `node server.mjs`（或 `npm start`） | 默认 `http://127.0.0.1:8799/` |

服务端环境变量：

| 变量 | 必填 | 默认 | 用途 |
| --- | --- | --- | --- |
| `LLM_API_KEY` | AI 作画时必填 | 无 | 上游 LLM 密钥；缺失时生成接口返回 500 `no-api-key` |
| `LLM_BASE_URL` | 否 | `https://api.deepseek.com` | OpenAI 兼容上游地址 |
| `LLM_MODEL` | 否 | `deepseek-chat` | 模型名 |
| `PORT` / `HOST` | 否 | `8799` / `127.0.0.1` | 监听端口与地址 |

`LLM_API_KEY` 未设置时，服务端会回落到 `~/.dsh/.credentials.yaml` 里的 `DEEPSEEK_API_KEY`。

脚本加载顺序（见 [index.html](index.html#L159-L162)）：`device-service.js` → `app.js` → `settings.js` → `voxway-gen.js`。

---

## 2. 功能清单

### 2.1 页面

底部/侧边导航共 4 项：**创作中心**、**我的屏幕**、**使用指南**、**设置**。

### 2.2 创作中心（3 种表达方式）

| 方式 | 能力 |
| --- | --- |
| 快捷表达 | 内置模板，点选即生成 |
| 像素绘制 | 画笔、橡皮、区域填色、笔刷 1/2/3 px、网格、撤销/重做、自定义取色、1×/2×/4× 缩放；聚焦画布后方向键移动光标、空格绘制 |
| 文字消息 | 文本转点阵字形；Enter 生成，空文本与超长有校验 |
| **AI 作画** | 输入一句描述 → 服务端 LLM 作画 → 自动放入画布并上屏，展示标题、ASCII 预览与统计（尺寸 / 点亮像素 / 覆盖率 / 色数 / 尝试次数 / 耗时），可切换「像素绘制」继续微调 |

AI 作画内置 4 条预设：`一只在雨里淋湿的猫`、`生日快乐 蛋糕和蜡烛`、`夜晚城市天际线`、`警告：前方施工`。

### 2.3 我的屏幕

- 模拟亮度调节（10–100，只影响预览，不改变画稿颜色）
- 清空屏幕显示（保留画稿）
- 屏幕尺寸设置：宽 8–256、高 8–128 整数、四个预设；**改尺寸会清空画稿与屏幕内容**
- 大尺寸预览弹窗（当前屏幕内容）

### 2.4 设备操作

扫描 → 连接 → 发送帧（带进度、可取消）→ 断开；未连接时也能清除本地 mock 屏幕。同一时间只允许一个设备操作，并发调用抛 `BusyError`。

### 2.5 设置

界面字号三档：标准（16 px）、大（18 px，默认）、特大（21 px），可恢复默认。仅影响界面文字，不影响点阵画布内字号。

### 2.6 键盘与可访问性

主导航、模板、表单、绘图工具均可键盘访问并有焦点提示；创作方式标签支持方向键 / Home / End；对话框支持 Escape 关闭并恢复焦点；状态更新通过可访问提示区播报；遵循系统「减少动画 / 高对比」偏好。已覆盖 320 / 375 / 390 / 768 px 响应式无横向溢出。

---

## 3. 接口

### 3.1 HTTP 接口（`server.mjs`）

| 方法 | 路径 | 入参 | 成功响应 |
| --- | --- | --- | --- |
| `GET` | `/api/health` | — | `{ ok, model, baseUrl, hasKey }` |
| `POST` | `/api/generate` | `{ question, width=64, height=32 }` | `{ title, text, chars, frame, stats, model, attempts, elapsedMs }` |
| `GET` | `/*`（其余路径） | — | 静态托管项目根目录（带路径穿越防护、`Cache-Control: no-store`） |

错误约定：

| 状态码 | `error` | 触发条件 |
| --- | --- | --- |
| 400 | `bad-request` | 请求体不是合法 JSON |
| 400 | `question-required` | `question` 为空 |
| 405 | `method-not-allowed` | `/api/generate` 非 POST |
| 404 | `not-found` / `unknown-endpoint` | 静态文件不存在 / 未知 `/api/*` |
| 500 | `no-api-key` | 服务端未配置 LLM key |
| 502 | `generate-failed` | 上游报错、超时或输出不合法（`detail` 含原因） |

`POST /api/generate` 示例：

```bash
curl -X POST http://127.0.0.1:8799/api/generate \
  -H "Content-Type: application/json" \
  -d '{"question":"一只在雨里淋湿的猫","width":64,"height":32}'
```

### 3.2 浏览器全局 API

#### `window.DianDianApp`

```js
DianDianApp.device;                 // 设备服务实例
DianDianApp.getFrame();             // 当前画稿副本 { width, height, format:'RGB888', pixels[] }
DianDianApp.setArt(frame);          // 写入画布（voxway-gen.js 走这个入口上屏）
```

另有两个内部钩子：

- `window.__voxwayApplyArt(frame)`：`app.js` 暴露的上屏入口；缺失时 `voxway-gen.js` 会显式报错而非静默假装成功
- `window.__voxwayToast(message)`：轻提示

#### `window.DianDianDevice`（`device-service.js`）

```js
DianDianDevice.createMockAdapter();      // 默认 mock 适配器
DianDianDevice.createService(adapter?);  // 缺省用 window.DianDianDeviceAdapter，再缺省用 mock
```

服务实例方法：

| 成员 | 说明 |
| --- | --- |
| `getState()` | `{ connected, device, operation, progress, error, busy, mode, label }` |
| `subscribe(listener)` | 订阅状态，返回取消订阅函数；订阅时立即回调一次 |
| `scan()` | 扫描设备，返回 `Device[]` |
| `connect(device)` | 连接 |
| `disconnect()` | 断开 |
| `sendFrame(frame, onProgress?)` | 发送帧，`onProgress(0..100)`，需已连接 |
| `setBrightness(value)` | 10–100 整数，需已连接 |
| `clearDisplay({ width, height })` | 清屏，需已连接 |
| `cancel()` | 取消当前操作（走 `AbortController`） |
| `destroy()` | 释放服务、取消操作、注销适配器订阅 |

`operation` 取值：`scanning` / `connecting` / `disconnecting` / `sending` / `brightness` / `clearing` / `null`。
并发调用抛 `BusyError`（`error.name === 'BusyError'`）。失败或取消会保留原画稿与屏幕内容并恢复按钮；发送总耗时以设备确认（`sentAt`）为准。

#### `window.DianDianSettings`（`settings.js`）

```js
DianDianSettings.getPreferences();          // { fontSize: 'standard' | 'large' | 'extra' }
DianDianSettings.setFontSize('extra');      // 立即生效并持久化，返回新偏好
window.addEventListener('diandian:preferenceschange', e => e.detail.fontSize);
```

### 3.3 设备适配器契约

在 `app.js` 之前设置 `window.DianDianDeviceAdapter` 即可接入真实 BLE / HTTP 设备，页面本身不绑定任何协议。必需属性 `kind`、`label`，必需方法 6 个（均返回 Promise，接收 `{ signal }`）：

| 方法 | 输入 | 成功结果 |
| --- | --- | --- |
| `scan({ signal })` | 取消信号 | `Device[]`（可空、可多台） |
| `connect(device, { signal })` | 扫描返回的设备 | 已连接 `Device`（返回空值沿用入参） |
| `disconnect({ signal })` | 取消信号 | 无返回值 |
| `sendFrame(frame, { signal, onProgress })` | 完整画面 + 进度回调 | `{ sentAt }`，**必须等设备确认接收后** resolve |
| `setBrightness(value, { signal })` | 10–100 整数 | 无返回值 |
| `clearDisplay({ width, height }, { signal })` | 屏幕尺寸 | `{ sentAt }` |

可选：`subscribe(listener)`，返回取消订阅函数；检测到意外断开时回调 `{ type: 'disconnected', reason }`，服务会中止当前操作并置为未连接。

设备对象最少包含 `{ id: string, name: string }`，可附加 `description` 及适配器自定义字段。

取消语义：服务用 `AbortSignal` 通知取消，并忽略取消后返回的成功结果；适配器须停止传输、清理资源、以 `AbortError` 拒绝 Promise。硬件不支持回滚时可能已收到部分数据，需由协议层自行保证完整帧提交。

未连接时：mock 适配器仍可清屏以保留演示交互；真实适配器需先连接。

### 3.4 帧格式（RGB888）

```js
{
  width: 64,
  height: 32,
  format: 'RGB888',
  pixels: ['#000000', '#FFD65A', /* 共 width × height 个 */]
}
```

- 宽必须是 8–256、高必须是 8–128 的整数，像素按从左到右、从上到下排列，索引 `y * width + x`
- 每个元素是六位十六进制 RGB，`#000000` 表示熄灭
- 适配器收到的是独立副本；亮度独立传输，不改变像素颜色
- 帧不合法时 `sendFrame` 抛 `TypeError`（长度与 `width × height` 不符、颜色格式错误等）

### 3.5 LLM 模块（`llm-art.mjs`）

导出函数：

| 函数 | 作用 |
| --- | --- |
| `generateArt({ question, width, height, config, fetchImpl, timeoutMs, retries })` | 主入口：请求上游 → 解析 → 校验 → 返回 `{ text, title, chars, frame, stats, attempts }` |
| `readLlmConfig(env)` | 读取 `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` |
| `buildMessages(question, width, height)` | 构造 system + user 提示词 |
| `parseAsciiGrid(text, width, height)` | 从模型输出提取 ASCII 网格行（容忍代码块、"#" 前缀、中文标点） |
| `gridToFrame(grid, width, height)` | 色号网格 → RGB888 帧 |
| `parseTitle(text)` | 提取 `标题：xxx`（≤24 字） |
| `describeFrame(frame)` | `{ total, lit, colors, coverage }` |
| `auditArt(grid, width, height)` | 画质闸门，返回问题列表（空数组 = 通过） |
| `normalizeQuestion(raw, max=500)` | 清洗用户输入 |
| `hexToPaletteIndex(hex)` | 十六进制颜色 → 调色板索引（备用路径，未在提示词启用） |

常量：`PALETTE`（8 色：暖黄 `#FFD65A` / 珊瑚 `#FF8068` / 粉红 `#E994B4` / 紫 `#AE9CEE` / 蓝 `#7CACED` / 薄荷绿 `#75CDA0` / 白 `#FFFFFF` / 熄灭 `#000000`）、`DEFAULTS`。

调用参数：`temperature 0.9`、`max_tokens 4000`、超时 90 s、重试 2 次。

**为什么不让模型直接输出像素数组**：64×32 = 2048 个 hex 字符串会淹没 token 且极易截断。改为「ASCII 画布」——每行 `# ` + 恰好 W 个色号字符（`0–7`），模型擅长对齐字符网格，人类也能直接读懂。

**画质闸门 `auditArt`**：格式合法但画面没法看时也判失败并重试。判据只抓明确不可用的情况，避免误伤合理构图：

- 全黑（无任何点亮像素）
- 非背景色少于 2 种（没有层次）
- 上半屏亮像素不足全图 15%（画面挤在底部）
- 单一非背景色占点亮区域 > 95%（像色块而非图形）

解析或画质失败时，会把模型原输出回填为 assistant 消息并追加纠正指令重新生成。

---

## 4. 存储键

| 键 | 内容 | 说明 |
| --- | --- | --- |
| `diandian-v1` | 画稿、已发送屏幕内容、尺寸、颜色、脏标记、选中项、发送时间、亮度 | 兼容旧版本草稿 |
| `diandian-settings-v1` | `{ fontSize }` | 界面偏好，与草稿解耦 |

连接会话不持久化。浏览器禁用存储时功能仍可用，只是不保留。

---

## 5. 测试

```bash
npm test              # unit + protocol + e2e
npm run test:unit     # test/unit.test.mjs
npm run test:protocol # test/protocol.test.mjs
npm run test:e2e      # test/e2e.mjs
npm run test:real     # test/real-llm.test.mjs（打真实上游）
```

另有 `test/ab-format.mjs`（格式对比）、`test/cdp-driver.mjs`（浏览器驱动）。
[VALIDATION.md](VALIDATION.md) 记录了 19 组 Chromium 浏览器回归全部通过、无 JS 异常；设备服务单测覆盖扫描/连接/传输/进度/并发拒绝/取消/亮度/清屏/断开/非法帧/失败恢复。

---

## 6. 边界与未实现

- 默认只有 **mock 适配器**：不请求蓝牙、不访问网络，`kind: 'mock'` 下连接状态文案为「模拟连接」
- **真实设备未接入**：接入需自行提供适配器实现（UUID、鉴权、编码、分包、校验、超时、重试），并同步替换页面内的演示文案
- 真实硬件、手机实机触控、读屏软件尚未实测；`file://` 打开在当前云环境未验证（项目无模块加载与外部资源，理论可静态使用，已用本地 HTTP 验证）
- 文字使用系统字体，字形随操作系统略有差异
- 本版本仍是演示：不连接真实蓝牙，也不向联系人/紧急服务发送消息

---

## 7. 文件索引

| 文件 | 职责 |
| --- | --- |
| `index.html` | 页面结构、导航、对话框、AI 作画面板 |
| `style.css` | Fluent 风格、响应式布局、字号与可访问性样式 |
| `app.js` | 像素创作、画稿、交互、屏幕显示、设备调用 |
| `device-service.js` | 设备边界：mock 适配器 + 服务（校验、并发、取消、状态订阅） |
| `voxway-gen.js` | AI 作画前端桥：调用 `/api/generate` 并上屏 |
| `settings.js` | 界面字号与偏好接口 |
| `server.mjs` | 最小 Node 服务：静态托管 + `/api/generate` + `/api/health` |
| `llm-art.mjs` | 提示词、解析、画质闸门、上游调用 |
| `API.md` | 设备接入详细契约 |
| `VALIDATION.md` | 验证记录 |
| `README.md` | 使用说明 |
