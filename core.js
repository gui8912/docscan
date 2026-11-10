/* =============================================================
 * core.js — 文档扫描图像处理内核（纯浏览器，零依赖）
 *
 * 流水线
 *   ① 自动纠偏（deskew，可选）
 *   ② 透视矫正（四角检测 + 单应变换）
 *   ③ 光照场估计 + 除法归一化（去阴影 / 去底灰）
 *   ④ 局部自适应二值化（Sauvola 变体，背景归一化后）
 *   ⑤ 彩色墨保留（红头 / 印章，HSL 保色相）
 *   ⑥ 连通域去噪 + 墨量曲线 + 非锐化掩模
 *
 * 算法出处
 *   - Sauvola & Pietikäinen, "Adaptive document image binarization", PR 2000
 *   - Wolf & Jolion, "Text localization, enhancement and binarization", ICPR 2002
 *     （对比度归一化思想，DIBCO 上优于朴素 Sauvola）
 *   - Lu, Wang & Tan, "Fast skew detection based on projection profile", 2010
 *   - ScanTailor 的 "divide by background" 去底色思路
 *
 * 性能设计（相对 v1 的关键改动）
 *   - 块均值：行内顺序累加，替代跨行 strided 四重循环
 *   - 下采样：分离式两趟（水平→垂直），内层为指针步进累加
 *   - 阈值图：最近邻查询替代逐像素双线性（阈值本身平滑，无质量损失）
 *   - 合成：Uint32 视图整字写入白色，仅对墨像素走完整分支
 *   - 彩色判定：4bit/通道量化查表，替代逐像素 HSL 浮点运算
 * ============================================================= */
(function (global) {
  'use strict';

  var DEFAULTS = {
    mode: 'bleach',      // bleach 漂白 | gray 灰度 | color 彩色
    preset: 'standard',  // 二值化档位，见 PRESETS
    whitening: 1.0,      // 漂白强度 0.6 - 1.5
    textDark: 1.05,      // 文字加深 0.4 - 1.4
    shadow: 1.0,         // 去阴影 0 - 1.5
    denoise: 1,          // 去噪 0 - 2
    contrast: 1.0,       // 局部对比自适应 0.5 - 1.8
    sharpen: 0.35,       // 锐化 0 - 1
    keepColor: true,     // 保留红头 / 印章
    colorBoost: 1.0,     // 彩色浓度 0.6 - 1.6
    inkGrow: 0,          // 断笔接续 0 关 | 1 公文·仿宋 | 2 增强 | 3 旧版弱墨补偿
    deskew: 'auto',      // auto 自动 | off 关闭 | force 强制
    maxDim: 2000,        // 输出最长边
    trim: false,         // 裁白边（按墨迹外框）
    trimEdge: true,      // 去黑边：边缘暗带自动裁切
    edgeClean: 1         // 边缘净化（折痕 / 装订影）0 关 | 1 轻度 | 2 中度
  };

  /**
   * 二值化档位。窗宽是"短边的百分比"（半径单位同样是短边百分比），k 是 Sauvola 系数。
   * 书格社区《智能图像预处理工具》公开过一组 Wolf 算法的实测预设（win 41-71、k 0.22-0.38），
   * 但 Wolf 与 Sauvola 的 k 符号方向相反：Sauvola 的 t = mean·(1+k·(σ/R−1))，
   * k 越大阈值越低、出墨越少。所以"淡墨"要调小 k，"污渍抑制"要调大 k 并放大窗口。
   * 这五档按此换算并实测校准。
   */
  var PRESETS = {
    clean:    { win: 1.8, k: 0.13 },   // 干净：底色均匀、追求无杂点
    standard: { win: 2.2, k: 0.16 },   // 标准：默认均衡（与原默认参数一致）
    faded:    { win: 2.6, k: 0.09 },   // 淡墨：字迹浅淡、想多出墨
    stain:    { win: 3.2, k: 0.28 },   // 污渍：水渍霉斑多、要压住误判
    shadow:   { win: 1.8, k: 0.22 }    // 阴影：拍照阴影、装订线暗角
  };

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  // modified：条件判断走 global.performance，取值却用裸标识符 performance，
  // 是两条不同的解析路径；统一取 global 上的对象，严格模式下也不依赖隐式全局。
  function now() { return global.performance ? global.performance.now() : Date.now(); }

  /* ============================================================
   * 一、基础转换
   * ============================================================ */

  function toGray(data, w, h) {
    var n = w * h, g = new Float32Array(n), i, p = 0;
    for (i = 0; i < n; i++, p += 4) {
      g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }
    return g;
  }

  /**
   * 面积平均下采样（单趟 + 预算区间表）
   * 实测：分离式两趟在 V8 上反而更慢（中间缓冲的内存带宽开销 > 省下的重复读取），
   * 故保留单趟，仅把内层的区间计算换成查表。
   */
  function downsampleRGBA(src, sw, sh, maxDim) {
    // modified：空尺寸/非法 maxDim 会让 scale 变 NaN，进而产出 {w:NaN,h:NaN} 破坏
    // w/h/data 一致性契约；直接返回原数据的空副本，让调用方走正常空态。
    if (!(sw > 0 && sh > 0) || !isFinite(maxDim) || maxDim <= 0) {
      return { data: new Uint8ClampedArray(src), w: sw | 0, h: sh | 0 };
    }
    var scale = Math.min(1, maxDim / Math.max(sw, sh));
    // modified：早退分支原先直接 return src，而 process 会原地改写 data[p] *= gi。
    // 实测长边 2001px + maxDim 2000 时命中此分支（scale=0.9995），调用方的原始
    // 像素被改成 246；app.js 又复用同一份 warp 做预览与重处理，形成累积漂移。
    // 这里无条件复制一份，保证「纯函数」语义。
    if (scale >= 0.999) return { data: new Uint8ClampedArray(src), w: sw, h: sh };

    var dw = Math.max(1, Math.round(sw * scale));
    var dh = Math.max(1, Math.round(sh * scale));
    var x, y, i;

    var x0 = new Int32Array(dw), x1 = new Int32Array(dw), xinv = new Float32Array(dw);
    for (x = 0; x < dw; x++) {
      var a = (x * sw / dw) | 0;
      var b = Math.min(sw, Math.max(a + 1, ((x + 1) * sw / dw) | 0));
      x0[x] = a; x1[x] = b; xinv[x] = 1 / (b - a);
    }
    var y0 = new Int32Array(dh), y1 = new Int32Array(dh), yinv = new Float32Array(dh);
    for (y = 0; y < dh; y++) {
      var c = (y * sh / dh) | 0;
      var d = Math.min(sh, Math.max(c + 1, ((y + 1) * sh / dh) | 0));
      y0[y] = c; y1[y] = d; yinv[y] = 1 / (d - c);
    }

    var out = new Uint8ClampedArray(dw * dh * 4);
    for (y = 0; y < dh; y++) {
      var ya = y0[y], yb = y1[y];
      var kk = yinv[y], orow = y * dw << 2;
      for (x = 0; x < dw; x++) {
        var xa = x0[x], xb = x1[x];
        var r = 0, g = 0, bl = 0;
        for (var yy = ya; yy < yb; yy++) {
          var p = ((yy * sw) + xa) << 2;
          for (var xx = xa; xx < xb; xx++, p += 4) {
            r += src[p]; g += src[p + 1]; bl += src[p + 2];
          }
        }
        var k = kk * xinv[x], o = orow + (x << 2);
        out[o] = r * k; out[o + 1] = g * k; out[o + 2] = bl * k; out[o + 3] = 255;
      }
    }
    return { data: out, w: dw, h: dh };
  }

  /**
   * 快速灰度下采样（只读 G 通道，跨步采样）
   * 专供纠偏角度估计：角度是全局量，不需要精确的颜色与面积平均。
   * 比完整 RGBA 面积平均快 5-8 倍。
   */
  function downscaleGrayFast(src, sw, sh, maxDim) {
    var scale = Math.min(1, maxDim / Math.max(sw, sh));
    if (scale >= 0.999) {
      var g0 = new Float32Array(sw * sh);
      for (var q = 0, pp = 1; q < g0.length; q++, pp += 4) g0[q] = src[pp];
      return { g: g0, w: sw, h: sh };
    }
    var dw = Math.max(8, Math.round(sw * scale)), dh = Math.max(8, Math.round(sh * scale));
    var g = new Float32Array(dw * dh);
    var stepY = sh / dh, stepX = sw / dw;
    for (var y = 0; y < dh; y++) {
      var sy = (y * stepY) | 0;
      var srcRow = (sy * sw) << 2;
      var dstRow = y * dw;
      for (var x = 0; x < dw; x++) {
        g[dstRow + x] = src[srcRow + (((x * stepX) | 0) << 2) + 1];
      }
    }
    return { g: g, w: dw, h: dh };
  }

  function otsu(hist, total) {
    var sum = 0, i;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, maxVar = -1, best = 128;
    for (i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var v = wB * wF * (mB - mF) * (mB - mF);
      if (v > maxVar) { maxVar = v; best = i; }
    }
    return best;
  }

  /* ============================================================
   * 二、滤波（分离式 + 滑动窗口，全部 O(1)/像素）
   * ============================================================ */

  /** 水平方向极值/均值：滑动窗口，避免内层重复扫描 */
  function slideH(src, w, h, r, isMax) {
    var out = new Float32Array(w * h), x, y, k;
    for (y = 0; y < h; y++) {
      var row = y * w;
      for (x = 0; x < w; x++) {
        var lo = x - r < 0 ? 0 : x - r, hi = x + r >= w ? w - 1 : x + r;
        var m = src[row + lo];
        for (k = lo + 1; k <= hi; k++) {
          var v = src[row + k];
          if (isMax ? v > m : v < m) m = v;
        }
        out[row + x] = m;
      }
    }
    return out;
  }

  function slideV(src, w, h, r, isMax) {
    var out = new Float32Array(w * h), x, y, k;
    for (x = 0; x < w; x++) {
      for (y = 0; y < h; y++) {
        var lo = y - r < 0 ? 0 : y - r, hi = y + r >= h ? h - 1 : y + r;
        var m = src[lo * w + x];
        for (k = lo + 1; k <= hi; k++) {
          var v = src[k * w + x];
          if (isMax ? v > m : v < m) m = v;
        }
        out[y * w + x] = m;
      }
    }
    return out;
  }

  function maxFilter(src, w, h, r) { return slideV(slideH(src, w, h, r, true), w, h, r, true); }
  function minFilter(src, w, h, r) { return slideV(slideH(src, w, h, r, false), w, h, r, false); }

  /** 盒式模糊：滑动窗口累加，O(1)/像素（原实现为 O(r)） */
  function boxBlur(src, w, h, r) {
    if (r < 1) return src;
    var tmp = new Float32Array(w * h), out = new Float32Array(w * h), x, y;
    var inv = 1 / (2 * r + 1);
    for (y = 0; y < h; y++) {
      var row = y * w;
      var sum = 0, cnt = 0;
      // 初始化窗口 [0, r]
      for (x = 0; x <= r && x < w; x++) { sum += src[row + x]; cnt++; }
      for (x = 0; x < w; x++) {
        tmp[row + x] = sum / cnt;
        var add = x + r + 1, sub = x - r;
        if (add < w) { sum += src[row + add]; cnt++; }
        if (sub >= 0) { sum -= src[row + sub]; cnt--; }
      }
    }
    for (x = 0; x < w; x++) {
      var s2 = 0, c2 = 0;
      for (y = 0; y <= r && y < h; y++) { s2 += tmp[y * w + x]; c2++; }
      for (y = 0; y < h; y++) {
        out[y * w + x] = s2 / c2;
        var ya = y + r + 1, ys = y - r;
        if (ya < h) { s2 += tmp[ya * w + x]; c2++; }
        if (ys >= 0) { s2 -= tmp[ys * w + x]; c2--; }
      }
    }
    return out;
  }

  /**
   * 光照场估计：块均值 → 闭运算（吃掉文字）→ 双线性上采样
   * 块均值改为「逐行顺序累加」，取代原来跨行 strided 的四重循环。
   */
  function estimateBackground(gray, w, h) {
    var f = Math.max(2, Math.round(Math.min(w, h) / 180));
    var bw = Math.max(8, Math.floor(w / f)), bh = Math.max(8, Math.floor(h / f));
    var x, y;

    // 块边界
    var xs = new Int32Array(bw + 1), ys = new Int32Array(bh + 1);
    for (x = 0; x <= bw; x++) xs[x] = Math.min(w, Math.round(x * w / bw));
    for (y = 0; y <= bh; y++) ys[y] = Math.min(h, Math.round(y * h / bh));

    // 逐行累加到所属块行（顺序访问，替代跨行 strided 扫描）
    var acc = new Float32Array(bw * bh);
    for (y = 0; y < h; y++) {
      // 当前行属于哪个块行
      var by = 0;
      while (by < bh - 1 && y >= ys[by + 1]) by++;
      var row = y * w, base = by * bw;
      for (x = 0; x < bw; x++) {
        var a = xs[x], b = xs[x + 1], s = 0;
        for (var i = a; i < b; i++) s += gray[row + i];
        acc[base + x] += s;
      }
    }
    for (y = 0; y < bh; y++) {
      var hgt = ys[y + 1] - ys[y] || 1;
      for (x = 0; x < bw; x++) {
        var wid = xs[x + 1] - xs[x] || 1;
        acc[y * bw + x] /= (wid * hgt);
      }
    }

    // 闭运算：先膨胀吃掉文字笔画，再腐蚀回到背景
    var r = Math.max(1, Math.round(18 / f));
    var small = maxFilter(acc, bw, bh, r);
    small = minFilter(small, bw, bh, r);
    small = boxBlur(small, bw, bh, 1);

    // 双线性上采样（x 方向索引/权重预算，内层只查表）
    var bg = new Float32Array(w * h);
    var xi0 = new Int32Array(w), xi1 = new Int32Array(w), xw = new Float32Array(w);
    for (x = 0; x < w; x++) {
      var fx = (x + 0.5) * bw / w - 0.5;
      var x0i = Math.max(0, Math.floor(fx));
      var x1i = Math.min(bw - 1, x0i + 1);
      xi0[x] = x0i; xi1[x] = x1i; xw[x] = clamp(fx - x0i, 0, 1);
    }
    for (y = 0; y < h; y++) {
      var fy = (y + 0.5) * bh / h - 0.5;
      var y0i = Math.max(0, Math.floor(fy));
      var y1i = Math.min(bh - 1, y0i + 1);
      var wy = clamp(fy - y0i, 0, 1);
      var r0 = y0i * bw, r1 = y1i * bw, orow = y * w;
      for (x = 0; x < w; x++) {
        var l = xw[x], i0 = xi0[x], i1 = xi1[x];
        var a1 = small[r0 + i0] * (1 - l) + small[r0 + i1] * l;
        var a2 = small[r1 + i0] * (1 - l) + small[r1 + i1] * l;
        bg[orow + x] = a1 * (1 - wy) + a2 * wy;
      }
    }
    return bg;
  }

  /* ============================================================
   * 三、几何：单应与四角检测
   * ============================================================ */

  function gaussSolve(A, b, n) {
    for (var i = 0; i < n; i++) {
      var piv = i;
      for (var r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
      if (piv !== i) { var t = A[i]; A[i] = A[piv]; A[piv] = t; var tb = b[i]; b[i] = b[piv]; b[piv] = tb; }
      var d = A[i][i] || 1e-12;
      for (r = i + 1; r < n; r++) {
        var f = A[r][i] / d;
        if (!f) continue;
        for (var c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    var x = new Float64Array(n);
    for (i = n - 1; i >= 0; i--) {
      var s = b[i];
      for (var j = i + 1; j < n; j++) s -= A[i][j] * x[j];
      x[i] = s / (A[i][i] || 1e-12);
    }
    return x;
  }

  /** dst(矩形) -> src(四边形) 的单应矩阵，返回 8 元系数 */
  function homography(dstW, dstH, quad) {
    var dst = [{ x: 0, y: 0 }, { x: dstW, y: 0 }, { x: dstW, y: dstH }, { x: 0, y: dstH }];
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var x = dst[i].x, y = dst[i].y, u = quad[i].x, v = quad[i].y;
      A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
    }
    return gaussSolve(A, b, 8);
  }

  /**
   * 透视矫正
   *  - 行内用增量法推进 u/v 的分子分母（省掉每像素两次乘法）
   *  - 落在源图外的像素填白（对应桌面背景，避免边缘拉丝）
   */
  function warpPerspective(src, sw, sh, quad, outW, outH) {
    outW = Math.max(2, Math.round(outW)); outH = Math.max(2, Math.round(outH));
    var H = homography(outW, outH, quad);
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    var out = new Uint8ClampedArray(outW * outH * 4);
    var out32 = new Uint32Array(out.buffer);
    out32.fill(0xFFFFFFFF);

    // 向内收 0.5px：源图最外圈往往是纸张与桌面的混合像素，采到会在
    // 输出边缘留一条 1px 灰线
    var maxX = sw - 1.5, maxY = sh - 1.5;
    for (var y = 0; y < outH; y++) {
      var yy = y + 0.5;
      // x=0.5 处的初值 + 行内增量
      var numU = a * 0.5 + b * yy + c, dU = a;
      var numV = d * 0.5 + e * yy + f, dV = d;
      var den = g * 0.5 + h * yy + 1, dD = g;
      var orow = y * outW * 4;
      for (var x = 0; x < outW; x++) {
        var inv = den === 0 ? 1e9 : 1 / den;
        var u = numU * inv, v = numV * inv;
        numU += dU; numV += dV; den += dD;
        if (u < 0.5 || v < 0.5 || u > maxX || v > maxY) continue; // 已填白

        var x0 = u | 0, y0 = v | 0;
        var fx = u - x0, fy = v - y0;
        var x1 = x0 + 1, y1 = y0 + 1;
        if (x1 > sw - 1) x1 = sw - 1;
        if (y1 > sh - 1) y1 = sh - 1;
        var i00 = (y0 * sw + x0) << 2, i10 = (y0 * sw + x1) << 2;
        var i01 = (y1 * sw + x0) << 2, i11 = (y1 * sw + x1) << 2;
        var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
        var w01 = (1 - fx) * fy, w11 = fx * fy;
        var o = orow + (x << 2);
        out[o] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
        out[o + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
        out[o + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
      }
    }
    return { data: out, w: outW, h: outH };
  }

  function quadSize(quad) {
    function d(p, q) { return Math.hypot(p.x - q.x, p.y - q.y); }
    return {
      w: (d(quad[0], quad[1]) + d(quad[3], quad[2])) / 2,
      h: (d(quad[0], quad[3]) + d(quad[1], quad[2])) / 2
    };
  }

  function polyArea(q) {
    var a = 0;
    for (var i = 0; i < q.length; i++) {
      var p = q[i], r = q[(i + 1) % q.length];
      a += p.x * r.y - r.x * p.y;
    }
    return Math.abs(a) / 2;
  }

  function convexHull(pts) {
    if (pts.length < 3) return pts.slice();
    var p = pts.slice().sort(function (a, b) { return a.x === b.x ? a.y - b.y : a.x - b.x; });
    var cross = function (o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); };
    var lower = [], upper = [], i;
    for (i = 0; i < p.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p[i]) <= 0) lower.pop();
      lower.push(p[i]);
    }
    for (i = p.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
      upper.push(p[i]);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  /** 最小外接矩形（旋转卡壳的朴素版：遍历凸包每条边） */
  function minAreaRect(hull) {
    if (!hull || hull.length < 3) return null;
    var best = null;
    for (var i = 0; i < hull.length; i++) {
      var p1 = hull[i], p2 = hull[(i + 1) % hull.length];
      var ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
      var cs = Math.cos(-ang), sn = Math.sin(-ang);
      var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
      for (var j = 0; j < hull.length; j++) {
        var q = hull[j];
        var rx = q.x * cs - q.y * sn, ry = q.x * sn + q.y * cs;
        if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
        if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
      }
      var area = (maxX - minX) * (maxY - minY);
      if (!best || area < best.area) {
        best = { area: area, ang: ang, minX: minX, minY: minY, maxX: maxX, maxY: maxY };
      }
    }
    if (!best) return null;
    var cos = Math.cos(best.ang), sin = Math.sin(best.ang);
    function tr(x, y) { return { x: x * cos - y * sin, y: x * sin + y * cos }; }
    return [
      tr(best.minX, best.minY), tr(best.maxX, best.minY),
      tr(best.maxX, best.maxY), tr(best.minX, best.maxY)
    ];
  }

  /** 四角检测：光照归一化 → Otsu → 最大连通域 → 凸包 → 极值点 / 最小外接矩形 */
  function detectQuad(data, w, h) {
    var S = 720;
    var ds = downsampleRGBA(data, w, h, S);
    var sw = ds.w, sh = ds.h, d = ds.data;
    var gray = toGray(d, sw, sh);
    var n = sw * sh, i;

    // 先做光照归一化，避免阴影把纸面切成两半
    var bgS = estimateBackground(gray, sw, sh);
    for (i = 0; i < n; i++) {
      var b = bgS[i] < 12 ? 12 : bgS[i];
      gray[i] = gray[i] * 244 / b;
    }

    var hist = new Uint32Array(256);
    for (i = 0; i < n; i++) hist[clamp(gray[i], 0, 255) | 0]++;
    var thr = otsu(hist, n);

    var mask = new Uint8Array(n), cnt = 0;
    for (i = 0; i < n; i++) { if (gray[i] > thr) { mask[i] = 1; cnt++; } }
    var frac = cnt / n;
    if (frac < 0.12 || frac > 0.985) return null;

    // 最大连通域（4 邻域，显式栈）
    var label = new Int32Array(n);
    var stack = new Int32Array(n);
    var bestArea = 0, bestLabel = 0, cur = 0;
    for (i = 0; i < n; i++) {
      if (!mask[i] || label[i]) continue;
      cur++;
      var sp = 0, area = 0;
      stack[sp++] = i; label[i] = cur;
      while (sp) {
        var p = stack[--sp]; area++;
        var px = p % sw, py = (p / sw) | 0;
        if (px > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = cur; stack[sp++] = p - 1; }
        if (px < sw - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = cur; stack[sp++] = p + 1; }
        if (py > 0 && mask[p - sw] && !label[p - sw]) { label[p - sw] = cur; stack[sp++] = p - sw; }
        if (py < sh - 1 && mask[p + sw] && !label[p + sw]) { label[p + sw] = cur; stack[sp++] = p + sw; }
      }
      if (area > bestArea) { bestArea = area; bestLabel = cur; }
    }
    if (bestArea / n < 0.06) return null;

    // 边界点 → 凸包
    var pts = [];
    for (var y = 1; y < sh - 1; y++) {
      for (var x = 1; x < sw - 1; x++) {
        var idx = y * sw + x;
        if (label[idx] !== bestLabel) continue;
        if (label[idx - 1] !== bestLabel || label[idx + 1] !== bestLabel ||
          label[idx - sw] !== bestLabel || label[idx + sw] !== bestLabel) {
          pts.push({ x: x, y: y });
        }
      }
    }
    if (pts.length < 8) return null;
    var hull = convexHull(pts);
    if (hull.length < 4) return null;

    // 方案 A：极值点（能贴合透视梯形）
    var tl = null, tr = null, br = null, bl = null;
    var sMin = 1e9, sMax = -1e9, dMin = 1e9, dMax = -1e9;
    for (i = 0; i < hull.length; i++) {
      var hx = hull[i].x, hy = hull[i].y, s = hx + hy, dd = hx - hy;
      if (s < sMin) { sMin = s; tl = hull[i]; }
      if (s > sMax) { sMax = s; br = hull[i]; }
      if (dd > dMax) { dMax = dd; tr = hull[i]; }
      if (dd < dMin) { dMin = dd; bl = hull[i]; }
    }
    var quadA = [tl, tr, br, bl];
    var okA = true, sign = 0;
    for (i = 0; i < 4; i++) {
      var p1 = quadA[i], p2 = quadA[(i + 1) % 4], p3 = quadA[(i + 2) % 4];
      var cr = (p2.x - p1.x) * (p3.y - p2.y) - (p2.y - p1.y) * (p3.x - p2.x);
      if (Math.abs(cr) < 1e-6) { okA = false; break; }
      var sg = cr > 0 ? 1 : -1;
      if (sign === 0) sign = sg; else if (sg !== sign) { okA = false; break; }
    }
    var areaA = polyArea(quadA);

    // 方案 B：最小外接矩形（稳，但只能处理轻微透视）
    var quadB = minAreaRect(hull);
    var areaB = quadB ? polyArea(quadB) : 0;

    var quad;
    if (okA && areaA > areaB * 0.82 && areaA < n * 0.999) quad = quadA;
    else if (quadB) quad = quadB;
    else return null;

    if (polyArea(quad) < n * 0.14) return null;

    var kx = w / sw, ky = h / sh;
    return quad.map(function (q) { return { x: q.x * kx, y: q.y * ky }; });
  }

  /* ============================================================
   * 四、自动纠偏（deskew）
   *
   * 两级策略：
   *   1) 粗搜：降采样到长边 420，角度 ±8°、步长 1°，用切变投影的平方和打分
   *      （小角度下旋转≈切变，可省掉重采样；投影越"尖"说明文本行越对齐）
   *   2) 精搜：在粗解 ±1° 内、步长 0.1°，长边 760
   * 只在四角检测失败或角度明显时投入精搜，正常文档总开销 < 20ms。
   * ============================================================ */

  /**
   * 给定二值图与倾斜角，返回水平投影的集中度（越大越对齐）
   * 小角度下用切变近似旋转：把 (x,y) 的暗像素累加到 bin = y + x·tanθ，
   * 免去重采样，单趟即可完成，且投影 bin 只有一维。
   */
  function skewScore(bin, w, h, tanT, pad, bins) {
    var proj = new Int32Array(bins);
    var step = (tanT * 65536) | 0;      // 定点斜率
    for (var y = 0; y < h; y++) {
      var acc = 0, base = y + pad, row = y * w;
      for (var x = 0; x < w; x++) {
        // modified：TypedArray 越界写不抛错也不生效，会静默丢掉末尾若干列的打分。
        // pad/pad2 已按角度上界预留，这里再兜一层，避免将来改角度范围时复发。
        if (bin[row + x]) {
          var bi = base + (acc >> 16);
          if (bi >= 0 && bi < bins) proj[bi]++;
        }
        acc += step;
      }
    }
    // 平方和（总暗像素数固定，等价于方差）
    var s = 0;
    for (var i = 0; i < bins; i++) { var v = proj[i]; s += v * v; }
    return s;
  }

  function estimateSkew(data, w, h, maxDeg) {
    // modified：空图时 dark/n 是 0/0=NaN，后续所有比较恒假，会一路走到
    // 精搜并返回一个无意义的 -9°（实测）。入口直接返回 0 角。
    if (!(w > 0 && h > 0) || !data || data.length < w * h * 4) return 0;
    maxDeg = maxDeg || 8;
    var ds = downscaleGrayFast(data, w, h, 420);
    var sw = ds.w, sh = ds.h, gray = ds.g;
    var n = sw * sh, i;

    // 局部自适应阈值转为二值（比全局 Otsu 更能保留小字）
    var bg = estimateBackground(gray, sw, sh);
    var bin = new Uint8Array(n), dark = 0;
    for (i = 0; i < n; i++) {
      var norm = gray[i] * 240 / (bg[i] < 12 ? 12 : bg[i]);
      if (norm < 150) { bin[i] = 1; dark++; }
    }
    if (dark / n < 0.008 || dark / n > 0.42) return 0;  // 无文本或全是图，放弃

    var pad = Math.ceil(sw * Math.tan(maxDeg * Math.PI / 180)) + 2;
    var bins = sh + pad * 2;
    var bestA = 0, bestS = -1;

    // 粗搜：±maxDeg，步长 1°
    for (var a = -maxDeg; a <= maxDeg + 1e-9; a += 1) {
      var s = skewScore(bin, sw, sh, Math.tan(a * Math.PI / 180), pad, bins);
      if (s > bestS) { bestS = s; bestA = a; }
    }
    // 精搜：倾斜明显时换更高分辨率，在粗解 ±1° 内以 0.1° 细化
    if (Math.abs(bestA) >= 0.5) {
      var ds2 = downscaleGrayFast(data, w, h, 720);
      var sw2 = ds2.w, sh2 = ds2.h, gray2 = ds2.g;
      var bg2 = estimateBackground(gray2, sw2, sh2);
      var n2 = sw2 * sh2, bin2 = new Uint8Array(n2);
      for (i = 0; i < n2; i++) {
        var nm = gray2[i] * 240 / (bg2[i] < 12 ? 12 : bg2[i]);
        if (nm < 150) bin2[i] = 1;
      }
      // modified：精搜上界是 c+1，粗解 c 可达 ±maxDeg，实际角度会到 maxDeg+1。
    // pad2 原按 maxDeg 算，proj[base + (acc>>16)] 在 13° 时越界（TypedArray 静默丢弃），
    // 该角度得分被低估。按 maxDeg+1 预留余量即可覆盖两端。
    var pad2 = Math.ceil(sw2 * Math.tan((maxDeg + 1) * Math.PI / 180)) + 2;
      var bins2 = sh2 + pad2 * 2;
      var c = bestA, bestS2 = -1, bestA2 = c;
      for (var a2 = c - 1; a2 <= c + 1 + 1e-9; a2 += 0.1) {
        var s2 = skewScore(bin2, sw2, sh2, Math.tan(a2 * Math.PI / 180), pad2, bins2);
        if (s2 > bestS2) { bestS2 = s2; bestA2 = a2; }
      }
      bestA = bestA2;
    }

    return Math.abs(bestA) < 0.15 ? 0 : bestA;
  }

  /** 按角度旋转（输出画布扩张到能容纳整幅，空白填白；行内用增量推进） */
  function rotateRGBA(src, sw, sh, deg) {
    var t = deg * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
    var nw = Math.ceil(Math.abs(sw * cos) + Math.abs(sh * sin));
    var nh = Math.ceil(Math.abs(sw * sin) + Math.abs(sh * cos));
    var out = new Uint8ClampedArray(nw * nh * 4);
    var out32 = new Uint32Array(out.buffer);
    out32.fill(0xFFFFFFFF);
    var cx = sw / 2, cy = sh / 2, ncx = nw / 2, ncy = nh / 2;
    var maxX = sw - 1.001, maxY = sh - 1.001;
    var negSin = -sin;

    for (var y = 0; y < nh; y++) {
      var dy = y + 0.5 - ncy;
      // x=0.5 处的初值 + 行内增量（省掉每像素两次乘法）
      var u = (0.5 - ncx) * cos + dy * sin + cx;
      var v = (0.5 - ncx) * negSin + dy * cos + cy;
      var orow = y * nw << 2;
      for (var x = 0; x < nw; x++, u += cos, v += negSin) {
        if (u < 0 || v < 0 || u > maxX || v > maxY) continue;
        var x0 = u | 0, y0 = v | 0;
        var fx = u - x0, fy = v - y0;
        var x1 = x0 + 1, y1 = y0 + 1;
        if (x1 > sw - 1) x1 = sw - 1;
        if (y1 > sh - 1) y1 = sh - 1;
        var i00 = (y0 * sw + x0) << 2, i10 = (y0 * sw + x1) << 2;
        var i01 = (y1 * sw + x0) << 2, i11 = (y1 * sw + x1) << 2;
        var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        var o = orow + (x << 2);
        out[o] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
        out[o + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
        out[o + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
      }
    }
    return { data: out, w: nw, h: nh };
  }

  /* ============================================================
   * 五、颜色
   * ============================================================ */

  function rgb2hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    var l = (mx + mn) / 2, h = 0, s = 0;
    var d = mx - mn;
    if (d > 1e-6) {
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h: h, s: s, l: l };
  }

  function hsl2rgb(h, s, l) {
    if (s <= 0) { var v = l * 255; return [v, v, v]; }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    function hue(t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
  }

  /**
   * 彩色分类查表：RGB 各取高 4 位 → 4096 项
   *   0 = 中性（黑/灰/白）   1 = 红色系（红头、印章）   2 = 其他彩色（图表、蓝章、照片）
   * 用查表把逐像素的 HSL 浮点运算降为一次移位+一次数组访问，
   * 同时判断条件可以写得比内联版本更精细（区分浅黄底纹、橙、紫）。
   */
  var CLASS_LUT = (function () {
    var lut = new Uint8Array(4096);
    for (var ri = 0; ri < 16; ri++) {
      for (var gi = 0; gi < 16; gi++) {
        for (var bi = 0; bi < 16; bi++) {
          var r = ri * 17, g = gi * 17, b = bi * 17;
          var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          var chroma = mx - mn;
          var cls = 0;
          if (mx > 8 && chroma > 14) {
            // 色相（度）
            var hue;
            if (mx === mn) hue = 0;
            else if (mx === r) hue = 60 * (((g - b) / chroma) % 6);
            else if (mx === g) hue = 60 * ((b - r) / chroma + 2);
            else hue = 60 * ((r - g) / chroma + 4);
            if (hue < 0) hue += 360;
            var sat = chroma / mx, lum = mx / 255;
            // 红头/印章：色相落在红-橙红区间（含品红），且有一定饱和与亮度
            if ((hue >= 322 || hue <= 28) && sat > 0.16 && lum > 0.10) cls = 1;
            else if (chroma > 34 && sat > 0.20) cls = 2;  // 明显彩色但非红
          }
          lut[(ri << 8) | (gi << 4) | bi] = cls;
        }
      }
    }
    return lut;
  })();

  /** 只提饱和、几乎不动明度 —— 红头/印章"还是那个红" */
  function boostInkColor(r, g, b, amount) {
    var c = rgb2hsl(r, g, b);
    if (c.s < 0.06) return [r, g, b];
    var s2 = Math.min(1, c.s * (1 + 0.16 * amount) + 0.04 * amount);
    var l2 = c.l * (1 - 0.03 * amount);
    return hsl2rgb(c.h, s2, l2);
  }

  /* ============================================================
   * 六、二值化
   * ============================================================ */

  function integral(src, w, h) {
    var W = w + 1, I = new Float64Array(W * (h + 1)), x, y;
    for (y = 0; y < h; y++) {
      var rowSum = 0, srow = y * w, drow = (y + 1) * W;
      for (x = 0; x < w; x++) {
        rowSum += src[srow + x];
        I[drow + x + 1] = I[drow - W + x + 1] + rowSum;
      }
    }
    return I;
  }

  /** 半分辨率灰度（用于局部统计，省 3/4 的计算量） */
  function halfGray(gray, w, h) {
    var hw = (w + 1) >> 1, hh = (h + 1) >> 1;
    var g = new Float32Array(hw * hh), x, y;
    for (y = 0; y < hh; y++) {
      var r0 = Math.min(h - 1, y * 2) * w, r1 = Math.min(h - 1, y * 2 + 1) * w;
      for (x = 0; x < hw; x++) {
        var c0 = Math.min(w - 1, x * 2), c1 = Math.min(w - 1, x * 2 + 1);
        g[y * hw + x] = (gray[r0 + c0] + gray[r0 + c1] + gray[r1 + c0] + gray[r1 + c1]) * 0.25;
      }
    }
    return { g: g, w: hw, h: hh };
  }

  /** 局部均值 + 标准差 → Sauvola 阈值图 */
  function sauvolaMap(gray, w, h, kSau, winR) {
    var hg = halfGray(gray, w, h);
    var hw = hg.w, hh = hg.h, g = hg.g, i;
    var n2 = hw * hh;

    var sq = new Float32Array(n2);
    for (i = 0; i < n2; i++) sq[i] = g[i] * g[i];
    var I1 = integral(g, hw, hh), I2 = integral(sq, hw, hh);
    var W1 = hw + 1;

    var rr = winR > 0 ? winR : Math.max(4, Math.round(Math.min(hw, hh) * 0.022));
    var th = new Float32Array(n2);
    for (var y = 0; y < hh; y++) {
      var y0 = y - rr < 0 ? 0 : y - rr, y1 = y + rr >= hh ? hh - 1 : y + rr;
      var rowA = y0 * W1, rowB = (y1 + 1) * W1;
      for (var x = 0; x < hw; x++) {
        var x0 = x - rr < 0 ? 0 : x - rr, x1 = x + rr >= hw ? hw - 1 : x + rr;
        var area = (x1 - x0 + 1) * (y1 - y0 + 1);
        var s1 = I1[rowB + x1 + 1] - I1[rowA + x1 + 1] - I1[rowB + x0] + I1[rowA + x0];
        var s2 = I2[rowB + x1 + 1] - I2[rowA + x1 + 1] - I2[rowB + x0] + I2[rowA + x0];
        var mean = s1 / area;
        var varr = s2 / area - mean * mean;
        var sd = Math.sqrt(varr > 0 ? varr : 0);
        var t = mean * (1 + kSau * (sd / 128 - 1));
        // 平坦区强制拉高阈值 → 全白。
        // 必须同时要求该区足够亮（是纸面），否则会把照片、粗标题、
        // 实心印章这类"大面积低对比度的暗区"整体反转成白纸。
        if (sd < 6 && mean > 150) t = Math.max(t, mean * 0.88);
        th[y * hw + x] = t;
      }
    }
    return { th: th, w: hw, h: hh };
  }

  /* ============================================================
   * 七、后处理
   * ============================================================ */

  /**
   * 删除孤立小连通域：只清面积 < minSize 的斑点，不侵蚀笔画
   * 传入 inkIdx 后只从墨迹像素出发做 BFS，省掉对整个画布的扫描。
   */
  function removeSpecks(alpha, w, h, minSize, inkIdx, inkN) {
    var NS = w * h;
    var visited, seeds, seedN;
    if (inkIdx && inkN !== undefined) {
      visited = new Uint8Array(NS);
      seeds = inkIdx; seedN = inkN;
    } else {
      // 兼容旧签名：自行扫描
      seeds = new Int32Array(NS); seedN = 0;
      for (var q = 0; q < NS; q++) if (alpha[q] >= 0.5) seeds[seedN++] = q;
      visited = new Uint8Array(NS);
    }
    var stack = new Int32Array(seedN + 1);
    var pts = new Int32Array(minSize + 1);
    var last = NS - w;

    for (var s = 0; s < seedN; s++) {
      var start = seeds[s];
      if (visited[start] || alpha[start] < 0.5) continue;
      var sp = 0, cnt = 0, overflow = false;
      stack[sp++] = start; visited[start] = 1;
      while (sp) {
        var p = stack[--sp];
        if (!overflow) {
          if (cnt < minSize) pts[cnt] = p; else overflow = true;
        }
        cnt++;
        var px = p % w;
        if (px > 0 && alpha[p - 1] >= 0.5 && !visited[p - 1]) { visited[p - 1] = 1; stack[sp++] = p - 1; }
        if (px < w - 1 && alpha[p + 1] >= 0.5 && !visited[p + 1]) { visited[p + 1] = 1; stack[sp++] = p + 1; }
        if (p >= w && alpha[p - w] >= 0.5 && !visited[p - w]) { visited[p - w] = 1; stack[sp++] = p - w; }
        if (p < last && alpha[p + w] >= 0.5 && !visited[p + w]) { visited[p + w] = 1; stack[sp++] = p + w; }
      }
      if (!overflow && cnt < minSize) {
        for (var k = 0; k < cnt; k++) alpha[pts[k]] = 0;
      }
    }
    return alpha;
  }

  /* ============================================================
   * 断笔接续（2.4.7 新增）：方向性条件桥接
   * ------------------------------------------------------------
   * 旧 4.2 段只遍历 inkIdx（alpha>0.02 的墨迹像素），纯白断口根本不在表里；
   * 3x3 全向 maxFilter 又把笔画末端朝四面一起拉粗。结果是"名为接续、实为提亮
   * 淡墨"，断口没接上、字却变粗（README 原本就注明了这一副作用）。
   *
   * 借鉴的公开方案：
   *   - 线形结构元闭运算 strel('line', L, θ)：中文横排取 0°/90°，撇捺取 ±45°，
   *     比 3x3 方形核更少糊住笔画交叉处（MATLAB/OpenCV 文档二值化常规做法）。
   *   - 笔刷算法：按 1D 游程桥接相邻笔画，而不是全局膨胀（《自然场景下基于
   *     连通域检测的文字识别算法研究》）。
   *   - 骨架端点方向配对 + B 样条插值重建：先判走势、再补笔画（汉字细化文献、
   *     K-P 算法用 PCA 判断断点是否该连），避免把字间距当断口。
   *   - CN122113840B：形态学核大小随"平均笔画宽度 / 渲染分辨率"动态调整。
   *     本实现用水平实心游程的中位数估计笔画宽度：常规 2px 上限；
   *     只有笔画芯部真的只剩 1px 的极小字才降到 1px，避免把相邻字接上。
   *     注意「仿宋笔画细」不等于「分辨率低」，不能用笔画细来压断口上限
   *     （实机回归两次踩过这个坑，见 4.2 段的记录）。
   *   - Leptonica binary morphology 的边界约定：图外一律视为 OFF（留白），
   *     所以每条扫描线都在图像边界处自然终止，不会从边界"借"墨进来。
   *
   * 与档案保真的边界：这里补的是"扫描/二值化造成的 1~2px 断口"，不是造新笔画；
   * 上限远小于中文字间距，且默认关闭。真正决定笔画圆润的是灰度中间调与
   * 放大后二值化（见 pdfout.js encode1bit），本函数不磨圆仿宋的斜势棱角与尖峰。
   * ============================================================ */

  /** 用水平实心游程的中位数估计主笔画宽度；样本太少返回 0（调用方退回保守档）。 */
  function estimateStrokeWidth(alpha, w, h, solidThr) {
    var hist = new Int32Array(13), total = 0, x, y, run, s, acc, L;
    for (y = 0; y < h; y++) {
      var row = y * w;
      run = 0;
      for (x = 0; x <= w; x++) {
        s = x < w && alpha[row + x] >= solidThr;
        if (s) run++;
        else {
          if (run > 0 && run <= 12) { hist[run]++; total++; }
          run = 0;
        }
      }
    }
    if (total < 24) return 0;
    acc = 0;
    for (L = 1; L <= 12; L++) {
      acc += hist[L];
      if (acc * 2 >= total) return L;
    }
    return 0;
  }

  /**
   * 沿一条扫描线找「实心游程 → 短断口 → 实心游程」并补一段软过渡墨。
   * 补的 alpha 两端略强、中间略弱，1bit 阈值后呈细腰而不是一根方棍；
   * 多方向补到同一像素时只取最大值，不累加，避免交叉处异常变黑。
   */
  function bridgeLine(alpha, solid, line, len, cfg, touched, added, runS, runE) {
    var t = 0, rn = 0, q, g, idx, val, fall, base, gap, lE, rS, mid;
    while (t < len) {
      while (t < len && !solid[line[t]]) t++;
      if (t >= len) break;
      runS[rn] = t;
      while (t < len && solid[line[t]]) t++;
      runE[rn] = t;
      rn++;
    }
    for (q = 0; q + 1 < rn; q++) {
      if (runE[q] - runS[q] < cfg.minRun || runE[q + 1] - runS[q + 1] < cfg.minRun) continue;
      lE = runE[q]; rS = runS[q + 1]; gap = rS - lE;
      if (gap < 1 || gap > cfg.maxGap) continue;
      base = Math.min(alpha[line[lE - 1]], alpha[line[rS]]);
      mid = (gap + 1) / 2;
      for (g = 0; g < gap; g++) {
        idx = line[lE + g];
        // 已经有一定墨量的像素允许被抬高，但不覆盖原始实心笔画
        if (solid[idx]) continue;
        fall = 0.94 - 0.14 * Math.abs((g + 1) - mid) / mid;
        val = Math.max(0.6, Math.min(base * fall, 0.95));
        if (val > base) val = base;   // 桥接处不应比两端笔画芯部更黑
        if (alpha[idx] < val) alpha[idx] = val;
        if (!touched[idx]) { touched[idx] = 1; added.push(idx); }
      }
    }
  }

  /**
   * 四方向（0° / 90° / +45° / -45°）条件桥接。
   * @return 新增（被补过墨）的像素索引数组，调用方需并入 inkIdx。
   */
  function bridgeGaps(alpha, w, h, cfg) {
    var n = w * h;
    var maxLen = Math.max(w, h);
    var line = new Int32Array(maxLen);
    var runS = new Int32Array((maxLen >> 1) + 2);
    var runE = new Int32Array((maxLen >> 1) + 2);
    // modified：实心判据必须冻结在「补墨之前」的原始快照上。若四条方向边改边判，
    // 水平方向补出的 0.89 会被垂直方向当成新端点，继续往外补，形成连锁扩张、把字变粗。
    var solid = new Uint8Array(n);
    for (var si = 0; si < n; si++) solid[si] = alpha[si] >= cfg.solid ? 1 : 0;
    var touched = new Uint8Array(n);
    var added = [];
    var x, y, startY, startX;

    // 0° 水平
    for (y = 0; y < h; y++) {
      var row = y * w;
      for (x = 0; x < w; x++) line[x] = row + x;
      bridgeLine(alpha, solid, line, w, cfg, touched, added, runS, runE);
    }
    // 90° 垂直
    for (x = 0; x < w; x++) {
      for (y = 0; y < h; y++) line[y] = y * w + x;
      bridgeLine(alpha, solid, line, h, cfg, touched, added, runS, runE);
    }
    // +45°（右下）：起点在第一行与第一列
    for (startX = 0; startX < w; startX++) { lineDiag(0, startX, 1, 1, w, h); }
    for (startY = 1; startY < h; startY++) { lineDiag(startY, 0, 1, 1, w, h); }
    // -45°（右上）：起点在第一列与最后一行；方向 (1,-1) 才是与 +45° 正交的一族
    for (startY = 0; startY < h; startY++) { lineDiag(startY, 0, 1, -1, w, h); }
    for (startX = 1; startX < w; startX++) { lineDiag(h - 1, startX, 1, -1, w, h); }

    function lineDiag(sy, sx, stepX, stepY, W, H) {
      var len2 = 0, px = sx, py = sy;
      while (px >= 0 && px < W && py >= 0 && py < H) {
        line[len2++] = py * W + px;
        px += stepX; py += stepY;
      }
      if (len2 >= 2) bridgeLine(alpha, solid, line, len2, cfg, touched, added, runS, runE);
    }
    return added;
  }

  function inkBBox(alpha, w, h) {
    var minX = w, minY = h, maxX = -1, maxY = -1;
    for (var y = 0; y < h; y++) {
      var row = y * w;
      for (var x = 0; x < w; x++) {
        if (alpha[row + x] > 0.25) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  function crop(res, x0, y0, cw, ch) {
    var out = new Uint8ClampedArray(cw * ch * 4);
    for (var y = 0; y < ch; y++) {
      var s = ((y + y0) * res.w + x0) << 2, d = y * cw << 2;
      out.set(res.data.subarray(s, s + (cw << 2)), d);
    }
    return { data: out, w: cw, h: ch, stats: res.stats };
  }

  function cropRaw(data, w, h, x0, y0, cw, ch) {
    if (x0 === 0 && y0 === 0 && cw === w && ch === h) return data;
    var out = new Uint8ClampedArray(cw * ch * 4), rb = cw << 2;
    for (var y = 0; y < ch; y++) {
      var s = ((y + y0) * w + x0) << 2;
      out.set(data.subarray(s, s + rb), y * rb);
    }
    return out;
  }

  /* modified：2.4.10 — 全篇「识别范围」(ROI)。
   * 相对坐标 {x,y,w,h} ∈ [0,1]，作用在四角校正之后、任何识别/增强之前：
   * 框外像素被物理裁掉，页眉、页码、装订孔、边缘黑边根本不进入
   * 背景估计、Sauvola 阈值、墨量统计、去噪与自动裁白边。
   * 借鉴 ScanTailor Advanced 的 content box 与 unpaper 的 --border，
   * 但这里是「裁掉」而不是「涂白」：1bit 输出里不存在被掩盖的内容。
   * 与「裁白边 / 统一裁切」正交：ROI 先切掉不需要的区域，之后才按剩余墨迹求框。 */
  var ROI_MIN = 0.02;

  /** 归一化相对框；非法 / 过小 / 覆盖整页一律返回 null（= 不启用）。 */
  function normROI(r) {
    if (!r || typeof r !== 'object') return null;
    var x = +r.x, y = +r.y, w = +r.w, h = +r.h;
    if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return null;
    x = x < 0 ? 0 : (x > 1 ? 1 : x);
    y = y < 0 ? 0 : (y > 1 ? 1 : y);
    w = w < 0 ? 0 : (w > 1 ? 1 : w);
    h = h < 0 ? 0 : (h > 1 ? 1 : h);
    if (x + w > 1) w = 1 - x;
    if (y + h > 1) h = 1 - y;
    if (x >= 1 || y >= 1 || w < ROI_MIN || h < ROI_MIN) return null;
    // 覆盖整页时视为「未启用」，省掉一次全图拷贝
    if (x <= 0 && y <= 0 && w >= 1 && h >= 1) return null;
    return { x: x, y: y, w: w, h: h };
  }

  /** 按相对框物理裁 RGBA。返回 {data,w,h,rect,cut}；cut=false 时 data 是原引用。 */
  function cropROI(data, w, h, r) {
    var full = { data: data, w: w, h: h, rect: { x: 0, y: 0, w: w, h: h }, cut: false };
    var q = normROI(r);
    if (!q || !(w > 0) || !(h > 0) || !data || data.length < w * h * 4) return full;
    var x0 = Math.round(q.x * w), y0 = Math.round(q.y * h);
    var cw = Math.max(1, Math.round(q.w * w)), ch = Math.max(1, Math.round(q.h * h));
    x0 = Math.max(0, Math.min(w - 1, x0));
    y0 = Math.max(0, Math.min(h - 1, y0));
    if (x0 + cw > w) cw = w - x0;
    if (y0 + ch > h) ch = h - y0;
    if (cw < 1 || ch < 1) return full;
    if (x0 === 0 && y0 === 0 && cw === w && ch === h) return full;
    var out = new Uint8ClampedArray(cw * ch * 4), rb = cw << 2;
    for (var y = 0; y < ch; y++) {
      var s = ((y + y0) * w + x0) << 2;
      out.set(data.subarray(s, s + rb), y * rb);
    }
    return { data: out, w: cw, h: ch, rect: { x: x0, y: y0, w: cw, h: ch }, cut: true };
  }

  function cropFloat(src, w, h, x0, y0, cw, ch) {
    if (x0 === 0 && y0 === 0 && cw === w && ch === h) return src;
    var out = new Float32Array(cw * ch);
    for (var y = 0; y < ch; y++) {
      var s = (y + y0) * w + x0;
      out.set(src.subarray(s, s + cw), y * cw);
    }
    return out;
  }

  // modified：2.4.9 — 裁白边改为「先算框、再按框裁」，框随结果返回，
  // 上层据此可以做「统一裁切」：全篇共用一个框 → 各页输出尺寸一致、版心对齐。
  // 返回 {x,y,w,h,cut}；cut=false 表示无需裁（禁用 / 空白页 / 墨迹几乎铺满整页）。
  function trimBox(alpha, w, h, enabled) {
    var full = { x: 0, y: 0, w: w, h: h, cut: false };
    if (!enabled) return full;
    var bb = inkBBox(alpha, w, h);
    if (!bb) return full;
    // 墨迹几乎铺满整页时不能裁：此时的「白边」其实是内容，裁下去会切到字。
    if (bb.w >= w * 0.98 && bb.h >= h * 0.98) return full;
    var pad = Math.round(Math.min(w, h) * 0.012);
    var x0 = Math.max(0, bb.x - pad), y0 = Math.max(0, bb.y - pad);
    var x1 = Math.min(w, bb.x + bb.w + pad), y1 = Math.min(h, bb.y + bb.h + pad);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, cut: true };
  }

  // modified：连续调与漂白共享同一裁白边入口和留白规则。
  // box / preW / preH 一定挂在返回值上（即使没裁），否则调用方无法把「已裁画布」
  // 放回整页坐标系，统一裁切时会算错偏移。
  function trimInk(res, alpha, w, h, enabled) {
    var b = trimBox(alpha, w, h, enabled);
    res.box = b;
    res.preW = w;
    res.preH = h;
    if (!b.cut) return res;
    var out = crop(res, b.x, b.y, b.w, b.h);
    out.box = b;
    out.preW = w;
    out.preH = h;
    return out;
  }

  /* modified：2.4.9 — 全篇统一裁切框（纯函数，便于 Node 自检直接覆盖）。
   * items: [{ key, preW, preH, box:{x,y,w,h} }]（key 由调用方给，通常是页 id）
   * 返回 { w, h, rects:{key:{x,y,w,h}}, count, skipped } 或 null（有效页不足 2 页）。
   *
   * 规则：
   *  ① 取 preW 居中的那页为基准，个别被裁歪的页带不偏基准；
   *  ② 只收与基准尺寸差 ≤ tol 的页 —— 开了「检测纸张边缘」时，透视校正后
   *     每页尺寸本来就会差几像素，卡死"完全相等"会让功能形同虚设。
   *     容差默认 1.5%（小于墨迹外框自带的 1.2% 留白余量）：超出这个比例，
   *     被夹小的那一圈就会啃到正文，而不是只啃白边。
   *  ③ 并集用相对坐标求：各页像素尺寸不同，直接比像素会整体错位；
   *  ④ 目标尺寸夹到组内最小页，保证每页都真能裁出来 —— 宁可多切几条空白边，
   *     也不能裁出一个本页没有的区域（那会切掉正文）。
   * 不做重采样：各页裁成同一像素尺寸，只是把窗口平移/对齐。 */
  function unifyCrop(items, tol) {
    var list = [], i;
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.box || !(it.preW > 0) || !(it.preH > 0)) continue;
      list.push(it);
    }
    if (list.length < 2) return null;

    var t = tol > 0 ? tol : 0.015;
    var sorted = list.slice().sort(function (a, b) { return a.preW - b.preW; });
    var ref = sorted[sorted.length >> 1];
    var refW = ref.preW, refH = ref.preH;

    var group = [];
    for (i = 0; i < list.length; i++) {
      var p = list[i];
      if (Math.abs(p.preW - refW) <= refW * t && Math.abs(p.preH - refH) <= refH * t) group.push(p);
    }
    if (group.length < 2) return null;

    var rx0 = 1, ry0 = 1, rx1 = 0, ry1 = 0, minW = Infinity, minH = Infinity;
    for (i = 0; i < group.length; i++) {
      var q = group[i];
      var bx0 = q.box.x / q.preW, by0 = q.box.y / q.preH;
      var bx1 = (q.box.x + q.box.w) / q.preW, by1 = (q.box.y + q.box.h) / q.preH;
      if (bx0 < rx0) rx0 = bx0;
      if (by0 < ry0) ry0 = by0;
      if (bx1 > rx1) rx1 = bx1;
      if (by1 > ry1) ry1 = by1;
      if (q.preW < minW) minW = q.preW;
      if (q.preH < minH) minH = q.preH;
    }

    var tw = Math.min(minW, Math.max(1, Math.round((rx1 - rx0) * refW)));
    var th = Math.min(minH, Math.max(1, Math.round((ry1 - ry0) * refH)));
    var cxr = (rx0 + rx1) / 2, cyr = (ry0 + ry1) / 2;

    var rects = {};
    for (i = 0; i < group.length; i++) {
      var pg = group[i];
      // 以并集中心对齐，再夹回本页内：各页内容在最终页面里的相对位置才一致
      var x = Math.round(cxr * pg.preW - tw / 2);
      var y = Math.round(cyr * pg.preH - th / 2);
      x = Math.max(0, Math.min(pg.preW - tw, x));
      y = Math.max(0, Math.min(pg.preH - th, y));
      rects[pg.key] = { x: x, y: y, w: tw, h: th };
    }
    return { w: tw, h: th, rects: rects, count: group.length, skipped: list.length - group.length };
  }

  // modified：灰度/彩色使用独立连续调流水线，不再进入 Sauvola 二值化。
  /** 灰度/彩色走连续调流水线：不做局部二值化，不侵蚀照片高光与中间调。 */
  function processContinuous(data, gray, w, h, o) {
    var n = w * h, out = new Uint8ClampedArray(n * 4);
    var out32 = new Uint32Array(out.buffer);
    out32.fill(0xFFFFFFFF);
    var alpha = new Float32Array(n);
    var color = o.mode === 'color';
    var cc = 1 + (o.contrast - 1) * 0.35;
    var sa = 1 + (o.colorBoost - 1) * 0.5;
    var inkCount = 0;
    for (var i = 0; i < n; i++) {
      var p = i << 2, r = data[p], g = data[p + 1], b = data[p + 2];
      var lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (color) {
        out[p] = clamp((lum + (r - lum) * sa - 128) * cc + 128, 0, 255);
        out[p + 1] = clamp((lum + (g - lum) * sa - 128) * cc + 128, 0, 255);
        out[p + 2] = clamp((lum + (b - lum) * sa - 128) * cc + 128, 0, 255);
      } else {
        var v = clamp((lum - 128) * cc + 128, 0, 255);
        out[p] = v; out[p + 1] = v; out[p + 2] = v;
      }
      alpha[i] = clamp((246 - gray[i]) / 246, 0, 1);
      if (alpha[i] > 0.02) inkCount++;
    }
    var res = { data: out, w: w, h: h, stats: { inkRatio: inkCount / n } };
    return trimInk(res, alpha, w, h, o.trim);
  }

  /* ============================================================
   * 七点六、边缘暗带（黑边 / 灰边）检测与裁切
   *
   * 黑边有两个来源：原稿小于扫描幅面时盖板/玻璃的暗区；复印机边缘遮光。
   * 它有三条可判定的特征——紧贴图像边界、沿边界连续、亮度显著低于纸面。
   * 正文不会同时满足这三条，因此不需要"找纸张轮廓"这一步。
   *
   * 判据全部相对"纸面参考亮度"给出，所以欠曝、偏灰的扫描件同样成立。
   * ============================================================ */

  /** 纸面参考亮度：直方图自亮端向下累积 45% 处的灰度。分位数比峰值抗反光白斑。 */
  function paperLevel(gray, w, h) {
    var hist = new Uint32Array(256);
    var total = w * h, step = Math.max(1, (total / 160000) | 0);
    var cnt = 0, i, v;
    for (i = 0; i < total; i += step) {
      v = gray[i] | 0;
      hist[v < 0 ? 0 : (v > 255 ? 255 : v)]++;
      cnt++;
    }
    var acc = 0, lvl = 0;
    for (v = 255; v >= 0; v--) {
      acc += hist[v];
      if (acc >= cnt * 0.45) { lvl = v; break; }
    }
    return lvl;
  }

  /**
   * 检测四边暗带厚度。
   * 迭代剥离：先裁一侧，其余侧的行/列统计立刻变干净，L 形黑边也能对齐。
   */
  function detectEdgeTrim(gray, w, h, o) {
    var paper = paperLevel(gray, w, h);
    if (paper < 96) return null;                 // 整幅过暗，无从判定

    var darkT = paper * 0.62;                    // 单像素算"暗"
    var meanT = paper * 0.87;                    // 整行/列算"偏暗"
    var maxFrac = o.edgeMax || 0.10;
    var maxDY = Math.max(3, Math.round(h * maxFrac));
    var maxDX = Math.max(3, Math.round(w * maxFrac));

    var x0 = 0, y0 = 0, x1 = w, y1 = h;

    function scanH(ys, dir, limit) {
      var span = x1 - x0;
      if (span < 8 || limit <= 0) return 0;
      var n = 0, miss = 0;
      for (var k = 0; k < limit; k++) {
        var y = ys + dir * k;
        if (y < 0 || y >= h) break;
        var row = y * w, sum = 0, dk = 0;
        for (var x = x0; x < x1; x++) {
          var g = gray[row + x];
          sum += g;
          if (g < darkT) dk++;
        }
        if (sum / span < meanT && dk / span > 0.38) { n = k + 1; miss = 0; }
        else if (++miss >= 3) break;             // 容许 2 行灰尘/白点，第 3 行干净即收手
      }
      return n;
    }

    function scanV(xs, dir, limit) {
      var span = y1 - y0;
      if (span < 8 || limit <= 0) return 0;
      var n = 0, miss = 0;
      for (var k = 0; k < limit; k++) {
        var x = xs + dir * k;
        if (x < 0 || x >= w) break;
        var sum = 0, dk = 0;
        for (var y = y0; y < y1; y++) {
          var g = gray[y * w + x];
          sum += g;
          if (g < darkT) dk++;
        }
        if (sum / span < meanT && dk / span > 0.38) { n = k + 1; miss = 0; }
        else if (++miss >= 3) break;
      }
      return n;
    }

    var cut = { t: 0, r: 0, b: 0, l: 0 };
    for (var pass = 0; pass < 4; pass++) {
      var moved = false;
      var t = scanH(y0, +1, maxDY - cut.t);
      if (t > 0) { cut.t += t; y0 += t; moved = true; }
      var b = scanH(y1 - 1, -1, maxDY - cut.b);
      if (b > 0) { cut.b += b; y1 -= b; moved = true; }
      var l = scanV(x0, +1, maxDX - cut.l);
      if (l > 0) { cut.l += l; x0 += l; moved = true; }
      var r = scanV(x1 - 1, -1, maxDX - cut.r);
      if (r > 0) { cut.r += r; x1 -= r; moved = true; }
      if (!moved) break;
    }

    // 保护：裁掉四分之一以上说明判据失效（多半是整页偏暗或有大幅插图）
    if (x1 - x0 < w * 0.78 || y1 - y0 < h * 0.78) return null;

    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, cut: cut, paper: paper };
  }

  /**
   * 清除边缘的折痕线 / 扫描杂线
   *
   * 判据三条同时满足才删：
   *   ① 连通域完全落在"距边 d 以内"的环带里（正式文件版心距纸边 ≥20mm，d 只取 5~6mm）
   *   ② 细长：长宽比 > 6（折痕、盖板黑线都是线；文字笔画是小方块）。
   *      取 6 而不是 4，是宁可留下一条折痕，也不误删贴边的细长框线。
   *   ③ 不接触环带边界（跨出环带的是贴边表格框线、出血图，一律保留）
   *
   * 不用"按到边距离乘权重做软衰减"：折痕的硬阴影 alpha 接近 1，
   * 乘任何小于 1 的系数之后仍然是墨，要么保留要么删除，没有中间态。
   */
  function clearEdgeBlobs(alpha, w, h, d) {
    if (d < 2) return 0;
    var n = w * h;
    var mark = new Uint8Array(n);          // 0 未定 | 1 保留 | 2 删除 | 3 本轮已入队
    var stack = new Int32Array(8192);
    var cells = new Int32Array(8192);
    var removed = 0, x, y, i;
    var sd = [0, 0, 0, 0];                 // 被删折痕触及的边：上 右 下 左

    var dxA = new Int32Array(w), dyA = new Int32Array(h);
    for (x = 0; x < w; x++) dxA[x] = x < w - 1 - x ? x : w - 1 - x;
    for (y = 0; y < h; y++) dyA[y] = y < h - 1 - y ? y : h - 1 - y;

    for (y = 0; y < h; y++) {
      var dyv = dyA[y], full = dyv < d;
      for (var seg = 0; seg < (full ? 1 : 2); seg++) {
        var sx = full ? 0 : (seg === 0 ? 0 : w - d);
        var ex = full ? w : (seg === 0 ? d : w);
        for (x = sx; x < ex; x++) {
          i = y * w + x;
          if (mark[i] || alpha[i] <= 0.25) continue;

          /* --- 标记一个连通域，同时记录外框 --- */
          var sp = 0, cnt = 0, escaped = false;
          var bx0 = w, bx1 = -1, by0 = h, by1 = -1;
          stack[sp++] = i; mark[i] = 3;
          while (sp > 0) {
            var cur = stack[--sp];
            if (cnt >= cells.length) {
              var cb = new Int32Array(cells.length * 2);
              cb.set(cells); cells = cb;
            }
            cells[cnt++] = cur;
            var cy = (cur / w) | 0, cx = cur - cy * w;
            if (cx < bx0) bx0 = cx;
            if (cx > bx1) bx1 = cx;
            if (cy < by0) by0 = cy;
            if (cy > by1) by1 = cy;
            for (var q = 0; q < 4; q++) {
              var nx = cx + (q === 0 ? -1 : q === 1 ? 1 : 0);
              var ny = cy + (q === 2 ? -1 : q === 3 ? 1 : 0);
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;   // 出图像边界不算逃逸
              var ni = ny * w + nx, mv = mark[ni];
              if (mv === 1) { escaped = true; continue; }
              if (mv === 2 || mv === 3) continue;
              if (alpha[ni] <= 0.25) continue;
              if (dxA[nx] >= d && dyA[ny] >= d) { escaped = true; continue; }
              mark[ni] = 3;
              if (sp >= stack.length) {
                var sb = new Int32Array(stack.length * 2);
                sb.set(stack); stack = sb;
              }
              stack[sp++] = ni;
            }
          }

          var bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
          var asp = bw > bh ? bw / bh : bh / bw;
          var del = !escaped && asp > 6;       // 细长且不出环带
          var tag = del ? 2 : 1;
          for (var t = 0; t < cnt; t++) {
            mark[cells[t]] = tag;
            if (del) alpha[cells[t]] = 0;
          }
          if (del) {
            removed += cnt;
            if (by0 < d) sd[0] = 1;
            if (by1 >= h - d) sd[2] = 1;
            if (bx0 < d) sd[3] = 1;
            if (bx1 >= w - d) sd[1] = 1;
          }
        }
      }
    }

    /* 折痕从来不是一条 1px 的线：硬线两侧还压着一层渐变阴影，它二值化后
       alpha 只有 0.1~0.2，扛不过墨量地板但会被锐化重新拉起来，留下一道淡灰竖条。
       既然已判定这条边有折痕，就把该边环带里的弱墨一并压掉；实墨（笔画、
       框线、印章边）一律保留。 */
    if (sd[0]) for (y = 0; y < (d < h ? d : h); y++) {
      for (x = 0, i = y * w; x < w; x++, i++) if (alpha[i] > 0 && alpha[i] < 0.5) alpha[i] = 0;
    }
    if (sd[2]) for (y = h - d < 0 ? 0 : h - d; y < h; y++) {
      for (x = 0, i = y * w; x < w; x++, i++) if (alpha[i] > 0 && alpha[i] < 0.5) alpha[i] = 0;
    }
    if (sd[3]) for (y = 0, i = 0; y < h; y++, i += w) {
      for (x = 0; x < (d < w ? d : w); x++) if (alpha[i + x] > 0 && alpha[i + x] < 0.5) alpha[i + x] = 0;
    }
    if (sd[1]) for (y = 0, i = 0; y < h; y++, i += w) {
      for (x = w - d < 0 ? 0 : w - d; x < w; x++) if (alpha[i + x] > 0 && alpha[i + x] < 0.5) alpha[i + x] = 0;
    }
    return removed;
  }

  /* ============================================================
   * 七点五、扫描缺陷：竖条纹 / 跨页对开
   * ============================================================ */

  /**
   * 逐列增益校正（去扫描仪竖条纹）
   *
   * CIS 扫描仪每条感光单元有独立增益，整幅图上表现为贯穿全高的细竖条，
   * 亮暗交替、位置固定。纸面在每一列的直方图里都是尖锐主峰，所以逐列取
   * 中位数就得到该列的"纸面亮度"，再与横向中值滤波后的基线相除，即得该列
   * 的增益误差 —— 这与遥感/扫描仪两点定标里的列增益校正是同一套东西。
   *
   * 只修正 ±20 灰阶以内的小偏差：表格竖线、黑框、装订线的偏差远大于此，
   * 一并不动。漏修一条淡条纹比抹掉一条框线的代价小得多。
   */
  /**
   * 跨页对开检测（书刊摊开扫描成一幅横图）
   *
   * 判据来自三件事，缺一不可：
   *   ① 图像是横向的（对开页必然 w > h）；
   *   ② 中段存在一条贯穿全高的低梯度带（中缝处没有文字，只有纸与阴影）；
   *   ③ 左右两半各自"像一页"：版心居中度足够，即左右留白近似相等。
   * ③ 是关键——单页横向文件从中间切一刀，切边一侧必然贴字，居中度立刻失衡。
   *
   * 参考马健（老马）ComicEnhancerPro 的自动分页：底层是霍夫找直线（中缝），
   * 并用"宽度大于高度"作双页前提；但他同时也指出，中缝找得准不代表知道
   * 左翻还是右翻（中文古籍右翻），所以顺序必须留人工。此处取左页在前。
   */
  function detectSpread(res, dbg) {
    var w = res.w, h = res.h;
    dbg = dbg || {};
    if (w < 240 || h < 160 || w < h * 1.12) { dbg.why = 'aspect:' + (w / h).toFixed(2); return null; }

    var gray = toGray(res.data, w, h);
    var stepY = h > 700 ? 3 : 2;
    var E = new Float32Array(w);
    var x, y, row, rows = 0;

    for (y = 0; y < h; y += stepY) {
      row = y * w;
      rows++;
      for (x = 1; x < w; x++) {
        var dv = gray[row + x] - gray[row + x - 1];
        E[x] += dv < 0 ? -dv : dv;
      }
    }
    // 归一化为"每行平均梯度"（灰阶/像素），阈值才有统一的物理含义
    if (rows > 0) for (x = 0; x < w; x++) E[x] /= rows;
    // 5 抽头平滑
    var ES = new Float32Array(w);
    for (x = 0; x < w; x++) {
      var s = 0, c = 0;
      for (var k = -2; k <= 2; k++) {
        var xx = x + k;
        if (xx >= 0 && xx < w) { s += E[xx]; c++; }
      }
      ES[x] = s / c;
    }

    var lo = Math.round(w * 0.30), hi = Math.round(w * 0.70);
    var xm = lo, emin = ES[lo];
    for (x = lo; x <= hi; x++) if (ES[x] < emin) { emin = ES[x]; xm = x; }

    // 两侧正文区的梯度水平（取中位数，避开个别极密行）
    var side = [];
    for (x = Math.round(w * 0.06); x <= Math.round(w * 0.26); x++) side.push(ES[x]);
    for (x = Math.round(w * 0.74); x <= Math.round(w * 0.94); x++) side.push(ES[x]);
    side.sort(function (a, b) { return a - b; });
    var ref = side[side.length >> 1] || 0;
    dbg.ref = ref; dbg.emin = emin; dbg.xm = xm;
    if (ref < 1.2) { dbg.why = 'no-text'; return null; }              // 整页没有文字，不判
    if (emin > ref * 0.40) { dbg.why = 'not-empty:' + (emin / ref).toFixed(2); return null; }

    /* 在窗口内找出所有"低梯度带"，取最宽的一条（同宽时取最靠中间的）。
       只取最暗一列是不行的：排版的列间隙也会给出 0 梯度，
       但那些带只有几个像素宽，中缝带一定宽得多。 */
    var thr = emin * 2.2 + 2, a = xm, b = xm, bestW = 1;
    for (x = lo; x <= hi;) {
      if (ES[x] > thr) { x++; continue; }
      var ra = x, rb = x;
      while (ra - 1 >= 0 && ES[ra - 1] <= thr) ra--;
      while (rb + 1 < w && ES[rb + 1] <= thr) rb++;
      var rw = rb - ra + 1;
      if (rw > bestW || (rw === bestW && Math.abs((ra + rb) / 2 - w / 2) < Math.abs((a + b) / 2 - w / 2))) {
        bestW = rw; a = ra; b = rb;
      }
      x = rb + 1;
    }
    var bandW = b - a + 1;
    // 中缝带可以很宽：厚书的中缝阴影常有 10% 幅宽（对称），中心仍是折线位置
    dbg.bandW = bandW;
    if (bandW < 3 || bandW > w * 0.17) { dbg.why = 'band:' + bandW; return null; }

    var xs = Math.round((a + b) / 2);

    /* 有中缝阴影时，梯度最低点只是阴影的一侧（阴影边缘才有梯度），
       真正的折线是"全高最暗的那一列"：在低梯度带附近找亮度低谷。 */
    var cm = new Float32Array(w), hist2 = new Int32Array(256);
    var smpStep = Math.max(2, Math.round(h / 220));
    var smpN = Math.floor((h - 1) / smpStep) + 1;
    for (x = 0; x < w; x++) {
      hist2.fill(0);
      for (y = 0; y < h; y += smpStep) {
        var gv = gray[y * w + x] | 0;
        hist2[gv < 0 ? 0 : (gv > 255 ? 255 : gv)]++;
      }
      var need2 = smpN >> 1, acc2 = 0, mv = 255;
      for (var s2 = 0; s2 < 256; s2++) { acc2 += hist2[s2]; if (acc2 > need2) { mv = s2; break; } }
      cm[x] = mv;
    }
    var paper = [];
    for (x = 0; x < w; x += 3) paper.push(cm[x]);
    paper.sort(function (m, n) { return m - n; });
    var pLev = paper[paper.length >> 1] || 0;

    var q0 = Math.max(0, a - Math.round(w * 0.05)), q1 = Math.min(w - 1, b + Math.round(w * 0.05));
    var xd = q0, dmin = cm[q0];
    for (x = q0; x <= q1; x++) if (cm[x] < dmin) { dmin = cm[x]; xd = x; }
    if (pLev - dmin > 8) {
      var ra = xd, rb = xd;
      while (ra - 1 >= q0 && cm[ra - 1] < pLev - 4) ra--;
      while (rb + 1 <= q1 && cm[rb + 1] < pLev - 4) rb++;
      if (rb - ra < w * 0.12) xs = Math.round((ra + rb) / 2);
    }

    // ③ 两半各须"像一页"：版心居中
    function centered(x0, x1) {
      var l = x1, r = x0, t = h, bt = 0, cnt = 0, yy, xx2;
      for (yy = 0; yy < h; yy += 2) {
        for (xx2 = x0; xx2 < x1; xx2 += 2) {
          if (gray[yy * w + xx2] < 170) {
            cnt++;
            if (xx2 < l) l = xx2;
            if (xx2 > r) r = xx2;
            if (yy < t) t = yy;
            if (yy > bt) bt = yy;
          }
        }
      }
      if (cnt < 40) return false;
      var wL = l - x0, wR = x1 - 1 - r, hT = t, hB = h - 1 - bt, hw = x1 - x0;
      return Math.abs(wL - wR) < hw * 0.16 && hT > -1 && hB > -1 && (hT + hB) < h * 0.4;
    }
    var cl = centered(0, xs), cr = centered(xs + 1, w);
    dbg.centL = cl; dbg.centR = cr;
    if (!cl || !cr) { dbg.why = 'center:' + cl + ',' + cr; return null; }

    return { x: xs, band: [a, b], ratio: emin / ref };
  }

  /** 裁出左右半页 */
  function splitRes(res, x) {
    return [
      crop(res, 0, 0, x, res.h),
      crop(res, x, 0, res.w - x, res.h)
    ];
  }

  /**
   * 按内容重新取景：裁白边 → 加对称留白 → 补到目标长宽比
   * 对开页拆开后，每半页的版心是偏的（切边一侧贴字），直接套 A4 会看起来歪，
   * 这一步把内容重新摆到画面中央。
   */
  function reframe(res, aspect, padFrac) {
    var w = res.w, h = res.h, d = res.data, n = w * h;
    var x0 = w, y0 = h, x1 = -1, y1 = -1, i, yy, xx;

    for (yy = 0; yy < h; yy += 2) {
      var row = yy * w;
      for (xx = 0; xx < w; xx += 2) {
        i = (row + xx) << 2;
        if (d[i] < 190 || d[i + 1] < 190 || d[i + 2] < 190) {
          if (xx < x0) x0 = xx;
          if (xx > x1) x1 = xx;
          if (yy < y0) y0 = yy;
          if (yy > y1) y1 = yy;
        }
      }
    }
    if (x1 < 0 || x1 - x0 < 8 || y1 - y0 < 8) return res;

    var bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    var cw = bw + 2 * Math.round(bw * padFrac);
    var chh = bh + 2 * Math.round(bh * padFrac);
    if (cw / chh < aspect) cw = Math.round(chh * aspect); else chh = Math.round(cw / aspect);
    if (cw >= w * 0.99 && chh >= h * 0.99) return res;      // 已经是满幅，没必要重排

    var out = new Uint8ClampedArray(cw * chh * 4);
    var out32 = new Uint32Array(out.buffer);
    out32.fill(0xFFFFFFFF);

    var ox = Math.round((x0 + x1 + 1) / 2 - cw / 2);
    var oy = Math.round((y0 + y1 + 1) / 2 - chh / 2);
    var sx0 = Math.max(0, ox), sy0 = Math.max(0, oy);
    var sx1 = Math.min(w, ox + cw), sy1 = Math.min(h, oy + chh);
    if (sx1 <= sx0 || sy1 <= sy0) return res;

    for (yy = sy0; yy < sy1; yy++) {
      var src = (yy * w + sx0) << 2;
      var dst = ((yy - oy) * cw + (sx0 - ox)) << 2;
      out.set(d.subarray(src, src + ((sx1 - sx0) << 2)), dst);
    }
    return { data: out, w: cw, h: chh, stats: res.stats };
  }

  /* ============================================================
   * 八、主流程
   * ============================================================ */

  function process(srcData, sw, sh, options) {
    var o = {}, k;
    for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) o[k] = DEFAULTS[k];
    // modified：for-in 会把 options 原型上的属性也拷进来；且 preset='constructor' 之类
    // 会命中 Object.prototype 上的函数，使 pset.k 变 undefined → 阈值全 NaN → 整页变白。
    // 一律只收自有属性，preset 另做白名单校验（见下方读取处）。
    if (options) for (k in options) {
      if (Object.prototype.hasOwnProperty.call(options, k) && options[k] !== undefined) o[k] = options[k];
    }
    // modified：空数据不进入流水线（否则 downsample/estimateSkew 产出 NaN 尺寸）。
    // 返回一张 1x1 白像素，保证调用方 toCanvas / 导出链路仍有合法画布。
    if (!(sw > 0 && sh > 0) || !srcData || srcData.length < sw * sh * 4) {
      var empty = new Uint8ClampedArray(4);
      empty[0] = empty[1] = empty[2] = empty[3] = 255;
      return {
        data: empty, w: 1, h: 1,
        box: { x: 0, y: 0, w: 1, h: 1, cut: false }, preW: 1, preH: 1,
        stats: { inkRatio: 0, skew: 0, ms: 0, msDeskew: 0, edgeCut: 0, edgeBlobs: 0 }
      };
    }
    var tStart = now();
    var tDeskew = 0, skew = 0;

    /* --- 0. 自动纠偏（在已透视矫正的图上工作） --- */
    var data, w, h;
    if (o.deskew !== 'off') {
      var tSk = now();
      skew = estimateSkew(srcData, sw, sh, o.deskew === 'force' ? 12 : 8);
      if (skew !== 0) {
        var rot = rotateRGBA(srcData, sw, sh, skew);
        data = rot.data; w = rot.w; h = rot.h;
      }
      tDeskew = now() - tSk;
    }

    if (!data) {
      if (Math.max(sw, sh) > o.maxDim) {
        var ds = downsampleRGBA(srcData, sw, sh, o.maxDim);
        data = ds.data; w = ds.w; h = ds.h;
      } else {
        data = new Uint8ClampedArray(srcData);
        w = sw; h = sh;
      }
    } else if (Math.max(w, h) > o.maxDim) {
      var ds2 = downsampleRGBA(data, w, h, o.maxDim);
      data = ds2.data; w = ds2.w; h = ds2.h;
    }

    var n = w * h, i, p;
    var gray = toGray(data, w, h);

    /* --- 0.6 边缘黑边裁切
     * 必须早于背景估计：黑边会把 estimateBackground 拉低，
     * 增益随之抬高，正文被冲淡、纸面发灰。这一步同时也把
     * 四角检测偏松时带进来的桌面/盖板暗区一并切掉。 */
    var edgeCut = null;
    if (o.trimEdge) {
      var et = detectEdgeTrim(gray, w, h, o);
      if (et && (et.cut.t + et.cut.b + et.cut.l + et.cut.r) > 0) {
        edgeCut = et.cut;
        data = cropRaw(data, w, h, et.x, et.y, et.w, et.h);
        gray = cropFloat(gray, w, h, et.x, et.y, et.w, et.h);
        w = et.w; h = et.h; n = w * h;
      }
    }

    /* --- 1. 去阴影：估计光照场并做除法归一化 --- */
    /* 连续调不能沿用漂白的强增益：大面积灰块/照片会被背景估计当成"阴影"，
     * 180 的中间调可能直接被抬到 246。连续调只做有限的光照补偿，白纸仍保持 255。 */
    // modified：连续调限制光照增益，防止大面积中间调被当作阴影漂白。
    var continuousMode = o.mode === 'gray' || o.mode === 'color';
    var bg = estimateBackground(gray, w, h);
    var target = continuousMode ? 255 : 246 + (o.whitening - 1) * 14;
    var strength = clamp(o.shadow, 0, 1.5);
    var GAIN = new Float32Array(256);
    for (var kk = 0; kk < 256; kk++) {
      var g0 = target / (kk < 18 ? 18 : kk);
      g0 = g0 < 0.55 ? 0.55 : (g0 > (continuousMode ? 1.18 : 3.0) ? (continuousMode ? 1.18 : 3.0) : g0);
      g0 = 1 + (g0 - 1) * strength;
      var gMin = continuousMode ? 0.85 : 0.5, gMax = continuousMode ? 1.25 : 3.2;
      GAIN[kk] = g0 < gMin ? gMin : (g0 > gMax ? gMax : g0);
    }
    for (i = 0; i < n; i++) {
      var bv = bg[i];
      var gi = GAIN[bv < 0 ? 0 : (bv > 255 ? 255 : bv | 0)];
      p = i << 2;
      // modified：保色路径按最亮通道限幅，避免通道截断导致色相偏移。
      // 所有需要保色的路径都按最亮通道限幅，避免蓝块因 B 通道先截断而变成青色。
      if (o.mode === 'color' || o.keepColor) {
        var maxCh = Math.max(data[p], data[p + 1], data[p + 2]);
        if (maxCh > 0 && gi * maxCh > 255) gi = 255 / maxCh;
      }
      data[p] *= gi; data[p + 1] *= gi; data[p + 2] *= gi;
      gray[i] *= gi;
    }

    if (continuousMode) {
      var continuous = processContinuous(data, gray, w, h, o);
      continuous.stats.skew = skew;
      // modified：同步计时起点的改名（t0 → tStart），连续调提前返回分支同样要改。
      continuous.stats.ms = now() - tStart;
      continuous.stats.msDeskew = tDeskew;
      continuous.stats.edgeCut = edgeCut;
      continuous.stats.edgeBlobs = 0;
      return continuous;
    }

    /* --- 2. Sauvola 阈值图（半分辨率） --- */
    // modified：preset 必须是自有属性，否则 'constructor'/'toString' 会命中原型链上的函数。
    var pset = Object.prototype.hasOwnProperty.call(PRESETS, o.preset) ? PRESETS[o.preset] : PRESETS.standard;
    var kSau = pset.k + 0.12 * (o.contrast - 1);
    var hwMin = Math.min(w, h) >> 1;
    var winR = Math.max(3, Math.round(hwMin * pset.win / 100));
    var sm = sauvolaMap(gray, w, h, kSau, winR);
    var thM = sm.th, hw = sm.w, hh = sm.h;

    /* --- 3. 墨量 alpha + 收集墨迹索引 --- */
    /* 阈值倒数额算成 256 项表，消掉每像素一次除法 */
    var floor0 = (o.whitening - 1) * 26;
    var soft = 0.44; // modified：连续调已提前分流，这里只保留漂白墨量曲线。
    var INV = new Float32Array(256);
    for (kk = 0; kk < 256; kk++) INV[kk] = 1 / (soft * kk + 8);

    /* 绝对暗线：Sauvola 的阈值恒低于局部均值，任何"大片均匀色块"都会被判成背景。
     * 对纸面是好事，对照片、粗标题、实心印章则是灾难（实测 400×500 黑块被整个翻白，
     * 墨量从 22.7% 掉到 3.6%）。背景归一化已把纸面（含阴影里的纸面）拉到 ~246，
     * 因此"远低于纸面亮度"的像素必然是内容，直接兜底为墨。 */
    var paperLv = paperLevel(gray, w, h);
    var absDark = paperLv * 0.42;

    /* modified：彩色候选的判定基线改为"整页色度中位数"。
     * 旧纸、牛皮纸、被茶水浸过的纸本身就带明显色度（实测 235/215/170 的泛黄纸
     * 色度=65、饱和度=0.28，足以通过绝对色度门槛），若只按固定阈值判定，整页纸
     * 会被当成彩色墨：实测该页 100% 像素进入墨迹集合，漂白模式直接失效。
     * 纸张底色是"全页最常见"的颜色，彩色内容只是少数派，所以用中位数做基线，
     * 只有明显比纸更艳的像素才算内容。白纸的中位数≈0，行为与原来完全一致。 */
    var chromaFloor = 34;
    if (o.keepColor) {
      var chHist = new Uint32Array(256), chN = 0;
      var chStep = Math.max(1, Math.round(Math.sqrt(n / 120000)));
      for (var chy = 0; chy < h; chy += chStep) {
        var chRow = chy * w;
        for (var chx = 0; chx < w; chx += chStep) {
          var chp = (chRow + chx) << 2;
          var chMax = Math.max(data[chp], data[chp + 1], data[chp + 2]);
          var chMin = Math.min(data[chp], data[chp + 1], data[chp + 2]);
          chHist[chMax - chMin]++;
          chN++;
        }
      }
      // modified：中位数命中条件原为 chAcc >= chNeed，而 chNeed = chN>>1。
      // 单像素图 chNeed=0 时 chAcc>=0 恒真 → chMed 恒取 0 → 基线退回 34，
      // 泛黄纸重新被整页判墨；偶数样本且两色各半时也会偏到较小值。
      // 与同文件 detectSpread 的中位数写法保持一致，改用严格大于，并对空样本兜底。
      var chNeed = chN >> 1, chAcc = 0, chMed = 0;
      if (chN > 0) {
        for (var chi = 0; chi < 256; chi++) {
          chAcc += chHist[chi];
          if (chAcc > chNeed) { chMed = chi; break; }
        }
      }
      chromaFloor = Math.max(34, chMed * 1.6);
    }

    // 阈值图 x 方向的插值索引与权重（y 方向降采样倍率小，用最近邻已足够）
    var xi0 = new Int32Array(w), xi1 = new Int32Array(w), xwt = new Float32Array(w);
    var hw1 = hw - 1, hh1 = hh - 1;
    for (var xi = 0; xi < w; xi++) {
      var fx2 = (xi + 0.5) * 0.5 - 0.5;
      var a0i = fx2 < 0 ? 0 : (fx2 | 0);
      if (a0i > hw1) a0i = hw1;
      var a1i = a0i + 1 > hw1 ? hw1 : a0i + 1;
      xi0[xi] = a0i; xi1[xi] = a1i; xwt[xi] = clamp(fx2 - a0i, 0, 1);
    }

    var alpha = new Float32Array(n);
    // 墨迹索引：后续去噪与合成只遍历这些像素，跳过 90% 以上的纯背景
    var inkIdx = new Int32Array(Math.max(1024, n >> 2));
    var inkN = 0;
    for (var y = 0; y < h; y++) {
      var hr = (y >> 1) < hh1 ? (y >> 1) : hh1;
      var trow = hr * hw, row = y * w;
      for (var x = 0; x < w; x++) {
        var i0 = xi0[x], i1 = xi1[x], xw2 = xwt[x];
        // modified：临时阈值改名，与计时起点彻底解耦，避免 var 提升造成二次遮蔽。
        var tv0 = thM[trow + i0], tv1 = thM[trow + i1];
        var th = tv0 + (tv1 - tv0) * xw2;
        var ti = th < 0 ? 0 : (th > 255 ? 255 : th | 0);
        var a = (th - floor0 - gray[row + x]) * INV[ti];
        a = a < 0 ? 0 : (a > 1 ? 1 : a);
        /* 只在该处"局部背景本身就暗"时兜底。
         * 普通深色文字的背景是纸面（阈值高），由局部阈值正常判定；
         * 只有照片、实心块这类"背景也暗"的区域才需要兜底，
         * 否则这条线会盖掉所有档位与滑块的差异，等于把算法写死。 */
        if (a < 0.02 && absDark > 24 && th < paperLv * 0.55) {
          var gv = gray[row + x];
          if (gv < absDark) {
            a = (absDark - gv) / (absDark * 0.5);
            if (a > 1) a = 1;
          }
        }
        var idx = row + x;
        // modified：高色度像素直接成为墨迹候选，防止蓝色实心块被亮度阈值清空。
        /* 饱和色块不能只靠亮度阈值进入墨迹集合。蓝色等深色的灰度不高，
         * 大面积色块还会被背景归一化抬亮，若等合成阶段才分类，它早已被清零。
         * 高色度本身就是内容证据；只处理保色开启时的明显彩色，不影响纸张底色与预设。
         * 门槛用上面算出的 chromaFloor（随纸张自身色度上浮），否则泛黄旧纸会整页判墨。 */
        if (o.keepColor && a < 0.98) {
          var cp = idx << 2;
          var colorCls = CLASS_LUT[((data[cp] >> 4) << 8) | ((data[cp + 1] >> 4) << 4) | (data[cp + 2] >> 4)];
          if (colorCls) {
            var cMax = Math.max(data[cp], data[cp + 1], data[cp + 2]);
            var cMin = Math.min(data[cp], data[cp + 1], data[cp + 2]);
            var chroma0 = cMax - cMin;
            if (chroma0 > chromaFloor) {
              var colorAlpha = clamp(chroma0 / 120, 0, 1);
              if (colorAlpha > a) a = colorAlpha;
            }
          }
        }
        alpha[idx] = a;
        if (a > 0.02) {
          if (inkN >= inkIdx.length) {
            var bigger = new Int32Array(inkIdx.length * 2);
            bigger.set(inkIdx);
            inkIdx = bigger;
          }
          inkIdx[inkN++] = idx;
        }
      }
    }

    /* --- 4.1 边缘净化：折痕 / 装订孔 / 盖板杂边
     * 纸张边缘的折痕展开后是一条贴着纸边的硬阴影线，二值化后 alpha 接近 1，
     * 靠加权衰减去不掉（乘 0.5 之后仍然是墨）。改用"孤立连通域"判据：
     * 整个连通域都在距边 d 以内的环带里，就必然不是版心内容，直接清零。 */
    var edgeBlobs = 0;
    if (o.edgeClean > 0) {
      var eMin = Math.min(w, h);
      var ed = Math.round(eMin * (o.edgeClean >= 2 ? 0.048 : 0.032));
      edgeBlobs = clearEdgeBlobs(alpha, w, h, ed);
    }

    /* --- 4. 去噪（只扫描墨迹像素，不再全图遍历） --- */
    // modified：强力档只提高孤立连通域清理阈值，不再执行全图中值滤波。
    if (o.denoise >= 1) {
      alpha = removeSpecks(alpha, w, h, o.denoise >= 2 ? 14 : 6, inkIdx, inkN);
    }

    /* --- 4.2 断笔接续（2.4.7 重写：方向性条件桥接） ---
     * 旧版只遍历 inkIdx（alpha>0.02 的墨迹像素），纯白断口不在表里，等于没接；
     * 3x3 全向 maxFilter 还把笔画末端朝四面一起拉粗。现改为按 0°/90°/±45°
     * 四条方向线找「实心 ≥2px → 短断口 → 实心 ≥2px」，只在留白像素上补软过渡墨。
     * 档位：1 公文·仿宋（默认，断口 1~2px）| 2 增强（更低实心门槛、断口 +1px）
     *       | 3 旧版弱墨补偿（保留 2.4.6 行为，供对比/回退）。
     * 详细出处与保真边界见 bridgeGaps 上方的注释。 */
    if (o.inkGrow > 0) {
      var growMode = (o.inkGrow === 3 || o.inkGrow === '3') ? 3 : (o.inkGrow >= 2 ? 2 : 1);
      if (growMode === 3) {
        var mxOld = maxFilter(alpha, w, h, 1);
        for (var qo = 0; qo < inkN; qo++) {
          var io = inkIdx[qo], ao = alpha[io];
          // modified 2.4.7：补 ao>0.02，避免 removeSpecks 已清零的噪点被邻域最大值复活
          // （审计报告 3.4「断笔接续 inkIdx 未重建，噪点可能被复活」即出于此）。
          if (ao > 0.02 && ao < 0.55 && mxOld[io] > 0.72) alpha[io] = ao + (mxOld[io] - ao) * 0.42;
        }
      } else {
        var solidThr = growMode === 2 ? 0.56 : 0.65;
        var strokeW = estimateStrokeWidth(alpha, w, h, solidThr);
        // modified：2.4.7 实机回归（仿宋 46px 样本、442 个 2px 断口）两次纠偏：
        // ① 「sw>=4 才允许 2px」过严，只接上 11/442；
        // ② 改用「sw<=2 就降到 1px」仍是 11/442 —— 仿宋笔画本来就纤细
        //    （46px 字笔画宽约 2px），「笔画细」不等于「分辨率低」，不能拿它压上限。
        // 结论：常规固定 2px（300dpi 仿宋字间距 ≥8px，2px 很安全），
        // 只有笔画芯部真的只剩 1px 的极小字才降到 1px；增强档 3px。
        var gapMax = (strokeW === 1) ? 1 : 2;
        if (growMode === 2) gapMax = Math.min(3, gapMax + 1);
        var addedInk = bridgeGaps(alpha, w, h, { solid: solidThr, minRun: 2, maxGap: gapMax });
        // 新补像素必须并入 inkIdx，否则后面的墨量曲线与合成不会处理它们；
        // 旧索引里已被 removeSpecks 清零的项由后续循环的 av<=0 跳过，不会被复活。
        for (var ab = 0; ab < addedInk.length; ab++) {
          if (inkN >= inkIdx.length) {
            var cap2 = new Int32Array(inkIdx.length * 2);
            cap2.set(inkIdx);
            inkIdx = cap2;
          }
          inkIdx[inkN++] = addedInk[ab];
        }
      }
    }

    /* --- 4.5 墨量曲线 + 白底地板（合并为一个循环，pow 走查表） --- */
    var gamma = 0.86 - 0.14 * clamp((o.textDark - 1) / 0.5, 0, 1);
    var PN = 1024;
    var POW = new Float32Array(PN + 1);
    for (kk = 0; kk <= PN; kk++) POW[kk] = Math.pow(kk / PN, gamma);
    var FLOOR = 0.16, invF = 1 / (1 - FLOOR);
    for (kk = 0; kk < inkN; kk++) {
      i = inkIdx[kk];
      var av = alpha[i];
      if (av <= 0) continue;
      if (av < 1) av = POW[(av * PN + 0.5) | 0];
      alpha[i] = av <= FLOOR ? 0 : (av - FLOOR) * invF;
    }

    /* --- 5. 锐化（对 alpha 做非锐化掩模） --- */
    if (o.sharpen > 0.01) {
      var blurA = boxBlur(alpha, w, h, 1);
      var amt = o.sharpen * 1.2;
      for (i = 0; i < n; i++) {
        var v = alpha[i] + amt * (alpha[i] - blurA[i]);
        alpha[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
      }
    }

    /* --- 6. 合成漂白输出（只遍历墨迹像素，背景已整字填白） --- */
    var out = new Uint8ClampedArray(n * 4);
    var out32 = new Uint32Array(out.buffer);
    out32.fill(0xFFFFFFFF);

    var td = clamp(o.textDark, 0.3, 1.5);
    var cBoost = o.colorBoost;
    var inkCount = 0;
    var ampBleach = 252; // modified：灰度连续调不再共用漂白幅度。
    var LUT = CLASS_LUT;
    var pow09 = new Float32Array(PN + 1);
    for (kk = 0; kk <= PN; kk++) pow09[kk] = Math.pow(kk / PN, 0.9);

    for (kk = 0; kk < inkN; kk++) {
      i = inkIdx[kk];
      var a0 = alpha[i];
      if (a0 < 0.008) continue;
      p = i << 2;
      var r = data[p], g = data[p + 1], bl = data[p + 2];

      // 文字灰度底（漂白 → 纯黑）
      var ink = (a0 < 1 ? pow09[(a0 * PN + 0.5) | 0] : 1) * td;
      var base = 255 - (ink > 1 ? 1 : ink) * ampBleach;
      inkCount++;

      var cls = o.keepColor ? LUT[((r >> 4) << 8) | ((g >> 4) << 4) | (bl >> 4)] : 0;
      if (cls === 1) {
        // 红头 / 印章：保色相、微提饱和
        var tint = boostInkColor(r, g, bl, cBoost);
        var cr = tint[0], cg = tint[1], cb = tint[2];
        // 浓度由饱和度决定（浅红章也要显色），边缘由 alpha 淡出
        var mx = r > g ? (r > bl ? r : bl) : (g > bl ? g : bl);
        var mn = r < g ? (r < bl ? r : bl) : (g < bl ? g : bl);
        var conc = clamp((mx - mn) / (mx + 1) * 2.4, 0, 1);
        var edge = a0 > conc ? a0 : conc;
        cr = 255 + (cr - 255) * edge;
        cg = 255 + (cg - 255) * edge;
        cb = 255 + (cb - 255) * edge;
        out[p] = base + (cr - base) * edge;
        out[p + 1] = base + (cg - base) * edge;
        out[p + 2] = base + (cb - base) * edge;
      } else if (cls === 2) {
        // modified：其他彩色保留原色相，不再归一到固定明度。
        // 其他彩色只做光照校正与边缘混合，不再强行归一到固定明度；
        // 后者会把纯蓝的 R/G 抬高、B 截断，导致蓝块偏青，改变原始色相。
        out[p] = base + (r - base) * a0;
        out[p + 1] = base + (g - base) * a0;
        out[p + 2] = base + (bl - base) * a0;
      } else {
        out[p] = base; out[p + 1] = base; out[p + 2] = base;
      }
    }

    var res = { data: out, w: w, h: h };
    res.stats = {
      inkRatio: inkCount / n,
      skew: skew,
      // modified：计时起点原叫 t0，与阈值插值循环里的 var t0 是同一个函数作用域变量，
      // 被覆盖后 now()-t0 减的是最后一个阈值像素，实测漂白模式 stats.ms = -127.9。
      ms: now() - tStart,
      msDeskew: tDeskew,
      edgeCut: edgeCut,
      edgeBlobs: edgeBlobs
    };

    res = trimInk(res, alpha, w, h, o.trim);
    return res;
  }

  var API = {
    // modified：2.4.9 — 裁白边改为「先算框再裁」，结果多带 box/preW/preH，
    // 支持全篇统一裁切（各页同尺寸、版心对齐）；运行参数与二值化算法未改。
    // modified：2.4.8 — 仅开发辅助：新增 tools/gitsync.js 与 同步GitHub.bat 解决
    // 本机 github.com 时通时不通（直连被墙 / 环境代理端口失效 / CONNECT 502）
    // 导致 push 卡死；运行时算法未改，浏览器侧无行为变化。
    // modified：2.4.7 — 断笔接续重写为「方向性条件桥接」：四方向游程判走势、
    // 笔画宽度自适应断口上限、软过渡补墨；修复纯白断口从未被接续、全向膨胀
    // 拉粗笔画、噪点复活三处旧问题；新增档位与旧档回退。
    // modified：2.4.6 — 全量复审：修正印章掩膜跨字节形态学、无损回读三态、
    // 下采样污染输入、计时变量遮蔽、色度中位数小样本、导出写回失败处理、
    // 清空竞态与静态服务边界；自检扩展到 pdfout 层（19 项）。
    // modified：2.4.5 — 界面参数自动记忆（localStorage），刷新/重启后沿用上次设定。
    // modified：2.4.4 — 输出长边上限跟随"处理分辨"，修复三档体积几乎无差别。
    // modified：2.4.3 — 导出文件名与源文件一致、可写回源文件覆盖、导出后自动清空工作栏。
    // modified：2.4.2 — 复审修复彩色候选基准（泛黄纸整页判墨）、无损校验长度判定与公共设施问题。
    // modified：2.4.10 — 新增全篇「识别范围」：四角校正后物理裁掉框外像素，
    // 页眉/页码/装订孔不进入任何识别统计；与自动裁白边、统一裁切正交叠加。
    version: '2.4.10',
    defaults: DEFAULTS,
    presets: PRESETS,
    process: process,
    detectQuad: detectQuad,
    warpPerspective: warpPerspective,
    estimateSkew: estimateSkew,
    rotateRGBA: rotateRGBA,
    quadSize: quadSize,
    downscaleRGBA: downsampleRGBA,
    otsu: otsu,
    detectSpread: detectSpread,
    splitRes: splitRes,
    reframe: reframe,
    // modified：2.4.9 — 全篇统一裁切框（输入各页裁前尺寸与裁切框，输出共用框）
    unifyCrop: unifyCrop,
    // modified：2.4.10 — 识别范围（相对坐标归一化 + 物理裁剪），供交互层与自检调用
    normROI: normROI,
    cropROI: cropROI,
    // 供基准测试 / 单元测试
    _internals: {
      estimateBackground: estimateBackground,
      boxBlur: boxBlur,
      sauvolaMap: sauvolaMap,
      removeSpecks: removeSpecks,
      bridgeGaps: bridgeGaps,
      estimateStrokeWidth: estimateStrokeWidth,
      classLut: CLASS_LUT,
      detectEdgeTrim: detectEdgeTrim,
      paperLevel: paperLevel,
      inkBBox: inkBBox,
      trimBox: trimBox
    }
  };

  global.DocScan = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
