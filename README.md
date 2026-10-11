# 橙子旅伴 voxway · 点阵屏创作工作空间

为「橙子旅伴」彩色点阵屏头箍（默认 64 × 32 RGB 全彩小屏）配套的创作与演示工具：把想说的话、想表达的情绪，做成点阵画或文字，"点亮"到屏幕上被看见。

界面采用微软 Fluent 风格：浅灰工作空间、蓝色主操作、桌面侧边栏、移动端底部导航，支持界面字号偏好与键盘操作。

## 快速开始

纯静态项目，无需安装依赖：

- **仅手工创作**：双击 `index.html` 打开（语音输入在 `file://` 下可能受浏览器权限限制）。
- **完整功能（AI 链路、语音）**：

```bash
node server.mjs        # 默认 http://127.0.0.1:8799/
```

手机与电脑同一局域网时，访问 `http://电脑局域网IP:8799`。

AI 相关能力（LLM 中枢、服务端作画）需要环境变量 `LLM_API_KEY`（可选 `LLM_BASE_URL` / `LLM_MODEL`），未配置时仅这些链路不可用，其余功能不受影响。

## 功能

### 像素创作
- 快捷表达模板：我迷路了 / 需要帮助 / 谢谢你 / 你好呀
- 像素绘制：画笔、橡皮、区域填色、笔刷 1/2/3 px、网格、撤销/重做、自定义取色、1×/2×/4× 缩放
- 文字消息：字号 12–48 px、细字体（300）；**语音输入**入口（浏览器原生 `SpeechRecognition` 听写进输入框，Chrome / Edge 可用）
- 屏幕尺寸：宽 8–256、高 8–128 整数，四个预设（32×16 / 64×32 / 64×64 / 256×128）；改尺寸会清空画稿与屏幕

### AI 作画（本地预制点阵）
输入一句描述，从内置点阵作品库按关键词匹配生成画面并放入画布，全程无网络请求：

| 作品 | 尺寸 | 触发关键词示例 |
| --- | --- | --- |
| 雨中猫 / 生日蛋糕 / 城市天际线 / 前方施工 / 笑脸 / 爱心 | 64×32 | 猫、雨、蛋糕、城市、施工、笑、爱 |
| 带我去地铁站（TAKE ME TO THE / SUBWAY STATION 英文标语） | 256×128 | 地铁、带我去 |

未命中关键词时轮换展示。内置 5×7 英文像素字模与 `signWord` 缩放助手，可低成本新增作品。

### LLM 中枢（多模态）
`hub-panel` 提供对话入口：文字 + 图片 / 视频 / 音频附件（附件由服务端转写/描述后交给模型），模型可在回复中携带 `[[DRAW: 描述]]` 触发作画链（矩形图元 → ASCII 网格兜底 → 画质闸门），结果同时显示在对话并写入点阵画布。

### 模拟设备
虚拟蓝牙连接流程（扫描、连接橙子旅伴 · Demo）、发送 / 亮度 / 清屏模拟与大预览。页面不请求真实蓝牙权限；草稿与偏好保存在当前浏览器。

## 目录

| 文件 | 职责 |
| --- | --- |
| `index.html` | 页面结构、导航、对话框、AI 作画与中枢面板 |
| `app.js` | 像素创作、画稿、交互、屏幕显示、语音输入 |
| `style.css` | Fluent 风格与响应式布局 |
| `device-service.js` | 设备适配层（默认本地模拟），RGB888 帧协议校验 |
| `settings.js` | 界面字号偏好 |
| `voxway-gen.js` | AI 作画前端：本地预制点阵库与上屏桥 |
| `hub-panel.js` | LLM 中枢对话前端 |
| `server.mjs` | 静态托管 + `/api/hub`、`/api/generate`、`/api/vision` 等 AI 接口 |
| `hub-api.mjs` / `art-prompt.mjs` / `art-raster.mjs` / `llm-art.mjs` / `raster.mjs` / `vision-api.mjs` / `provider-presets.mjs` | 服务端 AI 链（中枢、作画、视觉、转写、供应商预设） |
| `test/` | 单元测试（86 项）、协议测试、CDP 浏览器端到端测试 |

```bash
node test/unit.test.mjs    # 单元
node test/protocol.test.mjs
node test/e2e.mjs          # 需要 Chrome
```

## 集成边界

- `window.DianDianApp`：`getFrame()` 取当前画稿、`setArt(frame)` 写入、`device` 暴露设备服务。
- `window.__voxwayApplyArt(frame)`：外部生成器写入画布的窄钩子（校验 RGB888、宽 8–256 / 高 8–128、逐像素十六进制颜色）。
- `window.DianDianDeviceAdapter`：在 `app.js` 之前注入，可替换为真实 BLE / HTTP 适配器；契约见 [API.md](API.md)。

## 文档

- [README.md](README.md)：使用说明（本文件）
- [OVERVIEW.md](OVERVIEW.md)：架构与功能总览
- [API.md](API.md)：设备适配与帧协议
- [VALIDATION.md](VALIDATION.md)：验证清单

当前版本仍是演示：不会连接真实蓝牙，也不会向联系人或紧急服务发送消息。
