// LLM 中枢（多模态）前端：一个对话框收下文字 / 图片 / 视频 / 音频，交给同一个 LLM。
// 它既能回话，也能在需要时反手作画 —— 点阵画会同时显示在对话里、并写入 vg 的点阵画布。
//
// 与 voxway-gen 的浅色 Fluent 体系一致：气泡用 .hub-* 类（见 style.css 末尾），
// 上屏复用 app.js 的 window.__voxwayApplyArt（同 voxway-gen.js 的窄钩子）。
(function () {
  'use strict';

  var HUB_ENDPOINT = '/api/hub';
  var VIDEO_FRAMES = 6;
  var MAX_VIDEO_SECONDS = 30;
  var PALETTE = ['#FFD65A', '#FF8068', '#E994B4', '#AE9CEE', '#7CACED', '#75CDA0', '#FFFFFF', '#000000'];

  var $ = function (id) { return document.getElementById(id); };
  var log = $('hLog');
  var text = $('hText');
  var send = $('hSend');
  var attach = $('hAttach');
  var files = $('hFiles');
  var picker = $('hPicker');
  var mic = $('hMic');
  var status = $('hStatus');
  var reset = $('hReset');
  if (!log || !text || !send) return;

  var history = [];
  var pending = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function setStatus(t, kind) {
    if (!status) return;
    status.textContent = t;
    status.dataset.kind = kind || 'idle';
  }

  function addMsg(role, html) {
    var wrap = document.createElement('div');
    wrap.className = 'hub-msg ' + role;
    wrap.innerHTML = '<div class="hub-who">' + (role === 'user' ? '你' : 'LLM 中枢') + '</div><div class="hub-body">' + html + '</div>';
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
    return wrap;
  }

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(new Error('读取文件失败')); };
      r.readAsDataURL(file);
    });
  }

  function grabVideoFrames(file) {
    var url = URL.createObjectURL(file);
    var video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    return new Promise(function (resolve, reject) {
      video.onloadedmetadata = resolve;
      video.onerror = function () { reject(new Error('视频无法解码')); };
      setTimeout(function () { reject(new Error('视频元数据超时')); }, 15000);
    }).then(function () {
      var duration = Math.min(Number(video.duration) || 0, MAX_VIDEO_SECONDS);
      if (!duration) throw new Error('视频时长为 0 或无法读取');
      var out = [];
      var chain = Promise.resolve();
      for (var i = 0; i < VIDEO_FRAMES; i++) {
        (function (index) {
          chain = chain.then(function () {
            var t = Math.min(duration * (VIDEO_FRAMES === 1 ? 0 : index / (VIDEO_FRAMES - 1)), Math.max(0, duration - 0.05));
            return new Promise(function (res) {
              video.onseeked = res;
              video.onerror = res;
              video.currentTime = t;
              setTimeout(res, 4000);
            }).then(function () {
              var canvas = document.createElement('canvas');
              var scale = Math.min(1, 640 / (video.videoWidth || 640));
              canvas.width = Math.max(1, Math.round((video.videoWidth || 640) * scale));
              canvas.height = Math.max(1, Math.round((video.videoHeight || 360) * scale));
              canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
              out.push({ dataUrl: canvas.toDataURL('image/jpeg', 0.82), timestamp: Number(video.currentTime.toFixed(2)) });
            });
          });
        })(i);
      }
      return chain.then(function () { return out; });
    }).then(function (out) {
      URL.revokeObjectURL(url);
      return out;
    }, function (error) {
      URL.revokeObjectURL(url);
      throw error;
    });
  }

  function buildMedia(list) {
    var media = [];
    var chain = Promise.resolve();
    Array.prototype.forEach.call(list, function (file) {
      chain = chain.then(function () {
        var type = String(file.type || '');
        if (type.indexOf('image/') === 0) {
          setStatus('正在处理图片 ' + file.name + '…');
          return readAsDataUrl(file).then(function (dataUrl) { media.push({ kind: 'image', dataUrl: dataUrl, name: file.name }); });
        }
        if (type.indexOf('video/') === 0) {
          setStatus('正在为 ' + file.name + ' 抽帧…');
          return grabVideoFrames(file).then(function (frames) {
            frames.forEach(function (f) { media.push({ kind: 'video', dataUrl: f.dataUrl, timestamp: f.timestamp, name: file.name }); });
          });
        }
        if (type.indexOf('audio/') === 0) {
          setStatus('正在读取音频 ' + file.name + '…');
          return readAsDataUrl(file).then(function (dataUrl) { media.push({ kind: 'audio', dataUrl: dataUrl, name: file.name }); });
        }
        throw new Error('不支持的文件类型：' + (type || file.name));
      });
    });
    return chain.then(function () { return media; });
  }

  var ICONS = { image: '🖼', video: '🎬', audio: '🎵' };

  function renderPending() {
    if (!attach) return;
    if (!pending.length) {
      attach.innerHTML = '<span class="hub-dim">还没有附件 · 可直接发文字，或点下方按钮加图片 / 视频 / 音频</span>';
      return;
    }
    attach.innerHTML = pending.map(function (m, i) {
      return '<span class="hub-badge">' + (ICONS[m.kind] || '📎') + ' ' + esc(m.name || m.kind) +
        (m.timestamp != null ? ' @' + m.timestamp + 's' : '') +
        ' <button type="button" data-drop="' + i + '" title="移除" aria-label="移除附件">×</button></span>';
    }).join('');
    attach.querySelectorAll('[data-drop]').forEach(function (b) {
      b.addEventListener('click', function () {
        pending.splice(Number(b.dataset.drop), 1);
        renderPending();
      });
    });
  }

  /** 把点阵帧画进对话里的 canvas（沿用设备屏的深底 + 圆形灯珠观感）。 */
  function paintFrame(canvas, frame) {
    if (!canvas || !frame) return 0;
    var width = frame.width;
    var height = frame.height;
    var pixels = frame.pixels;
    var box = canvas.parentElement ? canvas.parentElement.clientWidth || 640 : 640;
    var size = Math.max(4, Math.min(12, Math.floor((box - 24) / width)));
    canvas.width = width * size;
    canvas.height = height * size;
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#101828';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#1c2534';
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        ctx.beginPath();
        ctx.arc(x * size + size / 2, y * size + size / 2, size * 0.31, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    var lit = 0;
    for (var yy = 0; yy < height; yy++) {
      for (var xx = 0; xx < width; xx++) {
        var color = pixels[yy * width + xx] || '#000000';
        if (String(color).toLowerCase() === '#000000') continue;
        lit++;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(xx * size + size / 2, yy * size + size / 2, size * 0.31, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    return lit;
  }

  function busy(on) {
    send.disabled = on;
    text.disabled = on;
    if (picker) picker.disabled = on;
  }

  function sendTurn() {
    var value = String(text.value || '').trim();
    if (!value && !pending.length) { setStatus('说点什么，或加一个附件', 'error'); return; }
    var media = pending;
    busy(true);
    setStatus('中枢正在处理…', 'loading');

    var label = esc(value || '(只有附件)');
    if (media.length) {
      label += '<div class="hub-dim">附件 ' + media.length + ' 项（' + Array.from(new Set(media.map(function (m) { return m.kind; }))).join('/') + '）</div>';
    }
    addMsg('user', label);
    text.value = '';
    pending = [];
    renderPending();

    var size = (window.DianDianApp && window.DianDianApp.getFrame && window.DianDianApp.getFrame()) || { width: 64, height: 32 };

    fetch(HUB_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: value, media: media, messages: history, width: size.width, height: size.height }),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.detail || data.error || ('HTTP ' + res.status));
        return data;
      });
    }).then(function (data) {
      var parts = [];
      if (data.extractions && data.extractions.length) {
        parts.push('<div class="hub-dim">附件转写：' + data.extractions.map(function (e) {
          return e.kind + (e.frames > 1 ? ' · ' + e.frames + ' 帧' : '');
        }).join('、') + '</div>');
        data.extractions.forEach(function (e) {
          parts.push('<details class="hub-detail"><summary>查看' + e.kind + '转写</summary><div class="hub-pre">' + esc(e.text) + '</div></details>');
        });
      }
      parts.push('<div class="hub-text">' + esc(data.reply) + '</div>');

      var wrap = addMsg('assistant', parts.join(''));

      if (data.art && !data.art.error) {
        var box = document.createElement('div');
        box.className = 'hub-art-box';
        var canvas = document.createElement('canvas');
        canvas.setAttribute('aria-label', '中枢画出的点阵画面');
        box.appendChild(canvas);
        var cap = document.createElement('div');
        cap.className = 'hub-dim hub-art-cap';
        cap.textContent = '《' + data.art.title + '》 ' + data.art.frame.width + '×' + data.art.frame.height +
          ' · 点亮 ' + data.art.stats.lit + '/' + data.art.stats.total + '（' + data.art.stats.coverage + '%）· ' + data.art.stats.colors + ' 色 · 已放进画布';
        box.appendChild(cap);
        wrap.querySelector('.hub-body').appendChild(box);
        paintFrame(canvas, data.art.frame);
        // 落到点阵画布（并可继续手工微调）
        try {
          if (typeof window.__voxwayApplyArt === 'function') window.__voxwayApplyArt(data.art.frame);
        } catch (error) {
          cap.textContent += ' · 上屏失败：' + error.message;
        }
        if (typeof window.__voxwayToast === 'function') window.__voxwayToast('中枢已作画，画面已放入点阵画布');
      } else if (data.art && data.art.error) {
        var err = document.createElement('div');
        err.className = 'hub-art-err';
        err.textContent = '作画失败：' + data.art.error;
        wrap.querySelector('.hub-body').appendChild(err);
      }

      log.scrollTop = log.scrollHeight;
      history.push({ role: 'user', content: value || ('(附件 ' + media.length + ' 项)') });
      history.push({ role: 'assistant', content: data.reply });
      while (history.length > 20) history.shift();
      setStatus('完成 · ' + data.elapsedMs + 'ms · ' + (data.model || '') + (data.art && !data.art.error ? ' · 已作画' : ''), 'ok');
    }).catch(function (error) {
      addMsg('assistant', '<span class="hub-err">出错了：' + esc(error.message) + '</span>');
      setStatus('失败：' + error.message + '（服务端需配 HUB_API_KEY / GEMINI_API_KEY）', 'error');
    }).then(function () {
      busy(false);
      text.focus();
    });
  }

  send.addEventListener('click', sendTurn);
  text.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTurn(); }
  });

  if (picker && files) {
    picker.addEventListener('click', function () { files.click(); });
    files.addEventListener('change', function () {
      var list = Array.prototype.slice.call(files.files || []);
      files.value = '';
      if (!list.length) return;
      setStatus('正在读取附件…');
      buildMedia(list).then(function (media) {
        pending = pending.concat(media);
        renderPending();
        setStatus('已加入 ' + media.length + ' 项附件', 'ok');
      }).catch(function (error) {
        setStatus(error.message, 'error');
      });
    });
  }

  // 说话：浏览器原生语音识别（免 Key），识别结果落进输入框，走中枢同一条链路。
  if (mic && text) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      mic.disabled = true;
      mic.title = '这个浏览器不支持原生语音识别（建议 Chrome / Edge）';
    } else {
      var on = false;
      var rec = null;
      mic.addEventListener('click', function () {
        if (on) { try { rec.stop(); } catch (e) { /* 已停止 */ } return; }
        rec = new SR();
        rec.lang = 'zh-CN';
        rec.interimResults = true;
        rec.continuous = false;
        var base = text.value ? text.value.replace(/\s*$/, '') + ' ' : '';
        rec.onresult = function (e) {
          var interim = '';
          var final = '';
          for (var i = e.resultIndex; i < e.results.length; i++) {
            var t = e.results[i][0].transcript;
            if (e.results[i].isFinal) final += t; else interim += t;
          }
          text.value = base + final + interim;
          if (interim) setStatus('正在听…');
        };
        rec.onerror = function (e) {
          on = false;
          mic.classList.remove('on');
          setStatus('语音识别出错：' + (e.error || '未知'), 'error');
        };
        rec.onend = function () {
          on = false;
          mic.classList.remove('on');
          var v = text.value.trim();
          setStatus(v ? '识别完成，按发送交给中枢' : '没有听到内容', v ? 'ok' : 'idle');
          text.focus();
        };
        try {
          rec.start();
          on = true;
          mic.classList.add('on');
          setStatus('正在听…（再点一次结束）');
        } catch (error) {
          setStatus('无法启动语音识别：' + error.message, 'error');
        }
      });
    }
  }

  if (reset) {
    reset.addEventListener('click', function () {
      history.length = 0;
      pending = [];
      renderPending();
      log.innerHTML = '';
      addMsg('assistant', '新的对话开始了。发文字、图片、视频或音频都行；想要画面就直接说「画一个…」。');
      setStatus('');
    });
  }

  renderPending();
  addMsg('assistant', '我是这个页面的 <b>LLM 中枢</b>：可以聊天，也可以把图片 / 视频 / 音频丢给我（我会先转成文字再理解）。想要画面就说一句「画一个……」，我会画好并直接放进左边的点阵画布。');

  window.__voxwayHub = { send: sendTurn, buildMedia: buildMedia, paintFrame: paintFrame, PALETTE: PALETTE };
})();
