/* =============================================================
 * app.js — 澄文扫描台 交互层
 * ============================================================= */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var SOURCE_MAX = 3000;

  var PRESETS = {
    standard: { whitening: 1.0, textDark: 1.05, shadow: 1.0, contrast: 1.0, denoise: 1, sharpen: 0.35 },
    strong: { whitening: 1.3, textDark: 1.22, shadow: 1.25, contrast: 1.3, denoise: 2, sharpen: 0.55 },
    gentle: { whitening: 0.82, textDark: 0.9, shadow: 0.75, contrast: 0.8, denoise: 0.5, sharpen: 0.15 },
    archive: { whitening: 1.06, textDark: 1.12, shadow: 1.15, contrast: 1.05, denoise: 1.5, sharpen: 0.4 }
  };

  var S = {
    pages: [],
    cur: -1,
    mode: 'bleach',
    adjust: false,
    compare: false,
    split: 0.5,
    zoom: 0,          // 0 = 适应窗口
    budget: 150,
    res: 2000,
    pageSize: 'a4',
    busy: false,
    pendingApply: false,
    uuid: 1
  };

  /* ---------------- 工具 ---------------- */

  function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); }

  function fmtSize(bytes) {
    if (!bytes) return '—';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  function thumbCanvas(src, w) {
    var s = w / src.width;
    var c = document.createElement('canvas');
    c.width = w; c.height = Math.round(src.height * s);
    var x = c.getContext('2d');
    x.imageSmoothingQuality = 'medium';
    x.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  // modified：缩略图按"结果画布"缓存。
  // renderRail 在处理每一页后都会重画整条胶片，若不缓存，N 页就是 O(N²) 次
  // JPEG 编码（50 页要重编 1200 多次），批量导入会明显卡顿。
  function thumbUrl(p, w) {
    var src = p.result || rotatedSource(p);
    if (p._thumbSrc === src && p._thumbW === w && p._thumbUrl) return p._thumbUrl;
    p._thumbSrc = src;
    p._thumbW = w;
    p._thumbUrl = thumbCanvas(src, w).toDataURL('image/jpeg', 0.72);
    return p._thumbUrl;
  }

  function toCanvas(res) {
    var c = document.createElement('canvas');
    c.width = res.w; c.height = res.h;
    c.getContext('2d').putImageData(new ImageData(res.data, res.w, res.h), 0, 0);
    return c;
  }

  function download(bytes, filename, mime) {
    var blob = new Blob([bytes], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  /**
   * 保存导出结果，按"能覆盖就覆盖"的顺序降级：
   * ① 有源文件句柄 → createWritable() 写回原路径，真正覆盖源文件；
   * ② 有系统另存对话框 → suggestedName 用源文件名，用户可在源目录里覆盖同名文件；
   * ③ 都没有 → 普通下载（只能落到浏览器下载目录，无法覆盖）。
   * 返回 { mode, name }，mode 为 overwrite / picker / download / cancel。
   */
  async function saveOutput(bytes, filename, mime, srcHandle) {
    var blob = new Blob([bytes], { type: mime });
    // modified：FileSystemWritableFileStream 的 close() 才真正提交文件（MDN：写入先在
    // 临时交换文件里进行）。原实现在 write/close 抛错后既不 abort 也不 close，
    // 可写流悬空、临时文件残留；且失败被静默降级成"成功"，调用方照样清空工作栏。
    // 参照 MDN createWritable 示例的 try/catch + abort 写法补齐。
    if (srcHandle && srcHandle.createWritable) {
      var w = null, closed = false;
      try {
        if (srcHandle.requestPermission) {
          var perm = await srcHandle.requestPermission({ mode: 'readwrite' });
          if (perm !== 'granted') throw new Error('未授予写入权限');
        }
        w = await srcHandle.createWritable();
        await w.write(blob);
        await w.close();
        closed = true;
        return { mode: 'overwrite', name: srcHandle.name || filename };
      } catch (e) {
        if (w && !closed) { try { await w.abort(); } catch (ignored) { /* 已失效 */ } }
        if (e && e.name === 'AbortError') return { mode: 'cancel' };
        console.warn('写回源文件失败，改用另存：', e);
      }
    }
    if (window.showSaveFilePicker) {
      var h = null, w2 = null, closed2 = false;
      try {
        h = await window.showSaveFilePicker({ suggestedName: filename });
        w2 = await h.createWritable();
        await w2.write(blob);
        await w2.close();
        closed2 = true;
        return { mode: 'picker', name: h.name || filename };
      } catch (e2) {
        if (w2 && !closed2) { try { await w2.abort(); } catch (ignored2) { /* 已失效 */ } }
        if (e2 && e2.name === 'AbortError') return { mode: 'cancel' };
        console.warn('另存失败，改用下载：', e2);
      }
    }
    // modified：download 抛错时返回 failed，让调用方保留工作栏，避免"没导出成功却清空"。
    try {
      download(bytes, filename, mime);
      return { mode: 'download', name: filename };
    } catch (e3) {
      console.warn('触发下载失败：', e3);
      return { mode: 'failed', name: filename };
    }
  }

  var toastTimer = null;
  function toast(msg, kind) {
    var el = $('toastBox');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toastBox';
      el.style.cssText = 'position:fixed;left:50%;bottom:52px;transform:translateX(-50%);z-index:200;' +
        'background:rgba(12,18,26,.96);border:1px solid #2a3a4f;color:#dfe9f6;padding:9px 16px;' +
        'border-radius:9px;font-size:12.5px;box-shadow:0 12px 30px -10px #000;transition:.25s;opacity:0';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.borderColor = kind === 'error' ? 'rgba(255,107,107,.6)' : '#2a3a4f';
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.opacity = '0'; }, 2600);
  }

  function busy(on, text) {
    S.busy = on;
    $('busy').hidden = !on;
    if (text) $('busyTxt').textContent = text;
    // modified：忙时被延后的参数变更在这里补跑。
    // 否则导入/批量处理期间拖滑杆，界面参数变了、页面结果还是旧的，导出与所见不一致。
    if (!on && S.pendingApply) {
      S.pendingApply = false;
      clearTimeout(applyTimer);
      applyTimer = setTimeout(queueReprocess, 60);
    }
  }

  /* ---------------- 参数持久化 ---------------- */

  // modified：2.4.5 — 上次使用的设定存进 localStorage，刷新/重启浏览器后自动还原。
  // 只记"界面设定"，不记文件和处理结果（那是临时数据，也不该占存储配额）。
  // 注意：localStorage 按 origin 隔离，http://127.0.0.1:8765 与 8766 互不相通。
  var SETTINGS_KEY = 'docscan.settings.v1';

  // 需要记住的控件：滑杆（range）、开关（checkbox）、下拉（select）各按类型处理。
  // 新增控件时把 id 加进这个列表即可，采集/还原/保存三处都不用改。
  var PERSIST_IDS = [
    'whitening', 'textDark', 'shadow', 'contrast', 'denoise', 'sharpen',
    'keepColor', 'autoQuad', 'trimEdge', 'edgeClean', 'splitSpread', 'deskew',
    'inkGrow', 'trim',
    'presetSel', 'resSel', 'budgetSel', 'pageSizeSel'
  ];

  var MODE_HINT = {
    bleach: '白底黑字，红头与印章仍为红色',
    gray: '灰阶输出，保留照片层次',
    color: '仅去阴影，最大限度保真'
  };

  /** 切换增强模式并同步按钮高亮与提示文案（原来这三件事散落在按钮 onclick 里）。 */
  function setMode(mode) {
    if (!MODE_HINT[mode]) return;
    S.mode = mode;
    var seg = $('segMode');
    if (seg) Array.prototype.forEach.call(seg.children, function (x) {
      x.classList.toggle('on', x.dataset.mode === mode);
    });
    if ($('modeHint')) $('modeHint').textContent = MODE_HINT[mode];
  }

  function collectSettings() {
    var o = { v: 1, mode: S.mode };
    for (var i = 0; i < PERSIST_IDS.length; i++) {
      var el = $(PERSIST_IDS[i]);
      if (!el) continue;
      if (el.type === 'checkbox') o[PERSIST_IDS[i]] = el.checked;
      else if (el.type === 'range') o[PERSIST_IDS[i]] = +el.value;
      else o[PERSIST_IDS[i]] = el.value;
    }
    return o;
  }

  /** 还原上次设定。返回是否真的还原成功（没有存档、存档损坏都算失败，走默认值）。 */
  function restoreSettings() {
    var raw = null;
    try { raw = localStorage.getItem(SETTINGS_KEY); } catch (e) { return false; }
    if (!raw) return false;
    var o;
    try { o = JSON.parse(raw); } catch (e) { return false; }
    if (!o || typeof o !== 'object') return false;

    for (var i = 0; i < PERSIST_IDS.length; i++) {
      var id = PERSIST_IDS[i], el = $(id);
      if (!el || !(id in o)) continue;
      if (el.type === 'checkbox') {
        if (typeof o[id] === 'boolean') el.checked = o[id];
      } else if (el.type === 'range') {
        var n = +o[id];
        if (!isFinite(n)) continue;
        // 夹到滑杆区间内：旧版本存的值可能落在当前 min/max 之外
        if (el.min !== '' && n < +el.min) n = +el.min;
        if (el.max !== '' && n > +el.max) n = +el.max;
        el.value = n;
      } else if (el.options) {
        // 只接受下拉里真实存在的项，免得手改过或旧版存档把控件置空
        var v = String(o[id]), ok = false;
        for (var j = 0; j < el.options.length; j++) {
          if (el.options[j].value === v) { ok = true; break; }
        }
        if (ok) el.value = v;
      }
    }
    // modified：只接受 MODE_HINT 的自有属性。原写法 setMode('toString') 会命中
    // Object.prototype 上的函数（truthy），把 S.mode 污染成 'toString' 并把函数
    // 源码写进 modeHint，导致三个模式按钮全不高亮、readOpts().mode 被带坏。
    if (o.mode && Object.prototype.hasOwnProperty.call(MODE_HINT, o.mode)) setMode(o.mode);
    return true;
  }

  /**
   * 滑杆值若与某个预设完全一致就高亮它，否则全部不高亮。
   * 恢复出来的值往往不等于任何预设，若沿用 HTML 里写死的高亮，会出现
   * "数值早已不是标准档、按钮却还亮着标准"的误导。
   */
  function syncPresetHighlight() {
    var box = $('presets');
    if (!box) return;
    var hit = '';
    Object.keys(PRESETS).forEach(function (name) {
      var pr = PRESETS[name];
      var same = Object.keys(pr).every(function (k) {
        var el = $(k);
        if (!el) return false;
        // 预设里的值不一定落在滑杆的 step 网格上（例如 textDark 1.05 配 step 0.02），
        // 浏览器会把它夹到最近的合法值 1.06。这里按同样规则取整再比，
        // 否则"标准"档永远匹配不上，按钮不会高亮。
        var min = el.min === '' ? 0 : +el.min;
        var step = el.step === '' ? 0.01 : +el.step;
        var want = min + Math.round((pr[k] - min) / step + 1e-9) * step;
        return Math.abs(+el.value - want) < 1e-6;
      });
      if (same) hit = name;
    });
    Array.prototype.forEach.call(box.children, function (b) {
      b.classList.toggle('on', b.dataset.preset === hit);
    });
  }

  /**
   * 恢复出厂设置：滑杆、开关、下拉全部回到 index.html 里写死的初始值。
   * 用 DOM 自带的 defaultValue / defaultChecked / defaultSelected 取值，
   * 不在 JS 里再抄一份默认值——两处各写一遍迟早会不同步。
   */
  function resetAllSettings() {
    for (var i = 0; i < PERSIST_IDS.length; i++) {
      var el = $(PERSIST_IDS[i]);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = el.defaultChecked;
      else if (el.type === 'range') el.value = el.defaultValue;
      else if (el.options) {
        for (var j = 0; j < el.options.length; j++) {
          if (el.options[j].defaultSelected) { el.value = el.options[j].value; break; }
        }
      }
    }
    setMode('bleach');
    syncLabels();
    syncPresetHighlight();
    S.res = +$('resSel').value;
    S.budget = +$('budgetSel').value;
    S.pageSize = $('pageSizeSel').value || 'a4';
    // 重置后的值同样要成为"下次的设定"，否则刷新又回到重置前的状态
    saveSettings();
  }

  var saveTimer = null;

  function flushSettings() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(collectSettings()));
    } catch (e) {
      // 隐私模式、配额满、或浏览器禁用了存储：静默降级，只是这次记不住，不影响使用
    }
  }

  function saveSettings() {
    // 拖滑杆会连续触发 input，合并成一次写入，避免高频同步 IO
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSettings, 200);
  }

  /* ---------------- 状态读取 ---------------- */

  function readOpts() {
    return {
      mode: S.mode,
      preset: $('presetSel') ? $('presetSel').value : 'standard',
      whitening: +$('whitening').value,
      textDark: +$('textDark').value,
      shadow: +$('shadow').value,
      contrast: +$('contrast').value,
      denoise: +$('denoise').value,
      sharpen: +$('sharpen').value,
      keepColor: $('keepColor').checked,
      inkGrow: $('inkGrow').checked ? 1 : 0,
      deskew: $('deskew').checked ? 'auto' : 'off',
      trim: $('trim').checked,
      trimEdge: $('trimEdge').checked,
      edgeClean: $('edgeClean').checked ? 1 : 0,
      maxDim: S.res
    };
  }

  function current() { return S.pages[S.cur] || null; }

  /* ---------------- 导入 ---------------- */

  function makePage(srcCanvas, name, kind, srcHandle) {
    return {
      id: S.uuid++,
      name: name,
      kind: kind || 'image',
      src: srcCanvas,
      rot: 0,
      quad: null,
      quadManual: false,
      result: null,
      rawWarp: null,
      enc: null,
      // modified：保存每页参数快照与任务序号，避免全局参数和异步旧任务污染导出。
      options: null,
      // modified：记录源文件句柄（File System Access API）。导出时可写回原路径，
      // 实现"覆盖源文件"；没有句柄时退化为另存/下载。
      srcHandle: srcHandle || null,
      status: 'idle',
      _run: 0,
      _rot: -1,
      _rotCv: null
    };
  }

  function rotatedSource(p) {
    if (p._rot === p.rot && p._rotCv) return p._rotCv;
    var s = p.src;
    if (p.rot % 4 === 0) { p._rotCv = s; }
    else {
      var swap = p.rot % 2 === 1;
      var c = document.createElement('canvas');
      c.width = swap ? s.height : s.width;
      c.height = swap ? s.width : s.height;
      var x = c.getContext('2d');
      x.translate(c.width / 2, c.height / 2);
      x.rotate(p.rot * Math.PI / 2);
      x.drawImage(s, -s.width / 2, -s.height / 2);
      x.setTransform(1, 0, 0, 1, 0, 0);
      p._rotCv = c;
    }
    p._rot = p.rot;
    return p._rotCv;
  }

  async function imageToCanvas(file) {
    var bmp;
    try {
      bmp = await createImageBitmap(file);
    } catch (e) {
      throw new Error('无法解码该图片（可能是 HEIC 等浏览器不支持的格式）');
    }
    var scale = Math.min(1, SOURCE_MAX / Math.max(bmp.width, bmp.height));
    try {
      var c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      var x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      x.imageSmoothingQuality = 'high';
      x.drawImage(bmp, 0, 0, c.width, c.height);
      return c;
    } finally {
      // modified：改用 finally 释放 ImageBitmap。原写法在 drawImage 抛错时（大图显存不足）
      // 会漏掉 close，反复导入后显存被 bitmap 占满。
      if (bmp && bmp.close) bmp.close();
    }
  }

  async function pdfToCanvases(file) {
    if (typeof pdfjsLib === 'undefined') throw new Error('PDF 组件未加载（vendor/pdf.min.js 缺失）');
    var buf = await file.arrayBuffer();
    var doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    var out = [];
    var base = file.name.replace(/\.pdf$/i, '');
    // modified：任何一页读取或渲染失败都释放 PDF 文档，避免反复导入耗尽内存。
    // 原实现把整段循环放在一个 try 里：第 20 页失败会把前 19 页已渲染的 canvas
    // 全部丢弃、整份 PDF 不导入，用户只看到一条文件名报错。改为逐页容错，
    // 成功页保留，并把跳过页数挂在返回数组上（不改变数组本身的接口）。
    var skipped = 0;
    try {
      for (var i = 1; i <= doc.numPages; i++) {
        try {
          var page = await doc.getPage(i);
          var vp1 = page.getViewport({ scale: 1 });
          // 目标约 200dpi：A4 = 595pt 宽 → 1654px
          var scale = Math.min(3, 1654 / vp1.width);
          var vp = page.getViewport({ scale: scale });
          var c = document.createElement('canvas');
          c.width = Math.round(vp.width);
          c.height = Math.round(vp.height);
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          out.push({ canvas: c, name: base + ' · 第' + i + '页' });
        } catch (ePage) {
          skipped++;
          console.warn('第 ' + i + ' 页渲染失败，已跳过：', ePage);
        }
        if (doc.numPages > 1) await tick(1);
      }
      out.skipped = skipped;
      return out;
    } finally {
      await doc.destroy();
    }
  }

  /**
   * 对开页拆分：书刊摊开扫描成一幅横图时，拆成左右两页。
   * 检测在缩略图上做（900px 够用，省内存），实际裁切在原始分辨率上做。
   */
  function splitIfSpread(canvas) {
    if (!$('splitSpread') || !$('splitSpread').checked) return [canvas];
    if (canvas.width < canvas.height * 1.12) return [canvas];

    var k = 900 / Math.max(canvas.width, canvas.height);
    var sm = document.createElement('canvas');
    sm.width = Math.max(1, Math.round(canvas.width * k));
    sm.height = Math.max(1, Math.round(canvas.height * k));
    var sx = sm.getContext('2d');
    sx.imageSmoothingQuality = 'medium';
    sx.drawImage(canvas, 0, 0, sm.width, sm.height);

    var det;
    try {
      var im = sx.getImageData(0, 0, sm.width, sm.height);
      det = DocScan.detectSpread({ data: im.data, w: im.width, h: im.height });
    } catch (e) { return [canvas]; }
    if (!det) return [canvas];

    var x = Math.round(det.x / sm.width * canvas.width);
    if (x < canvas.width * 0.2 || x > canvas.width * 0.8) return [canvas];

    var wl = x, wr = canvas.width - x, hh = canvas.height;
    var l = document.createElement('canvas'); l.width = wl; l.height = hh;
    l.getContext('2d').drawImage(canvas, 0, 0, wl, hh, 0, 0, wl, hh);
    var r = document.createElement('canvas'); r.width = wr; r.height = hh;
    r.getContext('2d').drawImage(canvas, x, 0, wr, hh, 0, 0, wr, hh);
    return [l, r];
  }

  async function addFiles(files, handles) {
    if (!files || !files.length) return;
    // modified：busy 遮罩只覆盖中间舞台，左栏「添加页面」/拖拽在处理期间仍可点。
    // 原实现无重入保护，两次并发导入会交错写 S.pages/S.cur，且共用单一布尔 busy，
    // 先结束的那份提前解锁。这里在入口拦住重入。
    if (S.busy) { toast('正在处理，请稍候再添加文件'); return; }
    var added = [];
    // modified：整段包进 try/finally。原来 renderRail/render 若在 try 外抛错，
    // S.busy 会永久为 true、遮罩卡死、pendingApply 永不补跑。
    busy(true, '正在读取文件…');
    try {
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        // modified：源文件句柄与文件按顺序一一对应；缺少时保持 null（只能另存，不能覆盖）。
        var fh = (handles && handles[i]) || null;
        try {
          if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
            var pages = await pdfToCanvases(f);
            // modified：部分页渲染失败时保留成功页，并明确告知跳过了几页。
            if (pages.skipped) toast(f.name + '：' + pages.skipped + ' 页渲染失败，已跳过', 'error');
            // 同一个 PDF 拆出的多页共享一个源句柄，导出时可整体覆盖原 PDF。
            pages.forEach(function (it) { added.push(makePage(it.canvas, it.name, 'pdf', fh)); });
          } else if (f.type.indexOf('image') === 0 || /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i.test(f.name)) {
            var c = await imageToCanvas(f);
            var parts = splitIfSpread(c);
            if (parts.length === 2) {
              var base = f.name.replace(/\.[^.]+$/, '');
              var pl = makePage(parts[0], base + ' · 左页', 'image', fh);
              var pr = makePage(parts[1], base + ' · 右页', 'image', fh);
              pl.noAutoQuad = true; pr.noAutoQuad = true;   // 已是精确裁切，跳过四角检测
              added.push(pl, pr);
              toast('检测到对开页，已拆为两页');
            } else {
              added.push(makePage(c, f.name, 'image', fh));
            }
          }
        } catch (err) {
          toast(f.name + '：' + err.message, 'error');
        }
        busy(true, '正在读取文件 ' + (i + 1) + '/' + files.length + '…');
        await tick(2);
      }
      if (!added.length) { render(); return; }

      S.pages = S.pages.concat(added);
      S.cur = S.pages.length - added.length;
      renderRail();
      render();
      await tick(10);
      for (var k = 0; k < added.length; k++) {
        var p = added[k];
        var idx = S.pages.indexOf(p);
        busy(true, '处理第 ' + (idx + 1) + ' / ' + S.pages.length + ' 页…');
        await processPage(p);
        renderRail();
      }
      render();
      updateStats();
    } finally {
      busy(false);
    }
  }

  /* ---------------- 处理 ---------------- */

  // modified：统一编码入口，以结果画布、每页参数和预算作为缓存键，并阻止校验失败页导出。
  async function encodeForPage(p) {
    if (!p || !p.result) throw new Error('页面尚未处理完成');
    if (p.status === 'error') throw new Error('页面最近一次处理失败，请重新处理后再导出');
    var opts = p.options || readOpts();
    var source = p.result;
    var mode = opts.mode, keepColor = opts.keepColor;
    // modified：输出长边上限跟随"处理分辨"，不再让编码器兜底到 3508。
    // 原先这里不传 maxSide，pdfout 恒取 3508，于是用户选 2000/2600 时处理阶段
    // 真降了采样，导出阶段又被放大回 3508 —— 三档体积几乎没有差别，选小档
    // 等于白选。这里让用户所选的分辨成为硬上限，选 2000 就真的输出 2000。
    var maxSide = opts.maxDim || 3508;
    var enc = p.enc;
    // modified：缓存键必须带上 maxSide。源图小于档位时处理画布不变（_source 相同），
    // 若不加这一项，改小分辨后仍会命中旧编码，导出尺寸不会跟着变。
    if (!enc || enc._source !== source || enc._budget !== S.budget || enc._mode !== mode || enc._kc !== keepColor || enc._maxSide !== maxSide) {
      enc = await DocScanPDF.encodePage(source, { budget: S.budget, mode: mode, color: keepColor, maxSide: maxSide });
      if (!enc) throw new Error('页面编码失败');
      if (enc.type === 'flate1bit' && enc.verify === false) throw new Error('无损回读校验失败，已阻止导出');
      if (enc.red && !enc.redBytes) throw new Error('彩色掩膜编码失败，已阻止导出');
      enc._source = source;
      enc._budget = S.budget; enc._mode = mode; enc._kc = keepColor; enc._maxSide = maxSide;
      if (p.result !== source) return encodeForPage(p);
      p.enc = enc;
    }
    return enc;
  }

  // modified：每次处理生成任务序号，过期任务不得覆盖新结果。
  // forcedOpts 用于"应用参数到全部页"：整批共用同一份参数快照，
  // 否则批处理途中改滑杆，前后页会拿到两套参数，同一份文档参数不一致。
  async function processPage(p, forcedOpts) {
    if (!p) return;
    var run = ++p._run;
    p.status = 'busy';
    updateThumbStatus(p);
    await tick(1);
    var t0 = performance.now();
    try {
      var src = rotatedSource(p);
      var ctx = src.getContext('2d');
      var img = ctx.getImageData(0, 0, src.width, src.height);
      var opts = forcedOpts || readOpts();

      var quad = p.quad;
      if ($('autoQuad').checked && !p.quadManual && !p.noAutoQuad) {
        quad = DocScan.detectQuad(img.data, img.width, img.height);
        p.quad = quad;
        p.autoQuad = quad;
      }

      var warp;
      if (quad) {
        var sz = DocScan.quadSize(quad);
        var s = Math.min(1, opts.maxDim / Math.max(sz.w, sz.h));
        warp = DocScan.warpPerspective(img.data, img.width, img.height, quad, sz.w * s, sz.h * s);
      } else {
        warp = DocScan.downscaleRGBA(img.data, img.width, img.height, opts.maxDim);
      }
      await tick(1);

      var res = DocScan.process(warp.data, warp.w, warp.h, opts);
      if (run !== p._run) return;
      p.rawWarp = toCanvas(warp);
      p.result = toCanvas(res);
      p.options = opts;
      p.meta = { srcW: img.width, srcH: img.height, outW: res.w, outH: res.h, ms: 0, ink: res.stats.inkRatio, edgeCut: res.stats.edgeCut, edgeBlobs: res.stats.edgeBlobs };
      await encodeForPage(p);
      if (run !== p._run) return;
      p.status = 'done';
      p.meta.ms = performance.now() - t0;
    } catch (e) {
      if (run !== p._run) return;
      console.error(e);
      p.status = 'error';
      toast('处理失败：' + e.message, 'error');
    }
    updateThumbStatus(p);
    if (current() === p) render();
    updateStats();
  }

  /* ---------------- 渲染 ---------------- */

  function render() {
    var p = current();
    var empty = $('empty'), wrap = $('pageWrap');
    document.body.classList.toggle('nopage', !p);
    if (!p) {
      empty.hidden = false; wrap.hidden = true;
      $('pgIdx').textContent = '—';
      $('pgName').textContent = '尚未导入文件';
      $('sbSize').textContent = '—';
      $('sbTime').textContent = '';
      $('sbNote').textContent = '';
      updateStats();
      return;
    }
    empty.hidden = true; wrap.hidden = false;

    $('pgIdx').textContent = (S.cur + 1) + ' / ' + S.pages.length;
    $('pgName').textContent = p.name;

    var showSource = S.adjust;
    var img = showSource ? rotatedSource(p) : (p.result || rotatedSource(p));
    var cv = $('cvFinal');
    if (cv.width !== img.width || cv.height !== img.height) {
      cv.width = img.width; cv.height = img.height;
    }
    var cx = cv.getContext('2d');
    cx.clearRect(0, 0, cv.width, cv.height);
    cx.drawImage(img, 0, 0);

    // 对比层
    var raw = $('cvRaw');
    if (S.compare && p.rawWarp) {
      raw.hidden = false;
      if (raw.width !== cv.width || raw.height !== cv.height) {
        raw.width = cv.width; raw.height = cv.height;
      }
      var rx = raw.getContext('2d');
      rx.clearRect(0, 0, raw.width, raw.height);
      rx.drawImage(p.rawWarp, 0, 0, raw.width, raw.height);
      raw.style.clipPath = 'inset(0 ' + ((1 - S.split) * 100).toFixed(1) + '% 0 0)';
      $('cmpLine').hidden = false;
      $('cmpLine').style.left = (S.split * 100).toFixed(1) + '%';
    } else {
      raw.hidden = true;
      $('cmpLine').hidden = true;
    }

    // 调框层
    var layer = $('quadLayer');
    if (S.adjust) {
      layer.hidden = false;
      var q = p.quad || insetQuad(img.width, img.height);
      p.quad = q;
      var iw = img.width, ih = img.height;
      $('quadPoly').setAttribute('points', q.map(function (pt) {
        return (pt.x / iw * 100).toFixed(3) + ',' + (pt.y / ih * 100).toFixed(3);
      }).join(' '));
      var hs = layer.querySelectorAll('.handle');
      Array.prototype.forEach.call(hs, function (el, i) {
        el.style.left = (q[i].x / iw * 100).toFixed(3) + '%';
        el.style.top = (q[i].y / ih * 100).toFixed(3) + '%';
      });
      $('stageBadge').hidden = false;
    } else {
      layer.hidden = true;
      $('stageBadge').hidden = true;
    }

    layoutStage();

    if (p.meta) {
      $('sbSize').textContent = p.meta.outW + ' × ' + p.meta.outH + ' px';
      $('sbTime').textContent = '· ' + Math.round(p.meta.ms) + ' ms';
      var note = [];
      var ec = p.meta.edgeCut;
      if (ec) {
        var sum = ec.t + ec.r + ec.b + ec.l;
        if (sum > 0) note.push('去黑边 上' + ec.t + ' 右' + ec.r + ' 下' + ec.b + ' 左' + ec.l + ' px');
      }
      if (p.meta.edgeBlobs > 0) note.push('清边缘杂线 ' + p.meta.edgeBlobs + ' px');
      if (p.enc) {
        var en = p.enc;
        var dpi = Math.round(Math.max(en.w, en.h) / 841.89 * 72);   // 按 A4 长边折算
        var sz = en.bytes.length + (en.redBytes ? en.redBytes.length : 0);
        note.push(fmtSize(sz) + ' · ' + (en.type === 'flate1bit' ? '1bit' : 'JPEG') + ' · ' + dpi + 'dpi');
        // 漂白页退成 JPEG 的唯一原因是"这一页有多种颜色"，不写清楚会被当成体积失控。
        if (en.type === 'jpeg' && p.options && p.options.mode === 'bleach') note.push('多色页回退连续调');
        if (en.red) note.push('红头/印章单层保色');
        if (en.verify === true) note.push('无损校验通过');
      }
      $('sbNote').textContent = note.length ? '· ' + note.join(' · ') : '';
      $('sbNote').title = ec ? '已裁去四周黑边（自动检测）' : '';
    } else {
      $('sbSize').textContent = img.width + ' × ' + img.height + ' px';
      $('sbTime').textContent = '';
      $('sbNote').textContent = p.status === 'error' ? '· 处理失败' : '· 待处理';
    }
    $('btnAdjust').classList.toggle('on', S.adjust);
  }

  function layoutStage() {
    var p = current();
    if (!p) return;
    var wrap = $('pageWrap');
    var img = S.adjust ? rotatedSource(p) : (p.result || rotatedSource(p));
    var vp = $('viewport').getBoundingClientRect();
    var availW = vp.width - 56, availH = vp.height - 56;
    var fit = Math.min(availW / img.width, availH / img.height, 1);
    var scale = S.zoom || fit;
    wrap.style.width = Math.round(img.width * scale) + 'px';
    wrap.style.height = Math.round(img.height * scale) + 'px';
    $('zoomVal').textContent = Math.round(scale * 100) + '%';
    $('cvFinal').style.width = '100%';
    $('cvFinal').style.height = '100%';
    $('cvRaw').style.width = '100%';
    $('cvRaw').style.height = '100%';
  }

  function insetQuad(w, h) {
    var mx = w * 0.03, my = h * 0.03;
    return [{ x: mx, y: my }, { x: w - mx, y: my }, { x: w - mx, y: h - my }, { x: mx, y: h - my }];
  }

  /* ---------------- 缩略图 ---------------- */

  function renderRail() {
    var rail = $('rail');
    rail.innerHTML = '';
    S.pages.forEach(function (p, i) {
      var el = document.createElement('div');
      el.className = 'thumb' + (i === S.cur ? ' on' : '');
      el.dataset.idx = i;
      var img = document.createElement('img');
      img.src = thumbUrl(p, 150);
      el.appendChild(img);
      var no = document.createElement('div');
      no.className = 'no'; no.textContent = i + 1;
      el.appendChild(no);
      var st = document.createElement('div');
      st.className = 'st';
      el.appendChild(st);
      el.onclick = function () {
        S.cur = i; S.adjust = false; S.compare = false;
        renderRail(); render(); updateStats();
      };
      rail.appendChild(el);
    });
    $('pageCount').textContent = S.pages.length;
  }

  function updateThumbStatus(p) {
    var idx = S.pages.indexOf(p);
    if (idx < 0) return;
    var el = $('rail').children[idx];
    if (!el) return;
    el.classList.toggle('busy', p.status === 'busy');
    if (p.status === 'done' && p.result) {
      var img = el.querySelector('img');
      if (img) img.src = thumbUrl(p, 150);
    }
  }

  function updateStats() {
    var pages = S.pages;
    $('statPages').textContent = pages.length;
    var total = 0, done = 0;
    // 印章层也是页面的字节数，统计要算进去，否则总数会偏小
    pages.forEach(function (p) {
      if (p.enc) {
        total += p.enc.bytes.length + (p.enc.redBytes ? p.enc.redBytes.length : 0);
        done++;
      }
    });
    $('statSize').textContent = total ? fmtSize(total) : '—';
    $('statPer').textContent = total ? (total / 1024 / Math.max(1, done)).toFixed(0) + ' KB' : '—';
    $('expPages').textContent = pages.length;
    $('expSize').textContent = total ? fmtSize(total) : '—';
    var codec = pages.filter(function (p) { return p.enc; }).map(function (p) { return p.enc.type; });
    $('expCodec').textContent = codec.length ? (codec.every(function (c) { return c === 'flate1bit'; }) ? '1bit 位图' : 'JPEG') : '—';
  }

  /* ---------------- 参数联动 ---------------- */

  var applyTimer = null;
  function queueReprocess() {
    clearTimeout(applyTimer);
    applyTimer = setTimeout(async function () {
      var p = current();
      if (!p) return;
      // modified：忙时不再丢弃这一轮参数变更，记下来等空闲后补跑。
      if (S.busy) { S.pendingApply = true; return; }
      busy(true, '重新处理…');
      await processPage(p);
      busy(false);
      renderRail();
      updateStats();
    }, 260);
  }

  function syncLabels() {
    $('vWhitening').textContent = (+$('whitening').value).toFixed(2);
    $('vTextDark').textContent = (+$('textDark').value).toFixed(2);
    $('vShadow').textContent = (+$('shadow').value).toFixed(2);
    $('vContrast').textContent = (+$('contrast').value).toFixed(2);
    $('vDenoise').textContent = (+$('denoise').value).toFixed(1);
    $('vSharpen').textContent = (+$('sharpen').value).toFixed(2);
  }

  function setPreset(name) {
    var pr = PRESETS[name];
    if (!pr) return;
    Object.keys(pr).forEach(function (k) {
      var el = $(k);
      if (el) el.value = pr[k];
    });
    syncLabels();
    Array.prototype.forEach.call($('presets').children, function (b) {
      b.classList.toggle('on', b.dataset.preset === name);
    });
    if (name === 'archive') {
      S.res = 2600; $('resSel').value = '2600';
      S.budget = 300; $('budgetSel').value = '300';
    }
    // 直接给控件赋值不会触发 input/change，事件委托收不到，这里显式存一次
    saveSettings();
  }

  /* ---------------- 调框拖拽 ---------------- */

  function bindCornerDrag() {
    var layer = $('quadLayer');
    var dragging = null;
    var hs = layer.querySelectorAll('.handle');

    function moveTo(i, clientX, clientY) {
      var p = current();
      if (!p) return;
      var rect = $('cvFinal').getBoundingClientRect();
      var img = rotatedSource(p);
      var x = (clientX - rect.left) / rect.width * img.width;
      var y = (clientY - rect.top) / rect.height * img.height;
      x = Math.max(0, Math.min(img.width, x));
      y = Math.max(0, Math.min(img.height, y));
      p.quad[i] = { x: x, y: y };
      hs[i].style.left = (x / img.width * 100).toFixed(3) + '%';
      hs[i].style.top = (y / img.height * 100).toFixed(3) + '%';
      $('quadPoly').setAttribute('points', p.quad.map(function (pt) {
        return (pt.x / img.width * 100).toFixed(3) + ',' + (pt.y / img.height * 100).toFixed(3);
      }).join(' '));
    }

    Array.prototype.forEach.call(hs, function (el, i) {
      el.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        dragging = i;
        el.setPointerCapture(e.pointerId);
      });
      el.addEventListener('pointermove', function (e) {
        if (dragging !== i) return;
        moveTo(i, e.clientX, e.clientY);
      });
      el.addEventListener('pointerup', async function () {
        if (dragging !== i) return;
        dragging = null;
        // modified：这是全文件唯一未对 current() 判空的处理器。拖拽期间若点了
        // 「清空任务」/「删除本页」，S.cur=-1 → p=null → async 回调里抛 TypeError。
        var p = current();
        if (!p) return;
        p.quadManual = true;
        busy(true, '按新边框重新矫正…');
        await processPage(p);
        busy(false);
        renderRail();
        render();
      });
      el.addEventListener('pointercancel', function () { dragging = null; });
    });
  }

  /* ---------------- 导出 ---------------- */

  /** 导出用的基础名：取第一页源文件名，去掉 " · 第N页 / 左页 / 右页" 与扩展名。 */
  function exportBaseName() {
    var first = S.pages[0];
    if (!first) return '扫描件';
    var n = String(first.name || '扫描件').split(' · ')[0];
    // modified：名字会直接进 showSaveFilePicker 的 suggestedName 与 a.download。
    // 正常 File.name 不含路径分隔符，但调试入口 __docscan.addCanvas 允许任意 name；
    // 这里做纵深防御：去掉非法字符、前导点和 Windows 保留名。
    n = n.replace(/\.[^.]+$/, '').slice(0, 60)
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(n)) n = '_' + n;
    return n || '扫描件';
  }

  /** 全部页是否来自同一个 PDF 源文件；是则返回该句柄（导出可整体覆盖原 PDF）。 */
  function sharedPdfHandle() {
    if (!S.pages.length) return null;
    var h = S.pages[0].srcHandle;
    if (!h) return null;
    for (var i = 0; i < S.pages.length; i++) {
      var p = S.pages[i];
      if (p.srcHandle !== h || p.kind !== 'pdf') return null;
    }
    return h;
  }

  /** 清空工作栏（文件查阅栏）与全部页面的处理结果，随后回到空状态。 */
  function clearAll(silent) {
    var n = S.pages.length;
    // modified：清空会置 p.src / p.result = null，但原来没有作废在途异步任务、
    // 也没有取消防抖定时器。结果：处理中的 processPage 醒来后拿到 null 画布抛错，
    // 被 catch 吞成"处理失败"提示；busy(false) 还会补跑一次 queueReprocess。
    // 这里给每页递增代次（processPage 用 p._run 判定过期），并清掉待触发的定时器。
    clearTimeout(applyTimer);
    applyTimer = null;
    S.pages.forEach(function (p) {
      p._run = (p._run || 0) + 1;
      p.src = null; p.result = null; p.rawWarp = null; p.enc = null;
      p._rotCv = null; p._thumbSrc = null; p._thumbUrl = null; p.srcHandle = null;
    });
    S.pages = [];
    S.cur = -1;
    S.adjust = false; S.compare = false; S.zoom = 0; S.pendingApply = false;
    renderRail();
    render();
    updateStats();
    if (!silent) toast('已清空 ' + n + ' 页');
  }

  // modified：自检扩展为全部页面，并确保成功、失败、页数不符时都释放 PDF 文档。
  /** 导出后自检：结构 + 渲染两层。返回 null 表示环境里没有 pdf.js，跳过。 */
  async function selfCheck(bytes, expect) {
    if (typeof pdfjsLib === 'undefined') return null;
    try {
      // slice(0) 复制一份：pdf.js 会 transfer 掉传入的 ArrayBuffer
      var doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
      try {
        if (doc.numPages !== expect) {
          return { ok: false, why: '页数 ' + doc.numPages + ' ≠ ' + expect };
        }
        // 每一页都实际渲染，不能只验首页：后续页的掩膜、尺寸或对象引用仍可能损坏。
        for (var i = 1; i <= doc.numPages; i++) {
          var pg = await doc.getPage(i);
          var vp = pg.getViewport({ scale: 0.35 });
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(vp.width));
          c.height = Math.max(1, Math.round(vp.height));
          var cx = c.getContext('2d');
          cx.fillStyle = '#fff';
          cx.fillRect(0, 0, c.width, c.height);
          await pg.render({ canvasContext: cx, viewport: vp }).promise;
        }
        return { ok: true, pages: expect };
      } finally {
        await doc.destroy(); // modified：页数不符或渲染异常也释放 worker 与文档资源。
      }
    } catch (e) {
      return { ok: false, why: e.message };
    }
  }

  // modified：PDF 导出改用每页编码快照，校验失败时阻止下载。
  async function exportPdf() {
    if (!S.pages.length) { toast('还没有可导出的页面'); return; }
    busy(true, '正在压缩并排版 PDF…');
    try {
      var items = [];
      for (var i = 0; i < S.pages.length; i++) {
        var p = S.pages[i];
        busy(true, '正在压缩第 ' + (i + 1) + ' / ' + S.pages.length + ' 页…');
        await tick(1);
        if (!p.result) await processPage(p);
        var enc = await encodeForPage(p);
        var imgW = enc.w, imgH = enc.h, pw, ph, dw, dh, dx, dy;
        if (S.pageSize === 'a4') {
          var portrait = imgH >= imgW;
          pw = portrait ? 595.28 : 841.89;
          ph = portrait ? 841.89 : 595.28;
          var s = Math.min(pw / imgW, ph / imgH);
          dw = imgW * s; dh = imgH * s;
          dx = (pw - dw) / 2; dy = (ph - dh) / 2;
        } else {
          // 原比例：不补白到 A4，保持图像自身长宽比，以 A4 长边 297mm 为基准，
          // 这样页面物理尺寸与实际像素是 1:1 的，不会像硬编码 dpi 那样忽大忽小。
          var longSide = Math.max(imgW, imgH);
          var k3 = 841.89 / longSide;
          pw = imgW * k3; ph = imgH * k3;
          dw = pw; dh = ph; dx = 0; dy = 0;
        }
        items.push({
          type: enc.type, bytes: enc.bytes, imgW: imgW, imgH: imgH,
          // 印章/红头层：漏了这两项，导出时整层丢失，红头在 PDF 里变黑
          redBytes: enc.redBytes, tintColor: enc.tintColor,
          pageW: pw, pageH: ph, dw: dw, dh: dh, dx: dx, dy: dy
        });
      }
      var title = exportBaseName();
      // 按来源文件分组挂书签；单组时不挂（一个书签没有意义）
      var bms = [], lastBase = null;
      for (var j = 0; j < S.pages.length; j++) {
        var base = String(S.pages[j].name || '').split(' · ')[0];
        if (base !== lastBase) { bms.push({ title: base, page: j }); lastBase = base; }
      }
      if (bms.length < 2) bms = [];
      var bytes = DocScanPDF.build(items, { title: title, bookmarks: bms });
      /* 导出后自检：仿 PDF 补丁丁的两层检查——结构层（能否解析、页数是否对）
       * 加渲染层（每一页能否真的画出来）。只有两层都过，才算"交付可用"。
       * 注意 getDocument 会把 ArrayBuffer 转交给 worker 并抽空原数组，
       * 必须传副本，否则下载出去就是空文件。 */
      busy(true, '正在校验导出结果…');
      var chk = await selfCheck(bytes, S.pages.length);
      if (chk && chk.ok === false) throw new Error('导出校验失败：' + chk.why);
      // modified：文件名与源文件一致；有源 PDF 句柄时写回原文件，实现覆盖。
      var srcH = sharedPdfHandle();
      if (srcH && !confirm('将覆盖源文件：\n' + (srcH.name || (title + '.pdf')) + '\n\n确定覆盖？')) {
        busy(false);
        return;
      }
      var saved = await saveOutput(bytes, title + '.pdf', 'application/pdf', srcH);
      if (saved.mode === 'cancel') { busy(false); return; }
      // modified：保存链路彻底失败时不能清空工作栏，否则处理结果不可恢复。
      if (saved.mode === 'failed') {
        busy(false);
        toast('导出失败，文件未写出；工作栏已保留，可重试', 'error');
        return;
      }
      busy(false);
      toast('已导出 ' + S.pages.length + ' 页 · ' + fmtSize(bytes.length) +
        (saved.mode === 'overwrite' ? ' · 已覆盖源文件' : '') +
        (saved.mode === 'download' ? ' · 已触发下载' : '') +
        (chk === null ? ' · 当前环境未回读校验' : ' · 校验通过'),
        chk === null ? 'error' : undefined);
      // modified：导出成功后自动清空工作栏（文件查阅栏）
      clearAll(true);
    } catch (e) {
      console.error(e);
      busy(false);
      toast('导出失败：' + e.message, 'error');
    }
  }

  // modified：按每页实际内容选择 1 位 PNG、彩色 PNG 或 JPEG，并隔离每页字节变量。
  async function exportImages() {
    if (!S.pages.length) { toast('还没有可导出的页面'); return; }
    busy(true, '正在导出图片…');
    try {
      // 每页按自己的处理快照决定格式，不能用导出时的全局模式重解释旧结果。
      // 漂白页始终用 PNG；连续调页用 JPEG。多色漂白页也必须用 24 位 PNG。
      var files = [];
      var keptColor = 0, pngCount = 0, jpgCount = 0;
      for (var i = 0; i < S.pages.length; i++) {
        var p = S.pages[i];
        if (!p.result) await processPage(p);
        var enc = await encodeForPage(p);
        var opts = p.options || readOpts();
        var continuous = opts.mode === 'gray' || opts.mode === 'color';
        var colorScan = null;
        var hasColor = opts.mode === 'bleach' && opts.keepColor &&
          (enc.red || (enc.type === 'jpeg' && !!(colorScan = DocScanPDF.scanColor(p.result))));
        var ext = continuous ? 'jpg' : 'png';
        // var 在循环间共享绑定，必须显式清空，否则后续页会复用第一张图的字节。
        var bytes = null, blob = null;
        if (continuous) {
          blob = await new Promise(function (res) { p.result.toBlob(res, 'image/jpeg', 0.92); });
        } else if (hasColor) {
          // 单色掩膜与多色回退都不能塞进 1 位 PNG，否则颜色会被静默删掉。
          blob = await new Promise(function (res) { p.result.toBlob(res, 'image/png'); });
          keptColor++;
        } else {
          bytes = await DocScanPDF.png1bit(p.result);
          if (!bytes) blob = await new Promise(function (res) { p.result.toBlob(res, 'image/png'); });
        }
        if (!bytes) {
          if (!blob) throw new Error('第 ' + (i + 1) + ' 页图片编码失败');
          bytes = new Uint8Array(await blob.arrayBuffer());
        }
        if (continuous) jpgCount++; else pngCount++;
        var num = String(i + 1).padStart(3, '0');
        files.push({ name: 'page-' + num + '.' + ext, bytes: bytes });
        await tick(1);
      }
      var zip = DocScanPDF.zip(files);
      var title = exportBaseName();
      // modified：ZIP 无法覆盖单张源图，用源名另存；导出成功后自动清空工作栏。
      var saved = await saveOutput(zip, title + '.zip', 'application/zip', null);
      if (saved.mode === 'cancel') { busy(false); return; }
      // modified：与 PDF 导出一致，失败时保留工作栏。
      if (saved.mode === 'failed') {
        busy(false);
        toast('导出失败，文件未写出；工作栏已保留，可重试', 'error');
        return;
      }
      busy(false);
      var formats = [];
      if (pngCount) formats.push(pngCount + ' 张 PNG（无损）');
      if (jpgCount) formats.push(jpgCount + ' 张 JPEG');
      toast('已导出 ' + files.length + ' 张图片：' + formats.join('、') +
        (keptColor ? '；其中 ' + keptColor + ' 张保留彩色' : ''));
      // modified：导出成功后自动清空工作栏（文件查阅栏）
      clearAll(true);
    } catch (e) {
      busy(false);
      toast('导出失败：' + e.message, 'error');
    }
  }

  /* ---------------- 绑定 ---------------- */

  function bind() {
    // 导入
    $('fileInput').onchange = function (e) { addFiles(e.target.files); e.target.value = ''; };
    // modified：优先用 showOpenFilePicker，能拿到文件句柄，导出时才可覆盖源文件；
    // 不支持的环境回退到隐藏的 <input type=file>（只有文件名，无法覆盖）。
    async function pickFiles() {
      if (window.showOpenFilePicker) {
        try {
          var hs = await window.showOpenFilePicker({
            multiple: true,
            types: [{
              description: '图片或 PDF',
              accept: {
                'application/pdf': ['.pdf'],
                'image/jpeg': ['.jpg', '.jpeg'],
                'image/png': ['.png'],
                'image/webp': ['.webp'],
                'image/bmp': ['.bmp'],
                'image/gif': ['.gif'],
                'image/tiff': ['.tif', '.tiff']
              }
            }]
          });
          var files = [];
          for (var i = 0; i < hs.length; i++) files.push(await hs[i].getFile());
          addFiles(files, hs);
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;   // 用户取消，不当错误处理
          console.warn('showOpenFilePicker 失败，回退 input：', err);
        }
      }
      $('fileInput').click();
    }
    $('dropMini').onclick = pickFiles;
    $('btnPick').onclick = pickFiles;
    $('btnAdd').onclick = pickFiles;

    function hasFiles(e) {
      var dt = e.dataTransfer;
      if (!dt) return false;
      if (dt.types) {
        for (var i = 0; i < dt.types.length; i++) if (dt.types[i] === 'Files') return true;
      }
      return false;
    }
    var dragDepth = 0;
    function showMask(on) {
      $('dropMask').hidden = !on;
      $('dropMini').classList.toggle('drag', on);
    }
    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      showMask(true);
    });
    window.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', function (e) {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth || !e.relatedTarget) { dragDepth = 0; showMask(false); }
    });
    // modified：拖拽时尽量取到源文件句柄（File System Access API）。
    // 有句柄，导出才能写回原路径实现"覆盖源文件"；取不到就退化为另存/下载。
    window.addEventListener('drop', async function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      showMask(false);
      var files = [], handles = [];
      var items = e.dataTransfer.items;
      if (items && items.length) {
        var pending = [];
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (it.kind !== 'file') continue;
          var f = it.getAsFile ? it.getAsFile() : null;
          if (!f) continue;
          files.push(f);
          // 句柄必须在事件的用户激活期内同步发起申请，等 await 之后再调用会丢上下文
          // modified：getAsFileSystemHandle() 可能同步抛（SecurityError / 非用户激活 / 实现差异），
          // 原写法只 .catch 兜 rejection，同步抛会中断整个 drop 回调，已收集的文件全部不导入。
          var hp = null;
          try { if (it.getAsFileSystemHandle) hp = it.getAsFileSystemHandle(); } catch (eH) { hp = null; }
          pending.push(Promise.resolve(hp).catch(function () { return null; }));
        }
        handles = await Promise.all(pending);
      } else if (e.dataTransfer.files) {
        for (var j = 0; j < e.dataTransfer.files.length; j++) {
          files.push(e.dataTransfer.files[j]);
          handles.push(null);
        }
      }
      if (files.length) addFiles(files, handles);
    });

    // 模式
    Array.prototype.forEach.call($('segMode').children, function (b) {
      b.onclick = function () {
        setMode(b.dataset.mode);
        queueReprocess();
        saveSettings();
      };
    });

    // 预设
    Array.prototype.forEach.call($('presets').children, function (b) {
      b.onclick = function () { setPreset(b.dataset.preset); queueReprocess(); };
    });

    // 滑杆
    ['whitening', 'textDark', 'shadow', 'contrast', 'denoise', 'sharpen'].forEach(function (id) {
      $(id).addEventListener('input', function () { syncLabels(); });
      $(id).addEventListener('change', function () {
        Array.prototype.forEach.call($('presets').children, function (b) { b.classList.remove('on'); });
        queueReprocess();
      });
    });
    // modified：重置改为恢复"全部"默认（原来只重置滑杆，开关和下拉不动）。
    // 加了自动记忆之后，用户需要一个能真正回到出厂的出口。
    $('btnReset').onclick = function () {
      resetAllSettings();
      queueReprocess();
      toast('已恢复默认参数，并记为下次的设定');
    };

    // 开关（deskew / inkGrow 原先漏绑，切换后不重算）
    ['keepColor', 'trim', 'trimEdge', 'edgeClean', 'deskew', 'inkGrow'].forEach(function (id) {
      $(id).onchange = queueReprocess;
    });
    $('autoQuad').onchange = function () {
      var p = current();
      if (p) { p.quadManual = false; if (!this.checked) p.quad = null; }
      queueReprocess();
    };

    // 输出设置
    $('resSel').onchange = function () { S.res = +this.value; queueReprocess(); };
    // modified：调整预算只重编码，不改变页面处理参数，并复用统一快照逻辑。
    $('budgetSel').onchange = async function () {
      S.budget = +this.value;
      var p = current();
      if (!p || !p.result) return;
      try {
        await encodeForPage(p);
        render(); updateStats();
      } catch (e) {
        console.error(e);
        toast('重新压缩失败：' + e.message, 'error');
      }
    };
    $('pageSizeSel').onchange = function () { S.pageSize = this.value; };
    // 纸张状况档位直接改变局部阈值的窗宽与系数，必须重算而不是只重编码
    $('presetSel').onchange = function () { queueReprocess(); };

    // 参数自动记忆：走事件委托而不是逐个绑定，
    // 以后新增任何滑杆/开关/下拉都不用再补一行保存调用，不会漏。
    // 用 setTimeout 合并，拖滑杆时的连续 input 只写一次。
    document.addEventListener('input', saveSettings);
    document.addEventListener('change', saveSettings);
    // 关页面/切后台时把还没落盘的合并写入立刻刷掉，
    // 否则拖完滑杆 200ms 内直接关标签页，最后一次调整会丢。
    window.addEventListener('pagehide', flushSettings);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushSettings();
    });

    $('btnApplyAll').onclick = async function () {
      // modified：忙时禁止重入，避免两轮批处理共用单一布尔 busy 提前解锁。
      if (S.busy) { toast('正在处理，请稍候'); return; }
      if (!S.pages.length) return;
      // modified：整批只取一次参数，批处理途中拖滑杆不会让前后页参数不一致。
      var snap = readOpts();
      busy(true, '正在应用参数…');
      for (var i = 0; i < S.pages.length; i++) {
        busy(true, '应用参数 ' + (i + 1) + ' / ' + S.pages.length + '…');
        await processPage(S.pages[i], snap);
        renderRail();
      }
      busy(false);
      render();
      updateStats();
    };

    // 工具条
    $('btnAdjust').onclick = function () {
      S.adjust = !S.adjust;
      S.compare = false;
      var p = current();
      if (S.adjust && p && !p.quad) p.quad = insetQuad(rotatedSource(p).width, rotatedSource(p).height);
      render();
    };
    $('btnRedetect').onclick = async function () {
      var p = current();
      if (!p) return;
      p.quadManual = false; p.quad = null;
      busy(true, '重新检测纸张边缘…');
      await processPage(p);
      busy(false);
      renderRail(); render();
      toast('已重新检测边缘');
    };
    $('btnRotate').onclick = async function () {
      var p = current();
      if (!p) return;
      p.rot = (p.rot + 1) % 4;
      p.quad = null; p.quadManual = false; p._rot = -1;
      busy(true, '旋转并重新处理…');
      await processPage(p);
      busy(false);
      renderRail(); render();
    };
    $('btnDelete').onclick = function () {
      // modified：忙时禁止破坏性操作，否则在途 processPage 会拿到已被删除的页对象。
      if (S.busy) { toast('正在处理，请稍候'); return; }
      var p = current();
      if (!p) return;
      S.pages.splice(S.cur, 1);
      if (S.cur >= S.pages.length) S.cur = S.pages.length - 1;
      S.adjust = false;
      renderRail(); render(); updateStats();
    };
    // modified：清空任务——清空工作栏里全部页面与处理结果，属于破坏性操作，先确认。
    $('btnClearAll').onclick = function () {
      // modified：忙时禁止清空（遮罩只覆盖舞台，左栏按钮仍可点），避免与在途任务竞态。
      if (S.busy) { toast('正在处理，请稍候'); return; }
      if (!S.pages.length) { toast('当前没有任务'); return; }
      if (!confirm('确定清空全部 ' + S.pages.length + ' 页？未导出的处理结果会丢失。')) return;
      clearAll();
    };

    // 对比
    var cmpBtn = $('btnCompare');
    cmpBtn.addEventListener('pointerdown', function (e) {
      if (!current()) return;
      S.compare = true;
      cmpBtn.classList.add('on');
      render();
      cmpBtn.setPointerCapture(e.pointerId);
    });
    window.addEventListener('pointerup', function () {
      if (!S.compare) return;
      S.compare = false;
      cmpBtn.classList.remove('on');
      render();
    });
    $('viewport').addEventListener('pointermove', function (e) {
      if (!S.compare) return;
      var rect = $('cvFinal').getBoundingClientRect();
      S.split = Math.max(0.02, Math.min(0.98, (e.clientX - rect.left) / rect.width));
      render();
    });

    // 缩放
    $('zoomIn').onclick = function () {
      var p = current(); if (!p) return;
      var img = S.adjust ? rotatedSource(p) : (p.result || rotatedSource(p));
      var vp = $('viewport').getBoundingClientRect();
      var fit = Math.min((vp.width - 56) / img.width, (vp.height - 56) / img.height, 1);
      S.zoom = Math.min(4, (S.zoom || fit) * 1.25);
      layoutStage();
    };
    $('zoomOut').onclick = function () {
      var p = current(); if (!p) return;
      S.zoom = Math.max(0.08, (S.zoom || 1) / 1.25);
      layoutStage();
    };
    $('zoomFit').onclick = function () { S.zoom = 0; layoutStage(); };

    // 示例
    function loadDemo() {
      var photo = DocScanDemo.makePhoto({ scale: 1.25 });
      S.pages.push(makePage(photo, '示例 · 手机拍摄的红头文件', 'demo'));
      S.cur = S.pages.length - 1;
      renderRail(); render();
      busy(true, '正在处理示例…');
      processPage(S.pages[S.cur]).then(function () {
        busy(false); renderRail(); render(); updateStats();
      });
    }
    $('btnDemo').onclick = loadDemo;
    $('btnDemo2').onclick = loadDemo;

    // 帮助
    $('btnHelp').onclick = function () { $('helpModal').hidden = false; };
    $('btnCloseHelp').onclick = function () { $('helpModal').hidden = true; };
    $('helpModal').addEventListener('click', function (e) {
      if (e.target === this) this.hidden = true;
    });

    // 导出
    $('btnExportPdf').onclick = exportPdf;
    $('btnExportImg').onclick = exportImages;

    // 尺寸变化
    var rzTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(rzTimer);
      rzTimer = setTimeout(function () { S.zoom = 0; layoutStage(); }, 120);
    });

    // 快捷键
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { $('helpModal').hidden = true; }
      // modified：滑杆/下拉/输入框获得焦点时，方向键属于控件本身，不能再翻页。
      // 补上 button（点完「旋转」「调框」后焦点常驻留）与 contenteditable。
      var tag = (e.target && e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button' ||
          (e.target && e.target.isContentEditable)) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if ($('helpModal').hidden === false) return;
        var d = e.key === 'ArrowLeft' ? -1 : 1;
        var n = S.cur + d;
        if (n >= 0 && n < S.pages.length) {
          S.cur = n; S.adjust = false;
          renderRail(); render(); updateStats();
        }
      }
    });

    bindCornerDrag();

    // 便于自检/演示：index.html#demo 直接载入示例
    var zm = /zoom=([\d.]+)/.exec(location.hash);
    // modified：URL hash 里的 zoom 原样赋给 S.zoom，#zoom=999999999 会让
    // layoutStage 算出 2.6e9 px 的样式宽度拖垮布局；与 zoomIn/Out 一样夹到 [0.08,4]。
    if (zm) {
      var zv = parseFloat(zm[1]);
      if (isFinite(zv) && zv > 0) S.zoom = Math.max(0.08, Math.min(4, zv));
    }
    if (/demo/.test(location.hash)) setTimeout(loadDemo, 350);
  }

  /* ---------------- 启动 ---------------- */

  function init() {
    if (typeof pdfjsLib !== 'undefined') {
      try {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
      } catch (e) { /* ignore */ }
    }
    // modified：先还原上次设定，再同步标签与内部状态，最后才绑定事件。
    // 顺序不能颠倒：若先绑事件，还原时写控件值虽不触发事件，但后续 syncLabels
    // 会拿旧值渲染；若在还原前 setPreset('standard')，会把用户上次的滑杆值冲掉。
    restoreSettings();
    syncLabels();
    S.budget = +$('budgetSel').value;
    S.res = +$('resSel').value;
    S.pageSize = $('pageSizeSel').value || 'a4';
    syncPresetHighlight();
    bind();
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // 调试 / 自动化测试入口
  window.__docscan = {
    state: S,
    addFiles: addFiles,
    addCanvas: function (canvas, name) {
      S.pages.push(makePage(canvas, name || 'canvas', 'demo'));
      S.cur = S.pages.length - 1;
      renderRail(); render();
      return processPage(S.pages[S.cur]);
    }
  };
})();
