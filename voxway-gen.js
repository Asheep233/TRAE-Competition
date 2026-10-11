// voxway-gen 前端桥：不再调用真实 API，直接载入本地预制的点阵画作。
//
// 输入一句描述 → 按关键词匹配内置的 64×32 点阵作品 → 转成 RGB888 帧写入画布并上屏。
// 未命中关键词时按轮换顺序展示内置作品。全程无网络请求。
//
// 仍需要 app.js 末尾的钩子（window.__voxwayApplyArt）把内部 w/h/pixels/display 写进去；
// 钩子缺失时本模块不会静默假装成功，而是在状态区报错。
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const q = $('vgQuestion');
  const btn = $('vgGenerate');
  const status = $('vgStatus');
  const panel = $('voxwayGen');
  if (!q || !btn || !status || !panel) return;

  const PRESETS = ['一只在雨里淋湿的猫', '生日快乐 蛋糕和蜡烛', '夜晚城市天际线', '警告：前方施工', '带我去地铁站'];

  // 与 app.js 的 COLORS / art-prompt.mjs 的 PALETTE 一致：0 暖黄 1 珊瑚 2 粉红 3 紫 4 蓝 5 薄荷 6 白 7 熄灭
  const W = 64, H = 32, BG = 7;
  const PALETTE = Object.freeze(['#FFD65A', '#FF8068', '#E994B4', '#AE9CEE', '#7CACED', '#75CDA0', '#FFFFFF', '#000000']);

  const rect = (x, y, w, h, c) => [x, y, w, h, c];
  const px = (x, y, c) => [x, y, 1, 1, c];

  // 5×7 英文像素字模（与 app.js 的 font 同风格），signWord 把文字展开成点阵 ops。
  const FONT = {
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    M: ['10001', '11011', '10101', '10001', '10001', '10001', '10001'],
    W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
    U: ['10001', '10001', '10001', '10001', '10001', '10011', '01110'],
    B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
    O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  };
  function signWord(text, x, y, c, s = 1) {
    const ops = [];
    let cx = x;
    for (const ch of text) {
      if (ch !== ' ' && !FONT[ch]) throw new Error(`FONT 缺少字符 "${ch}"`);
      const g = FONT[ch] || FONT[' '];
      for (let r = 0; r < 7; r++) for (let q = 0; q < 5; q++) if (g[r][q] === '1') ops.push(rect(cx + q * s, y + r * s, s, s, c));
      cx += 6 * s;
    }
    return ops;
  }

  const WORKS = [
    {
      title: '雨中猫',
      keys: ['猫', '雨', 'cat', 'rain'],
      text: '本地预制点阵：蓝色雨丝落在暖黄的猫身上，地上一滩水。',
      ops: [
        px(8, 1, 4), px(8, 2, 4), px(20, 4, 4), px(20, 5, 4), px(30, 2, 4), px(30, 3, 4),
        px(42, 3, 4), px(42, 4, 4), px(52, 1, 4), px(52, 2, 4), px(14, 7, 4), px(14, 8, 4),
        px(36, 8, 4), px(36, 9, 4), px(46, 7, 4), px(46, 8, 4), px(26, 9, 4), px(26, 10, 4),
        rect(26, 12, 3, 3, 0), rect(35, 12, 3, 3, 0),
        rect(25, 14, 14, 6, 0),
        px(27, 13, 2), px(36, 13, 2),
        rect(28, 16, 1, 2, 7), rect(35, 16, 1, 2, 7),
        rect(31, 17, 2, 1, 2),
        rect(27, 20, 11, 7, 0),
        rect(38, 22, 2, 5, 0), rect(39, 20, 3, 2, 0),
        rect(18, 28, 28, 1, 4), rect(14, 29, 36, 1, 4), rect(10, 30, 44, 1, 4),
      ],
    },
    {
      title: '生日蛋糕',
      keys: ['蛋糕', '生日', 'cake', 'birthday'],
      text: '本地预制点阵：三支蜡烛的粉色奶油蛋糕，四周撒着彩点。',
      ops: [
        px(6, 3, 2), px(12, 5, 0), px(52, 3, 5), px(58, 7, 2), px(8, 9, 0),
        px(55, 11, 6), px(16, 2, 6), px(46, 5, 0), px(36, 2, 5),
        rect(27, 9, 1, 2, 0), rect(31, 8, 1, 2, 0), rect(35, 9, 1, 2, 0),
        rect(27, 11, 1, 5, 6), rect(31, 10, 1, 6, 6), rect(35, 11, 1, 5, 6),
        rect(21, 16, 22, 3, 2),
        px(24, 17, 6), px(29, 17, 0), px(34, 17, 6), px(39, 17, 0),
        rect(21, 19, 22, 7, 1),
        rect(18, 26, 28, 2, 4),
      ],
    },
    {
      title: '城市天际线',
      keys: ['城市', '天际线', '夜', '楼', '霓虹', 'city', 'skyline', 'night'],
      text: '本地预制点阵：高低错落的楼宇亮着窗灯，右上角一弯月亮。',
      ops: [
        px(6, 3, 6), px(12, 6, 6), px(20, 2, 6), px(30, 5, 6), px(42, 3, 6),
        px(56, 6, 6), px(16, 9, 6), px(36, 8, 6), px(26, 7, 0), px(48, 2, 0),
        rect(50, 4, 5, 4, 0), rect(51, 3, 3, 1, 0), rect(51, 8, 3, 1, 0),
        rect(4, 18, 8, 12, 3), rect(14, 14, 7, 16, 4), rect(23, 20, 9, 10, 1),
        rect(34, 12, 8, 18, 3), rect(44, 17, 6, 13, 4), rect(53, 22, 7, 8, 1),
        px(6, 20, 0), px(6, 21, 0), px(9, 23, 0), px(9, 24, 0), px(6, 26, 0),
        px(16, 16, 0), px(16, 17, 0), px(19, 19, 2), px(19, 20, 2), px(16, 22, 0), px(16, 23, 0), px(19, 25, 0),
        px(25, 22, 0), px(28, 24, 2), px(31, 22, 0),
        px(36, 14, 0), px(36, 15, 0), px(39, 17, 0), px(39, 18, 0), px(36, 21, 2), px(36, 22, 2), px(39, 25, 0),
        px(46, 19, 0), px(46, 20, 0), px(48, 23, 2), px(48, 24, 2),
        px(55, 24, 0), px(57, 26, 0),
      ],
    },
    {
      title: '前方施工',
      keys: ['施工', '警告', '前方', '工地', 'warning', 'construction'],
      text: '本地预制点阵：黄色三角警示牌立在施工挡板后面。',
      ops: [
        rect(30, 4, 4, 2, 0), rect(28, 6, 8, 2, 0), rect(26, 8, 12, 2, 0), rect(24, 10, 16, 2, 0),
        rect(22, 12, 20, 2, 0), rect(20, 14, 24, 2, 0), rect(18, 16, 28, 2, 0),
        rect(29, 10, 6, 5, 7),
        rect(31, 10, 2, 3, 1), rect(31, 14, 2, 1, 1),
        rect(26, 18, 3, 4, 3), rect(35, 18, 3, 4, 3),
        rect(10, 24, 2, 5, 3), rect(52, 24, 2, 5, 3),
        rect(10, 25, 44, 2, 0),
        rect(14, 25, 2, 2, 7), rect(18, 25, 2, 2, 7), rect(22, 25, 2, 2, 7), rect(26, 25, 2, 2, 7),
        rect(30, 25, 2, 2, 7), rect(34, 25, 2, 2, 7), rect(38, 25, 2, 2, 7), rect(42, 25, 2, 2, 7), rect(46, 25, 2, 2, 7),
        rect(0, 30, 64, 1, 5),
      ],
    },
    {
      title: '带我去地铁站',
      keys: ['地铁', '地铁站', '带我去', '想去', 'subway', 'metro'],
      w: 256, h: 128,
      text: '本地预制点阵 · 256×128：上方完整英文站名牌 TAKE ME TO THE / SUBWAY STATION，雨棚下蓝色列车进站，两侧黄边站台与枕木轨道。',
      ops: [
        ...signWord('TAKE ME TO THE', 3, 6, 0, 3),
        ...signWord('SUBWAY STATION', 3, 32, 0, 3),
        rect(0, 56, 256, 6, 3),
        rect(44, 64, 168, 4, 3),
        rect(40, 68, 176, 44, 4),
        rect(112, 70, 32, 6, 0),
        rect(52, 80, 66, 20, 6), rect(138, 80, 66, 20, 6),
        rect(48, 104, 14, 6, 0), rect(194, 104, 14, 6, 0),
        rect(40, 112, 176, 4, 1),
        rect(0, 104, 32, 20, 5), rect(224, 104, 32, 20, 5),
        rect(26, 104, 6, 20, 0), rect(224, 104, 6, 20, 0),
        rect(36, 120, 184, 2, 6), rect(36, 124, 184, 2, 6),
        ...Array.from({ length: 16 }, (_, i) => rect(40 + i * 11, 122, 6, 2, 3)),
        rect(0, 126, 256, 2, 3),
      ],
    },
    {
      title: '笑脸',
      keys: ['笑', '开心', '快乐', 'happy', 'smile', '表情'],
      text: '本地预制点阵：眯眼大笑的黄色表情。',
      ops: [
        rect(22, 6, 20, 4, 0), rect(18, 10, 28, 12, 0), rect(22, 22, 20, 4, 0),
        rect(25, 12, 3, 5, 7), rect(37, 12, 3, 5, 7),
        rect(24, 19, 16, 2, 7), rect(22, 17, 2, 3, 7), rect(40, 17, 2, 3, 7),
      ],
    },
    {
      title: '爱心',
      keys: ['爱', '心', '喜欢', 'heart', 'love'],
      text: '本地预制点阵：一颗带高光的粉色爱心。',
      ops: [
        rect(18, 8, 10, 6, 2), rect(36, 8, 10, 6, 2),
        rect(16, 12, 32, 6, 2), rect(20, 18, 24, 4, 2), rect(24, 22, 16, 3, 2),
        rect(28, 25, 8, 3, 2), rect(30, 28, 4, 2, 2),
        rect(21, 11, 3, 2, 6),
        px(8, 6, 0), px(55, 4, 0), px(6, 22, 6), px(57, 20, 6),
      ],
    },
  ];

  let rotate = 0;

  function setStatus(text, kind) {
    status.textContent = text;
    status.dataset.kind = kind || 'idle';
  }
  function busy(on) {
    btn.disabled = on;
    q.disabled = on;
    panel.setAttribute('aria-busy', String(on));
  }

  function applyFrame(frame) {
    if (typeof window.__voxwayApplyArt !== 'function') {
      throw new Error('app.js 缺少 __voxwayApplyArt 钩子，无法写入屏幕');
    }
    return window.__voxwayApplyArt(frame);
  }

  function renderChars(chars) {
    const box = $('vgAscii');
    if (!box) return;
    box.textContent = chars.join('\n');
  }

  function paintGrid(ops, w = W, h = H) {
    const grid = Array.from({ length: h }, () => Array(w).fill(BG));
    for (const [x, y, w2, h2, c] of ops) {
      for (let yy = y; yy < y + h2; yy++) {
        for (let xx = x; xx < x + w2; xx++) {
          if (yy >= 0 && yy < h && xx >= 0 && xx < w) grid[yy][xx] = c;
        }
      }
    }
    return grid;
  }

  function gridToFrame(grid, w, h) {
    const pixels = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels.push(PALETTE[grid[y][x]]);
    return { width: w, height: h, format: 'RGB888', pixels };
  }

  function gridToChars(grid) {
    return grid.map((row) => `# ${row.join('')}`);
  }

  function describeFrame(frame) {
    const counts = new Map();
    for (const hex of frame.pixels) counts.set(hex, (counts.get(hex) || 0) + 1);
    const lit = frame.pixels.length - (counts.get(PALETTE[7]) || 0);
    return {
      total: frame.pixels.length,
      lit,
      colors: [...counts.keys()].filter((hex) => hex !== PALETTE[7]).length,
      coverage: Math.round((lit / frame.pixels.length) * 100),
    };
  }

  // 关键词命中优先；多个命中取最长关键词；全不命中则轮换一幅。
  function pickWork(question) {
    const text = question.toLowerCase();
    let best = null, bestLen = 0;
    for (const work of WORKS) {
      for (const key of work.keys) {
        if (text.includes(key) && key.length > bestLen) { best = work; bestLen = key.length; }
      }
    }
    return best || WORKS[rotate++ % WORKS.length];
  }

  async function generate() {
    const question = q.value.trim();
    if (!question) { setStatus('先写下你想让屏幕生成什么', 'error'); q.focus(); return; }
    busy(true);
    setStatus('正在载入本地预制点阵…', 'loading');
    const started = Date.now();
    try {
      await new Promise((resolve) => setTimeout(resolve, 220));
      const work = pickWork(question);
      const fw = work.w || W, fh = work.h || H;
      const grid = paintGrid(work.ops, fw, fh);
      const frame = gridToFrame(grid, fw, fh);
      applyFrame(frame);
      renderChars(gridToChars(grid));
      const stats = describeFrame(frame);
      const elapsed = Date.now() - started;
      const summary = `《${work.title}》 · ${fw}×${fh} · 点亮 ${stats.lit}/${stats.total}（${stats.coverage}%） · ${stats.colors} 色 · 本地预制 · ${elapsed}ms`;
      setStatus(summary, 'ok');
      $('vgFeedback').textContent = `${work.text}\n\n— 已放入画布。可切到「像素绘制」微调，再点「确定并发送到屏幕」。`;
      if (typeof window.__voxwayToast === 'function') window.__voxwayToast('画面已生成，确认后发送到屏幕');
    } catch (error) {
      setStatus(`生成失败：${error.message}`, 'error');
      $('vgFeedback').textContent = '本地预制点阵未写入屏幕，画布内容保持原样。';
    } finally {
      busy(false);
    }
  }

  btn.addEventListener('click', generate);
  q.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); generate(); }
  });

  const presetBox = $('vgPresets');
  if (presetBox) {
    PRESETS.forEach((text) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'vg-preset';
      b.textContent = text;
      b.addEventListener('click', () => { q.value = text; q.focus(); });
      presetBox.appendChild(b);
    });
  }
})();
