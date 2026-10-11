# 设备接口接入

页面默认使用本地异步模拟设备，保留双击 `index.html` 直接运行的方式。扫描、连接、发送、断开、亮度调整和清屏已经通过同一套设备服务调用，页面没有绑定网络地址或蓝牙协议。

## 脚本顺序

```html
<script src="device-service.js"></script>
<!-- 实际接入时在此加载你的适配器，设置 window.DianDianDeviceAdapter -->
<script src="your-device-adapter.js"></script>
<script src="app.js"></script>
<script src="settings.js"></script>
```

默认演示无需 `your-device-adapter.js`。真实设备的 UUID、鉴权、编码、分包、校验、超时和重试应在适配器内实现。浏览器蓝牙通常需要 HTTPS/localhost 和用户触发，前端界面不假定具体设备协议。

## 适配器契约

在 `app.js` 执行前设置 `window.DianDianDeviceAdapter`。以下六个方法必需，均返回 Promise。

| 属性 / 方法 | 输入 | 成功结果 |
| --- | --- | --- |
| `kind` | `'mock'`、`'ble'`、`'http'` 或自定义类型 | 除 `'mock'` 外，连接 / 发送状态文案切换为实际设备 |
| `label` | 连接说明字符串 | 无设备独立说明时显示此文案 |
| `scan({ signal })` | 取消信号 | `Device[]`，允许空数组和多台设备 |
| `connect(device, { signal })` | 扫描返回的设备 | 已连接的 `Device`；返回空值则沿用输入 |
| `disconnect({ signal })` | 取消信号 | 无返回值 |
| `sendFrame(frame, { signal, onProgress })` | 完整画面及进度回调 | `{ sentAt?: number }`，仅设备确认接收成功后 resolve |
| `setBrightness(value, { signal })` | 10–100 的整数百分比 | 无返回值 |
| `clearDisplay({ width, height }, { signal })` | 当前屏幕尺寸 | `{ sentAt?: number }` |
| `subscribe(listener)`（可选） | 设备事件回调 | 取消订阅函数 |

设备对象最少包含 `{ id: string, name: string }`，可包含 `description` 和适配器自己需要的字段。界面通过 `textContent` 渲染设备名称。

```js
// your-device-adapter.js
window.DianDianDeviceAdapter = {
  kind: 'http',
  label: '橙子旅伴设备服务',
  async scan({ signal }) { /* 返回真实 Device[] */ },
  async connect(device, { signal }) { /* 建立连接，返回 Device */ },
  async disconnect({ signal }) { /* 释放连接 */ },
  async sendFrame(frame, { signal, onProgress }) {
    // 编码、传输；按真实进度调用 onProgress(0..100)。
    // 等设备确认后返回 { sentAt: Date.now() }。
  },
  async setBrightness(value, { signal }) { /* 设置亮度 */ },
  async clearDisplay(size, { signal }) { /* 清屏并等待确认 */ },
  subscribe(listener) {
    // 检测意外断开时：
    // listener({ type: 'disconnected', reason: '设备连接已断开' });
    return () => { /* 注销监听 */ };
  }
};
```

上面的代码是契约示意，接入时必须补充实际实现后加载；不能直接作为可运行适配器使用。

## 帧格式

```js
{
  width: 64,
  height: 32,
  format: 'RGB888',
  pixels: ['#000000', '#FFD65A', /* 共 width × height 个颜色 */]
}
```

宽必须是 8–256、高必须是 8–128 的整数；像素按从左到右、从上到下排列，索引为 `y * width + x`。每个颜色都是六位十六进制 RGB，`#000000` 表示熄灭。适配器收到独立的数组副本，不应修改该副本；亮度独立传输，不改变像素颜色。

## 状态、取消和失败

`window.DianDianApp.device` 是页面正在使用的服务实例，可通过 `getState()` 读取 `{ connected, device, operation, progress, error, busy, mode, label }`，通过 `subscribe(listener)` 监听变化并获得取消订阅函数。`operation` 可能为 `scanning`、`connecting`、`disconnecting`、`sending`、`brightness`、`clearing` 或 `null`。`window.DianDianApp.getFrame()` 返回当前画稿副本。

同一时间只允许一个设备操作；并发调用抛出 `BusyError`。关闭扫描 / 连接弹窗会取消当前操作，发送时再次点击发送按钮会取消传输。服务通过 `AbortSignal` 通知适配器取消，并忽略取消之后返回的成功结果。适配器必须停止传输、清理资源，并用 `AbortError` 拒绝 Promise；如果硬件不支持回滚，实际设备可能已经收到部分数据，因此需由协议层提供确认和完整帧提交机制。

发送和清屏仅在适配器成功后更新屏幕预览。失败或取消保留画稿及之前的屏幕内容，并恢复操作按钮。连接成功后同步当前亮度；快速拖动亮度滑块会合并请求，只发送最近的值。未连接时亮度只影响本地预览。默认 mock 未连接时仍可清除本地屏幕预览，以保留原演示交互；实际适配器清屏需要先连接设备。

草稿继续使用原 `diandian-v1` 存储键，升级后可恢复旧画稿、屏幕、尺寸、颜色、亮度和发送时间；连接会话不保存到浏览器存储。修改分辨率仍清空本地画稿和屏幕预览，真实硬件的分辨率校验由适配器完成。

## 后续接入时的界面文案

状态文案根据 `kind` 自动切换。页面内静态的演示说明（使用指南、模拟连接提示等）在真实设备接入时应同步替换为实际产品说明，避免显示与权限请求不一致的文字。
