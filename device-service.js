/*
 * 橙子旅伴设备边界。先加载此文件，再加载 app.js。
 * 真实设备接入：在 app.js 之前设置 window.DianDianDeviceAdapter。
 * 完整契约见 API.md；默认适配器不会请求蓝牙或访问网络。
 */
(function (global) {
  'use strict';

  const abortError = () => new DOMException('操作已取消', 'AbortError');
  const checkSignal = signal => { if (signal?.aborted) throw signal.reason instanceof Error || signal.reason instanceof DOMException ? signal.reason : abortError(); };
  const delay = (milliseconds, signal) => new Promise((resolve, reject) => {
    checkSignal(signal);
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(signal.reason instanceof Error || signal.reason instanceof DOMException ? signal.reason : abortError()); };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  function createMockAdapter() {
    let connected = false;
    return {
      kind: 'mock',
      label: 'Demo 设备 · 模拟连接',
      async scan({ signal }) {
        await delay(700, signal);
        return [{ id: 'diandian-demo', name: '橙子旅伴 · Demo', description: 'Demo 设备 · 模拟连接' }];
      },
      async connect(device, { signal }) {
        await delay(250, signal);
        connected = true;
        return device;
      },
      async disconnect({ signal }) {
        await delay(100, signal);
        connected = false;
      },
      async sendFrame(frame, { signal, onProgress }) {
        if (!connected) throw new Error('设备已断开，请重新连接');
        for (const progress of [0, 35, 70, 100]) {
          checkSignal(signal);
          onProgress(progress);
          await delay(220, signal);
        }
        return { sentAt: Date.now() };
      },
      async setBrightness(value, { signal }) {
        if (!connected) throw new Error('设备已断开，请重新连接');
        await delay(120, signal);
      },
      async clearDisplay(size, { signal }) {
        if (!connected) throw new Error('设备已断开，请重新连接');
        await delay(220, signal);
        return { sentAt: Date.now() };
      }
    };
  }

  function createService(adapter = global.DianDianDeviceAdapter || createMockAdapter()) {
    const required = ['scan', 'connect', 'disconnect', 'sendFrame', 'setBrightness', 'clearDisplay'];
    for (const method of required) {
      if (typeof adapter[method] !== 'function') throw new TypeError(`设备适配器缺少 ${method} 方法`);
    }
    const listeners = new Set();
    let operation = null;
    let destroyed = false;
    let state = { connected: false, device: null, operation: null, progress: null, error: null };
    const mode = adapter.kind || 'custom';
    const label = adapter.label || '设备已连接';
    const getState = () => ({ ...state, mode, label, busy: operation !== null });
    const publish = patch => {
      state = { ...state, ...patch };
      for (const listener of listeners) listener(getState());
    };
    const validateFrame = frame => {
      if (!frame || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) ||
          frame.width < 8 || frame.width > 256 || frame.height < 8 || frame.height > 128 ||
          frame.format !== 'RGB888' || !Array.isArray(frame.pixels) ||
          frame.pixels.length !== frame.width * frame.height ||
          !frame.pixels.every(pixel => /^#[0-9a-f]{6}$/i.test(pixel))) {
        throw new TypeError('画面必须是宽 8–256、高 8–128 像素、完整的 RGB888 十六进制颜色数组');
      }
      return { ...frame, pixels: frame.pixels.slice() };
    };
    async function run(name, task, { requiresConnection = false, commit } = {}) {
      if (destroyed) throw new Error('设备服务已释放');
      if (operation) {
        const error = new Error('设备正在处理另一个操作，请稍后重试');
        error.name = 'BusyError';
        throw error;
      }
      if (requiresConnection && !state.connected) throw new Error('请先连接设备');
      const controller = new AbortController();
      const current = { name, controller };
      operation = current;
      publish({ operation: name, progress: null, error: null });
      try {
        const result = await task(controller.signal);
        checkSignal(controller.signal);
        if (commit) commit(result);
        return result;
      } catch (error) {
        const failure = controller.signal.aborted ? (controller.signal.reason || abortError()) : error;
        publish({ error: failure.name === 'AbortError' ? null : failure.message || '设备操作失败' });
        throw failure;
      } finally {
        if (operation === current) {
          operation = null;
          publish({ operation: null, progress: null });
        }
      }
    }
    const unsubscribeDevice = typeof adapter.subscribe === 'function' ? adapter.subscribe(event => {
      if (event?.type === 'disconnected') {
        const reason=event.reason || '设备连接已断开';
        operation?.controller.abort(new Error(reason));
        publish({ connected: false, device: null, error: reason });
      }
    }) : null;
    return {
      mode,
      label,
      getState,
      subscribe(listener) {
        listeners.add(listener);
        listener(getState());
        return () => listeners.delete(listener);
      },
      scan() {
        return run('scanning', async signal => {
          const devices = await adapter.scan({ signal });
          if (!Array.isArray(devices) || devices.some(device => !device || typeof device.id !== 'string' || typeof device.name !== 'string')) {
            throw new TypeError('扫描结果必须包含设备 id 和 name');
          }
          return devices;
        });
      },
      connect(device) {
        return run('connecting', signal => adapter.connect(device, { signal }), {
          commit: result => publish({ connected: true, device: result || device })
        });
      },
      disconnect() {
        return run('disconnecting', signal => adapter.disconnect({ signal }), {
          commit: () => publish({ connected: false, device: null })
        });
      },
      sendFrame(frame, onProgress = () => {}) {
        const payload = validateFrame(frame);
        return run('sending', signal => adapter.sendFrame(payload, {
          signal,
          onProgress(value) {
            if (signal.aborted) return;
            const progress = Math.max(0, Math.min(100, Number(value) || 0));
            publish({ progress });
            onProgress(progress);
          }
        }), { requiresConnection: true });
      },
      setBrightness(value) {
        if (!Number.isInteger(value) || value < 10 || value > 100) return Promise.reject(new RangeError('亮度必须是 10–100 之间的整数'));
        return run('brightness', signal => adapter.setBrightness(value, { signal }), { requiresConnection: true });
      },
      clearDisplay(size) {
        validateFrame({ ...size, format: 'RGB888', pixels: Array(size.width * size.height).fill('#000000') });
        return run('clearing', signal => adapter.clearDisplay(size, { signal }), { requiresConnection: true });
      },
      cancel() { operation?.controller.abort(); },
      destroy() {
        destroyed = true;
        operation?.controller.abort();
        if (typeof unsubscribeDevice === 'function') unsubscribeDevice();
        listeners.clear();
      }
    };
  }
  global.DianDianDevice = Object.freeze({ createService, createMockAdapter });
})(window);
