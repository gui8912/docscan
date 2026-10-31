/* =============================================================
 * pdfout.js — 零依赖 PDF 生成 / 体积预算压缩
 *  - 黑白漂白页 → 1bit 位图 + FlateDecode（体积最小、文字最锐）
 *  - 灰度/彩色页 → JPEG（按目标体积二分搜索质量与缩放）
 * ============================================================= */
(function (global) {
  'use strict';

  function latin1(str) {
    var a = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0xff;
    return a;
  }

  function hexUtf16(str) {
    var out = '<FEFF';
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i).toString(16).toUpperCase();
      while (c.length < 4) c = '0' + c;
      out += c;
    }
    return out + '>';
  }

  /* ---------------- 压缩 ---------------- */

  function deflate(bytes) {
    if (typeof CompressionStream === 'undefined') return Promise.resolve(null);
    try {
      var cs = new CompressionStream('deflate');
      var stream = new Blob([bytes]).stream().pipeThrough(cs);
      return new Response(stream).arrayBuffer().then(function (buf) {
        return new Uint8Array(buf);
      }).catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  /* 回读校验用：把 Flate 流解回原始位图，与编码前的位图逐字节比对 */
  function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') return Promise.resolve(null);
    try {
      var ds = new DecompressionStream('deflate');
      var stream = new Blob([bytes]).stream().pipeThrough(ds);
      return new Response(stream).arrayBuffer().then(function (buf) {
        return new Uint8Array(buf);
      }).catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function drawTo(canvas, w, h) {
    if (canvas.width === w && canvas.height === h) return canvas;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, w, h);
    return c;
  }

  // 打包为 1bit 位图（1 = 白）
  // targetInk > 0 时按"目标墨量占比"反算阈值：放大后要保住原尺寸的笔画粗细，
  // 固定阈值会让细线变细、粗线变粗（实测 1px 线在 1.35 倍下掉 19% 墨量）。
  function packBits(canvas, w, h, threshold, targetInk) {
    var src = drawTo(canvas, w, h);
    var d = src.getContext('2d').getImageData(0, 0, w, h).data;
    var n = w * h, i, p, lum;

    var thr = threshold;
    if (targetInk > 0) {
      var hist = new Int32Array(256);
      for (i = 0; i < n; i++) {
        p = i * 4;
        lum = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
        hist[lum < 0 ? 0 : (lum > 255 ? 255 : lum | 0)]++;
      }
      var need = targetInk * n, acc = 0;
      thr = 255;
      for (i = 0; i < 256; i++) {
        acc += hist[i];
        if (acc >= need) { thr = i + 1; break; }
      }
    }

    var rowBytes = Math.ceil(w / 8);
    var out = new Uint8Array(rowBytes * h);
    var black = 0;
    for (var y = 0; y < h; y++) {
      var ro = y * rowBytes, so = y * w * 4;
      for (var x = 0; x < w; x++) {
        p = so + x * 4;
        lum = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
        if (lum >= thr) out[ro + (x >> 3)] |= (0x80 >> (x & 7));
        else black++;
      }
    }
    return { bits: out, ink: black / n };
  }

  function pack1bit(canvas, w, h, threshold) {
    return packBits(canvas, w, h, threshold, 0).bits;
  }

  /* ---------------- 单色印章层 ----------------
   * 问题：漂白模式输出 1bit 单色，红头与印章的红色在二值化后全部变成黑块，
   *       而预览是彩色的 —— 预览与导出不一致，属于"内容被算法悄悄改动"。
   * 办法：把彩色像素从黑白层里摘出去（置白），另存一层 1bit 掩膜，
   *       在 PDF 里用 /ImageMask + rg 填充色画在黑白层之上。
   *       体积只增加掩膜本身的 Flate 流（印章/红头区域，通常几 KB），
   *       300dpi 的清晰度完全不受影响。
   */

  /** 预扫描：判断这一页有没有值得单独保留的颜色 */
  function scanColor(canvas) {
    var k = Math.min(1, 480 / Math.max(canvas.width, canvas.height));
    var c = drawTo(canvas, Math.max(1, Math.round(canvas.width * k)), Math.max(1, Math.round(canvas.height * k)));
    var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    var n = c.width * c.height, chroma = 0, redN = 0, blueN = 0, greenN = 0;
    var sR = 0, sG = 0, sB = 0, sN = 0;          // 彩色像素均值
    var kR = 0, kG = 0, kB = 0, kN = 0;          // 笔画芯部均值（低亮度高饱和）
    for (var i = 0; i < n; i++) {
      var p = i * 4, r = d[p], g = d[p + 1], b = d[p + 2];
      var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      var c0 = mx - mn;
      if (c0 < 30 || mx < 40) continue;
      chroma++;
      if (c0 >= 60) {
        sR += r; sG += g; sB += b; sN++;
        // 油墨芯部：与白底混合过的边缘像素会把颜色拉成粉色，不能参与取色
        if (0.299 * r + 0.587 * g + 0.114 * b <= 140) { kR += r; kG += g; kB += b; kN++; }
      }
      if (r > g + 12 && r > b + 12) redN++;
      else if (b > r + 12 && b > g + 12) blueN++;
      else if (g > r + 12 && g > b + 12) greenN++;
    }
    if (!chroma) return null;
    // modified：按第二颜色的实际占比判定多色，避免 82% 主色规则吞掉少数颜色。
    var dominant = Math.max(redN, blueN, greenN);
    var secondary = chroma - dominant;
    // 少量第二颜色也必须走连续调，不能被主色掩膜压成黑色；仅忽略压缩噪点级杂色。
    var kind = secondary > Math.max(8, chroma * 0.002) ? 'mixed'
      : (redN >= blueN && redN >= greenN ? 'red' : (blueN >= greenN ? 'blue' : 'green'));
    // 芯部样本够多就用芯部色；否则退回全彩均值，并补一点纯度
    var col, boost;
    if (kN >= 24 && kN >= sN * 0.25) {
      col = [kR / kN, kG / kN, kB / kN]; boost = 1;
    } else if (sN) {
      col = [sR / sN, sG / sN, sB / sN]; boost = 1.35;
    } else {
      col = [200, 60, 60]; boost = 1;
    }
    var g0 = 0.299 * col[0] + 0.587 * col[1] + 0.114 * col[2];
    col = [col[0] + (col[0] - g0) * (boost - 1),
      col[1] + (col[1] - g0) * (boost - 1),
      col[2] + (col[2] - g0) * (boost - 1)];
    return { ratio: chroma / n, kind: kind, color: col, dbg: { n: n, chroma: chroma, redN: redN, blueN: blueN, greenN: greenN, sN: sN, kN: kN } };
  }

  var POP8 = (function () {
    var t = new Uint8Array(256);
    for (var n = 1; n < 256; n++) t[n] = (n & 1) + t[n >> 1];
    return t;
  })();

  /**
   * 掩膜的 1 像素闭运算（先膨胀后腐蚀）。
   * 掩膜里 0 = 出墨、1 = 留白，所以"膨胀"是让 0 蔓延。
   * 放大后的细笔画（章名、五角星边、印框）常被双线性插值摊薄成断续的点，
   * 闭运算能把 1~2px 的断口接上，而不整体加粗笔画 —— 与马健讲的
   * 形态学"击中-击不中"去毛刺是同一路数。只在字节层面做，代价很小。
   */
  function maskClose(m, w, h) {
    var rb = Math.ceil(w / 8);
    var a1 = new Uint8Array(m.length), a2 = new Uint8Array(m.length);
    var y, j, o, a, pv, nx, up, dn;

    // 1) 横向膨胀：0（出墨）向左右各蔓延 1 像素。图外一律当作留白（1）
    for (y = 0; y < h; y++) {
      o = y * rb;
      for (j = 0; j < rb; j++) {
        a = m[o + j];
        pv = j > 0 ? m[o + j - 1] >> 7 : 1;
        nx = j + 1 < rb ? m[o + j + 1] >> 7 : 1;
        a1[o + j] = a & ((a << 1) | pv) & ((a >> 1) | nx);
      }
    }
    // 2) 纵向膨胀：与上下各 1 行相与
    for (y = 0; y < h; y++) {
      o = y * rb; up = (y > 0 ? y - 1 : y) * rb; dn = (y + 1 < h ? y + 1 : y) * rb;
      for (j = 0; j < rb; j++) a2[o + j] = a1[o + j] & a1[up + j] & a1[dn + j];
    }
    // 3) 横向腐蚀：1（留白）向左右蔓延 1 像素，把膨胀撑出来的边收回去
    for (y = 0; y < h; y++) {
      o = y * rb;
      for (j = 0; j < rb; j++) {
        a = a2[o + j];
        pv = j > 0 ? a2[o + j - 1] >> 7 : 0;
        nx = j + 1 < rb ? a2[o + j + 1] >> 7 : 0;
        a1[o + j] = a | ((a << 1) | pv) | ((a >> 1) | nx);
      }
    }
    // 4) 纵向腐蚀
    for (y = 0; y < h; y++) {
      o = y * rb; up = (y > 0 ? y - 1 : y) * rb; dn = (y + 1 < h ? y + 1 : y) * rb;
      for (j = 0; j < rb; j++) a2[o + j] = a1[o + j] | a1[up + j] | a1[dn + j];
    }
    return a2;
  }

  /**
   * 打包：黑白层 + 彩色层掩膜
   *
   * 两条"墨量守恒"同时生效：
   *  - 黑白层按 targetInk 反算亮度阈值（放大后笔画不变粗细）
   *  - 印章层按 targetChroma 反算色度阈值（否则细笔画在放大后色度被冲淡，
   *    环形章名会碎成一串点 —— 实测放大 2 倍时章名笔画几乎全断）
   * 两者都只在"非彩色像素"上统计黑白直方图，彩色像素已被摘走，不能算成墨。
   */
  function packInk(canvas, w, h, targetInk, targetChroma, tint) {
    var src = drawTo(canvas, w, h);
    var d = src.getContext('2d').getImageData(0, 0, w, h).data;
    var n = w * h, i, p, r, g, b, mx, mn, lum, c0;
    var col = tint ? tint.color : null;
    // 目标色的主通道：只摘"同色系"像素，避免一个蓝点被涂成红
    var cr = col ? col[0] : 0, cg = col ? col[1] : 0, cb = col ? col[2] : 0;
    var domR = cr >= cg && cr >= cb, domG = !domR && cg >= cb, domB = !domR && !domG;

    var rowBytes = Math.ceil(w / 8);
    var out = new Uint8Array(rowBytes * h);
    var red = tint ? new Uint8Array(rowBytes * h) : null;
    if (red) red.fill(255);                      // 掩膜：1 = 不画，0 = 画

    // ---- 第一遍：分类（彩色 / 黑白）+ 两张直方图 ----
    var isT = tint ? new Uint8Array(n) : null;
    var lumHist = new Int32Array(256);
    var chrHist = new Int32Array(256);
    var plain = 0, hueN = 0;
    for (i = 0; i < n; i++) {
      p = i * 4; r = d[p]; g = d[p + 1]; b = d[p + 2];
      if (col) {
        mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        c0 = mx - mn;
        if (mx > 36 && c0 >= 8 &&
          ((domR && r >= g && r >= b) || (domG && g >= r && g >= b) || (domB && b >= r && b >= g))) {
          isT[i] = 1; hueN++;
          chrHist[c0 > 255 ? 255 : c0]++;
          continue;
        }
      }
      lum = 0.299 * r + 0.587 * g + 0.114 * b;
      lumHist[lum < 0 ? 0 : (lum > 255 ? 255 : lum | 0)]++;
      plain++;
    }

    // ---- 阈值：黑白按墨量上限、印章按彩色像素占比 ----
    var thr = 160;
    if (targetInk > 0) {
      var need = targetInk * Math.max(1, plain), acc = 0;
      thr = 255;
      for (i = 0; i < 256; i++) {
        acc += lumHist[i];
        if (acc >= need) { thr = i + 1; break; }
      }
    }
    var tch = 26;
    if (targetChroma > 0 && hueN > 0) {
      var need2 = targetChroma * n, acc2 = 0, hit = false;
      for (i = 255; i >= 0; i--) {
        acc2 += chrHist[i];
        if (acc2 >= need2) { tch = i; hit = true; break; }
      }
      // 目标占比高于候选像素总量时不能一路走到 255（会把整层清空），退回默认阈值
      if (!hit) tch = 26;
      if (tch < 8) tch = 8;
    }

    // ---- 第二遍：出位图 ----
    var black = 0, tinted = 0, plainB = 0;
    for (var y = 0; y < h; y++) {
      var ro = y * rowBytes, so = y * w;
      for (var x = 0; x < w; x++) {
        i = so + x;
        if (isT && isT[i]) {
          p = i * 4;
          mx = Math.max(d[p], d[p + 1], d[p + 2]);
          mn = Math.min(d[p], d[p + 1], d[p + 2]);
          if (mx - mn >= tch) {
            tinted++;
            red[ro + (x >> 3)] &= ~(0x80 >> (x & 7));
            out[ro + (x >> 3)] |= (0x80 >> (x & 7));   // 黑白层留白
            continue;
          }
        }
        plainB++;
        p = i * 4;
        lum = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
        if (lum >= thr) out[ro + (x >> 3)] |= (0x80 >> (x & 7));
        else black++;
      }
    }
    // 印章层补断笔：细笔画被放大摊薄后会碎成点，闭运算能接上 1~2px 的断口
    if (red) {
      red = maskClose(red, w, h);
      var whiteBits = 0;
      for (i = 0; i < red.length; i++) whiteBits += POP8[red[i]];
      tinted = n - whiteBits;
    }
    return {
      bits: out, red: red, tinted: tinted, ink: plainB ? black / plainB : 0,
      chroma: n ? tinted / n : 0,
      dbg: { n: n, plainA: plain, plainB: plainB, hueN: hueN, thr: thr, tch: tch, tinted: tinted, black: black }
    };
  }

  function canvasJpeg(canvas, q) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) {
        if (!blob) { resolve(null); return; }
        blob.arrayBuffer().then(function (b) { resolve(new Uint8Array(b)); });
      }, 'image/jpeg', q);
    });
  }

  /**
   * 按目标体积编码一页
   *
   * 二值页的关键点（借马健 ComicEnhancerPro 的经验）：
   * 1bit 图像放大后"毛刺、粘连、断笔"的根源是边缘没有中间灰度。
   * 弥补办法不是修边，而是**先放大再二值化**：双线性放大让边缘落在
   * 亚像素的位置，再过阈值，轮廓就自然平滑，1bit 的体积却几乎不变。
   * 这里把它做成"用体积预算换精度"：先按原生尺寸编码，量出体积，
   * 再按预算反推能放大多少倍（长边上限 3508 ≈ A4 300dpi）。
   *
   * @param canvas 页面画布
   * @param opts {budget:KB|0, mode:'bleach'|'gray'|'color', maxSide, color}
   */
  function encodePage(canvas, opts) {
    var budget = (opts.budget === 0) ? Infinity : Math.max(30, opts.budget || 150) * 1024;
    var mode = opts.mode || 'bleach';
    var maxSide = opts.maxSide || 3508;

    // 灰度/彩色模式输出连续调，交 JPEG；只有漂白模式才是 1bit 位图
    if (mode === 'color' || mode === 'gray') return jpegFit(canvas, budget);

    // 漂白模式下若有红头/印章/蓝章：单色系 → 单独成层；多色混杂 → 退回彩色 JPEG
    var tint = null;
    if (mode === 'bleach' && opts.color !== false) {
      var s = scanColor(canvas);
      if (s && s.ratio >= 0.0003) {
        if (s.kind === 'mixed') return jpegFit(canvas, budget);
        tint = s;
      }
    }

    return encode1bit(canvas, 1, 0, tint ? { color: tint.color, kind: tint.kind, ratio: 0 } : null).then(function (base) {
      if (!base) return jpegFit(canvas, budget);

      if (base.bytes.length > budget) return shrink1bit(canvas, budget, base, tint);

      // 预算有余 → 提升输出精度（最多到 maxSide 或 2 倍）
      var cap = Math.min(2, maxSide / Math.max(canvas.width, canvas.height));
      var k = budget === Infinity ? cap : Math.min(cap, Math.sqrt(budget * 0.90 / base.bytes.length));
      if (!(k > 1.06)) return base;

      // 放大后要用基础层实测的彩色占比当目标，章名细笔画才不会碎成点
      var tint2 = tint ? { color: tint.color, kind: tint.kind, ratio: base.chroma } : null;
      return encode1bit(canvas, k, base.ink, tint2).then(function (big) {
        // modified：预算内的放大结果即使体积略大也应采用，目的正是用预算换精度。
        if (big && big.bytes.length <= budget) return big;
        return base;
      });
    }).then(verifyLossless);
  }

  /** 1bit 编码：k 为相对原图的缩放（可 >1，用于亚像素平滑） */
  function encode1bit(canvas, k, targetInk, tint) {
    var w = Math.max(1, Math.round(canvas.width * k));
    var h = Math.max(1, Math.round(canvas.height * k));
    var r = packInk(canvas, w, h, targetInk || 0, tint ? (tint.ratio || 0) : 0, tint || null);
    return Promise.all([deflate(r.bits), r.red ? deflate(r.red) : Promise.resolve(null)]).then(function (z) {
      if (!z[0]) return null;
      return {
        type: 'flate1bit', bytes: z[0], w: w, h: h, scale: k, raw: r.bits.length,
        bits: r.bits, ink: r.ink, chroma: r.chroma,
        red: !!r.red, redBytes: z[1], redBits: r.red,
        tint: tint ? tint.kind : null,
        tintColor: tint ? tint.color : null,
        tintRatio: tint ? (tint.ratio || 0) : 0
      };
    });
  }

  /** 体积超标时逐级缩小（保底用原尺寸之外的 0.92 / 0.84 …） */
  function shrink1bit(canvas, budget, base, tint) {
    var scales = [0.92, 0.84, 0.76, 0.68, 0.6];
    var t2 = tint ? { color: tint.color, kind: tint.kind, ratio: base.chroma } : null;
    function step() {
      if (i >= scales.length) return Promise.resolve(base);
      var s = scales[i++];
      return encode1bit(canvas, s, base.ink, t2).then(function (r) {
        // modified：缩放失败时继续尝试后续档位，不再把 null 当编码结果上传。
        if (!r) return step();
        if (r.bytes.length <= budget) return r;
        return step();
      });
    }
    var i = 0;
    return base.bytes.length <= budget ? Promise.resolve(base) : step();
  }

  /**
   * 无损校验：把 Flate 流解回来，与编码前的位图逐字节比对。
   * 这一步是"真实性"的凭据 —— 有损 JBIG2 的问题正在于页面里到底有没有
   * 被改过字，事后无法判定（马健《乱谈纯黑白（二值化）图像》）。
   * 我们用的是 Flate 无损压缩，且每次导出都把结果解回来验证一遍。
   */
  function verifyLossless(r) {
    if (!r || !r.bits) return Promise.resolve(r);
    var bits = r.bits, redBits = r.redBits;
    function same(orig, back) {
      // modified：解压结果长度不符属于损坏，必须判"失败"而不是"无法判定"，
      // 否则一条被截断的 Flate 流可以凭"验不了"混过导出前的拦截。
      if (!back) return null;                       // 环境不支持解压：无法判定
      if (back.length !== orig.length) return false;
      for (var i = 0; i < orig.length; i++) if (back[i] !== orig[i]) return false;
      return true;
    }
    return inflate(r.bytes).then(function (back) {
      var ok = same(bits, back);
      r.bits = null;
      if (!redBits) { r.verify = ok; r.redBits = null; return r; }
      return inflate(r.redBytes).then(function (back2) {
        var ok2 = same(redBits, back2);
        r.redBits = null;
        r.verify = (ok === true && ok2 === true) ? true : ((ok === null || ok2 === null) ? null : false);
        return r;
      });
    });
  }

  function jpegFit(canvas, budget) {
    var steps = [];
    var qs = [0.88, 0.8, 0.72, 0.64, 0.56, 0.48, 0.4, 0.32];
    var scales = [1, 0.9, 0.8, 0.7];
    scales.forEach(function (s) { qs.forEach(function (q) { steps.push([s, q]); }); });

    var best = null;
    var i = 0;
    function next() {
      if (i >= steps.length) return Promise.resolve(best);
      var s = steps[i][0], q = steps[i][1];
      i++;
      var w = Math.round(canvas.width * s), h = Math.round(canvas.height * s);
      var c = drawTo(canvas, w, h);
      return canvasJpeg(c, q).then(function (bytes) {
        if (!bytes) return next();
        if (!best || bytes.length < best.bytes.length) {
          best = { type: 'jpeg', bytes: bytes, w: w, h: h, q: q, scale: s, raw: bytes.length };
        }
        if (bytes.length <= budget) return best;
        return next();
      });
    }
    return next();
  }

  /* ---------------- PDF 组装 ---------------- */

  /* ---------------- 1 位 PNG（纯黑白页的无损图片导出） ---------------- */

  function pngChunk(type, data) {
    var out = new Uint8Array(12 + data.length);
    var dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  }

  /**
   * 纯黑白页存成 PNG 必须用 1 位灰度，不能走 canvas.toBlob：
   * 后者只会给 24 位图，一页 2600px 的页面要 270KB，而 1 位 PNG 只要 50KB 上下。
   * 灰度 PNG 里 0=黑、1=白，与 1-bit PDF 位图的极性一致。
   */
  function png1bit(canvas) {
    var w = canvas.width, h = canvas.height;
    var d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    var rb = Math.ceil(w / 8);
    var raw = new Uint8Array((rb + 1) * h);
    for (var y = 0; y < h; y++) {
      var o = y * (rb + 1);          // 每行首字节是 filter type = 0 (None)
      var so = o + 1, row = y * w;
      for (var x = 0; x < w; x++) {
        var p = (row + x) << 2;
        var lum = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
        if (lum >= 128) raw[so + (x >> 3)] |= (0x80 >> (x & 7));
      }
    }
    return deflate(raw).then(function (z) {
      if (!z) return null;
      var ihdr = new Uint8Array(13);
      var dv = new DataView(ihdr.buffer);
      dv.setUint32(0, w); dv.setUint32(4, h);
      ihdr[8] = 1;    // bit depth
      ihdr[9] = 0;    // color type: grayscale
      ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
      var parts = [
        new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', z),
        pngChunk('IEND', new Uint8Array(0))
      ];
      var total = 0, i;
      for (i = 0; i < parts.length; i++) total += parts[i].length;
      var out = new Uint8Array(total), pos = 0;
      for (i = 0; i < parts.length; i++) { out.set(parts[i], pos); pos += parts[i].length; }
      return out;
    });
  }

  function build(pages, meta) {
    meta = meta || {};
    var chunks = [], total = 0;
    function push(x) {
      var b = (typeof x === 'string') ? latin1(x) : x;
      chunks.push(b); total += b.length;
    }
    var offsets = [];
    function begin(n) { offsets[n] = total; }

    // 先定编号：带印章层的页要多一个 XObject
    var no = 3;
    pages.forEach(function (p) {
      p._page = ++no;
      p._cont = ++no;
      p._img = ++no;
      if (p.redBytes) p._mask = ++no;
    });

    /* 书签大纲：仿 PDF 补丁丁"根据文件名生成书签"。
     * 一次导入多个文件时，几百页扫描件没有目录几乎无法翻阅；
     * 大纲结构的成本极低（每个书签一个对象），值得默认给上。 */
    var bms = meta.bookmarks || [];
    var outNo = 0, bmNos = [];
    if (bms.length) {
      outNo = ++no;
      bms.forEach(function () { bmNos.push(++no); });
    }
    var count = no + 1;

    push('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n');

    // 1: Catalog
    begin(1);
    push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R' +
      (outNo ? ' /Outlines ' + outNo + ' 0 R' : '') + ' >>\nendobj\n');

    // 2: Pages
    var kids = pages.map(function (p) { return p._page + ' 0 R'; }).join(' ');
    begin(2);
    push('2 0 obj\n<< /Type /Pages /Count ' + pages.length + ' /Kids [' + kids + '] >>\nendobj\n');

    // 3: Info
    begin(3);
    var now = new Date();
    // modified：PDF 的 Z 后缀表示 UTC，字段必须同样使用 UTC，避免本地时间被误标。
    var ds = 'D:' + now.getUTCFullYear() +
      String(now.getUTCMonth() + 1).padStart(2, '0') + String(now.getUTCDate()).padStart(2, '0') +
      String(now.getUTCHours()).padStart(2, '0') + String(now.getUTCMinutes()).padStart(2, '0') + 'Z';
    push('3 0 obj\n<< /Title ' + hexUtf16(meta.title || '澄文扫描输出') +
      ' /Producer (Chengwen DocScan) /Creator (Chengwen DocScan) /CreationDate (' + ds + ') >>\nendobj\n');

    pages.forEach(function (p) {
      var pageNo = p._page, contNo = p._cont, imgNo = p._img;
      var pw = p.pageW, ph = p.pageH;
      var rect = 'q\n' + p.dw.toFixed(2) + ' 0 0 ' + p.dh.toFixed(2) + ' ' +
        p.dx.toFixed(2) + ' ' + p.dy.toFixed(2) + ' cm\n';
      var content = rect + '/Im0 Do\nQ\n';

      // 印章/红头层：/ImageMask 用当前填充色画，0 出墨、1 透明
      if (p.redBytes) {
        var c = p.tintColor || [200, 40, 50];
        var f = function (v) { return (Math.max(0, Math.min(255, v)) / 255).toFixed(4); };
        content += 'q\n' + f(c[0]) + ' ' + f(c[1]) + ' ' + f(c[2]) + ' rg\n' + rect + '/Im1 Do\nQ\n';
      }

      var res = '/XObject << /Im0 ' + imgNo + ' 0 R';
      if (p.redBytes) res += ' /Im1 ' + p._mask + ' 0 R';
      res += ' >>';

      begin(pageNo);
      push(pageNo + ' 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' +
        pw.toFixed(2) + ' ' + ph.toFixed(2) + '] /Resources << ' + res + ' >> /Contents ' +
        contNo + ' 0 R >>\nendobj\n');

      begin(contNo);
      var cbytes = latin1(content);
      push(contNo + ' 0 obj\n<< /Length ' + cbytes.length + ' >>\nstream\n');
      push(cbytes);
      push('\nendstream\nendobj\n');

      begin(imgNo);
      var dict = '<< /Type /XObject /Subtype /Image /Width ' + p.imgW + ' /Height ' + p.imgH +
        ' /ColorSpace /Device' + (p.type === 'flate1bit' ? 'Gray' : 'RGB') +
        ' /BitsPerComponent ' + (p.type === 'flate1bit' ? 1 : 8) +
        ' /Filter /' + (p.type === 'flate1bit' ? 'FlateDecode' : 'DCTDecode') +
        ' /Length ' + p.bytes.length + ' >>\nstream\n';
      push(imgNo + ' 0 obj\n' + dict);
      push(p.bytes);
      push('\nendstream\nendobj\n');

      if (p.redBytes) {
        begin(p._mask);
        push(p._mask + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + p.imgW +
          ' /Height ' + p.imgH + ' /ImageMask true /BitsPerComponent 1 /Decode [0 1]' +
          ' /Filter /FlateDecode /Length ' + p.redBytes.length + ' >>\nstream\n');
        push(p.redBytes);
        push('\nendstream\nendobj\n');
      }
    });

    /* 书签对象：/Dest 指向页对象的 /Fit，点开即整页适配窗口 */
    if (outNo) {
      begin(outNo);
      push(outNo + ' 0 obj\n<< /Type /Outlines /First ' + bmNos[0] + ' 0 R /Last ' +
        bmNos[bmNos.length - 1] + ' 0 R /Count ' + bmNos.length + ' >>\nendobj\n');
      bms.forEach(function (b, k) {
        var pg = pages[b.page] || pages[0];
        var s = bmNos[k] + ' 0 obj\n<< /Title ' + hexUtf16(b.title) + ' /Parent ' + outNo + ' 0 R';
        if (k > 0) s += ' /Prev ' + bmNos[k - 1] + ' 0 R';
        if (k < bmNos.length - 1) s += ' /Next ' + bmNos[k + 1] + ' 0 R';
        s += ' /Dest [' + pg._page + ' 0 R /Fit] >>\nendobj\n';
        begin(bmNos[k]);
        push(s);
      });
    }

    var xrefPos = total;
    var xref = 'xref\n0 ' + count + '\n0000000000 65535 f \n';
    for (var n = 1; n < count; n++) {
      var off = offsets[n] || 0;
      xref += String(off).padStart(10, '0') + ' 00000 n \n';
    }
    push(xref);
    push('trailer\n<< /Size ' + count + ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF\n');

    var out = new Uint8Array(total), pos = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], pos); pos += chunks[i].length; }
    return out;
  }

  /* ---------------- ZIP（store 模式） ---------------- */

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function zip(files) {
    // files: [{name, bytes}]
    var parts = [], central = [], offset = 0, i;
    function u16(v) { return [v & 0xff, (v >> 8) & 0xff]; }
    function u32(v) { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]; }

    files.forEach(function (f) {
      var nameBytes = new TextEncoder().encode(f.name);
      var crc = crc32(f.bytes);
      var local = [].concat([0x50, 0x4b, 0x03, 0x04], u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(f.bytes.length), u32(f.bytes.length), u16(nameBytes.length), u16(0));
      var head = new Uint8Array(local);
      parts.push(head, nameBytes, f.bytes);
      var cent = [].concat([0x50, 0x4b, 0x01, 0x02], u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(f.bytes.length), u32(f.bytes.length), u16(nameBytes.length),
        u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
      central.push(new Uint8Array(cent), nameBytes);
      offset += head.length + nameBytes.length + f.bytes.length;
    });

    var cdSize = 0;
    central.forEach(function (c) { cdSize += c.length; });
    var end = new Uint8Array([].concat([0x50, 0x4b, 0x05, 0x06], u16(0), u16(0),
      u16(files.length), u16(files.length), u32(cdSize), u32(offset), u16(0)));

    var total = offset + cdSize + end.length;
    var out = new Uint8Array(total), p = 0;
    parts.forEach(function (b) { out.set(b, p); p += b.length; });
    central.forEach(function (b) { out.set(b, p); p += b.length; });
    out.set(end, p);
    return out;
  }

  global.DocScanPDF = {
    encodePage: encodePage,
    build: build,
    zip: zip,
    pack1bit: pack1bit,
    png1bit: png1bit,
    scanColor: scanColor,
    _packInk: packInk    // 供自测/诊断读取阈值，不参与导出流程
  };
})(typeof window !== 'undefined' ? window : globalThis);
