#!/usr/bin/env node
/* =============================================================
 * tools/selftest.js — 零依赖自检（Node 16+，无需浏览器）
 *
 * 用途：改完算法后先跑这一份，确认"内容真实性"相关的硬约束没有被改坏。
 * 运行：node tools/selftest.js
 * 退出码：0 全部通过；1 有失败项（可直接接进 CI）
 * ============================================================= */
'use strict';

var path = require('path');
var zlib = require('zlib');
var DocScan = require(path.join(__dirname, '..', 'core.js'));
// modified：原自检只 require core.js，pdfout 的位运算、无损回读校验、ZIP/CRC
// 一条都测不到 —— 2.4.6 修复的两个 P1 正是这样潜伏下来的。此后两库都纳入自检。
var DocScanPDF = require(path.join(__dirname, '..', 'pdfout.js'));

var BASE = { deskew: 'off', trimEdge: false, edgeClean: 0, sharpen: 0, denoise: 0, maxDim: 2000 };
var passed = 0, failed = 0, skipped = 0;
var pending = [];

function run(data, w, h, extra) {
  var opt = {};
  for (var k in BASE) opt[k] = BASE[k];
  if (extra) for (var j in extra) opt[j] = extra[j];
  return DocScan.process(data, w, h, opt);
}

function blank(w, h, rgb) {
  var d = new Uint8ClampedArray(w * h * 4);
  for (var i = 0; i < w * h; i++) {
    d[i * 4] = rgb[0]; d[i * 4 + 1] = rgb[1]; d[i * 4 + 2] = rgb[2]; d[i * 4 + 3] = 255;
  }
  return d;
}

function fill(d, w, x0, y0, x1, y1, rgb) {
  for (var y = y0; y < y1; y++) {
    for (var x = x0; x < x1; x++) {
      var p = (y * w + x) * 4;
      d[p] = rgb[0]; d[p + 1] = rgb[1]; d[p + 2] = rgb[2];
    }
  }
}

function lum(d, i) { var p = i * 4; return 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; }

// modified：支持 Promise 型断言（无损回读校验是异步的），并支持显式 skip。
function check(name, fn) {
  try {
    var r = fn();
    if (r === 'skip') {
      skipped++;
      console.log('  skip ' + name);
      return;
    }
    if (r && typeof r.then === 'function') {
      pending.push(r.then(function () {
        passed++; console.log('  ok   ' + name);
      }, function (e) {
        failed++; console.log('  FAIL ' + name + ' → ' + e.message);
      }));
      return;
    }
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL ' + name + ' → ' + e.message);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

console.log('\n澄文扫描台 · 内核自检（DocScan ' + DocScan.version + '）\n');

check('1px 细线在去噪 0/1/2 三档下都保留 16 个暗像素', function () {
  var w = 20, h = 20, d = blank(w, h, [255, 255, 255]);
  for (var y = 2; y < 18; y++) { var p = (y * w + 10) * 4; d[p] = d[p + 1] = d[p + 2] = 0; }
  [0, 1, 2].forEach(function (n) {
    var r = run(d, w, h, { mode: 'bleach', denoise: n });
    var dark = 0;
    for (var i = 0; i < w * h; i++) if (r.data[i * 4] < 128) dark++;
    assert(dark === 16, 'denoise=' + n + ' 只剩 ' + dark + ' 个暗像素');
  });
});

check('灰度模式输出真灰度，保留中间调且白底仍为 255', function () {
  var w = 300, h = 300, d = blank(w, h, [255, 255, 255]);
  fill(d, w, 90, 90, 210, 210, [180, 180, 180]);
  var r = run(d, w, h, { mode: 'gray', keepColor: true });
  var p = (150 * w + 150) * 4, rgb = [r.data[p], r.data[p + 1], r.data[p + 2]];
  assert(rgb[0] === rgb[1] && rgb[1] === rgb[2], '出现了彩色像素 ' + rgb);
  assert(rgb[0] > 150 && rgb[0] < 240, '中间调被推白或压黑 ' + rgb[0]);
  assert(r.data[0] === 255 && r.data[1] === 255 && r.data[2] === 255, '白底不白 ' + r.data[0]);
});

check('彩色模式保留色相', function () {
  var w = 300, h = 300, d = blank(w, h, [255, 255, 255]);
  fill(d, w, 90, 90, 210, 210, [220, 160, 170]);
  var r = run(d, w, h, { mode: 'color', keepColor: true });
  var p = (150 * w + 150) * 4;
  assert(r.data[p] > r.data[p + 1] + 20 && r.data[p] > r.data[p + 2] + 20, '色相丢失');
});

check('shadow=0 时连续调逐像素不改动（去掉光照校正后原样输出）', function () {
  var w = 200, h = 200, d = blank(w, h, [255, 255, 255]);
  fill(d, w, 60, 60, 140, 140, [200, 120, 90]);
  var r = run(d, w, h, { mode: 'color', keepColor: true, shadow: 0 });
  var p = (100 * w + 100) * 4;
  assert(r.data[p] === 200 && r.data[p + 1] === 120 && r.data[p + 2] === 90,
    '像素被改动 ' + [r.data[p], r.data[p + 1], r.data[p + 2]]);
});

check('实心黑块墨量守恒（硬墨量 ≥ 几何真值的 92%）', function () {
  var w = 400, h = 500, d = blank(w, h, [255, 255, 255]);
  fill(d, w, 100, 50, 300, 450, [20, 20, 20]);
  var r = run(d, w, h, { mode: 'bleach' });
  var dark = 0;
  for (var i = 0; i < w * h; i++) if (r.data[i * 4] < 128) dark++;
  var truth = (200 * 400) / (w * h), got = dark / (w * h);
  assert(got > truth * 0.92, '硬墨量 ' + (got * 100).toFixed(1) + '% < 真值 ' + (truth * 100).toFixed(1) + '%');
});

check('多色页红、蓝都保留（不被主色掩膜吃掉）', function () {
  var w = 600, h = 800, d = blank(w, h, [255, 255, 255]);
  fill(d, w, 60, 100, 300, 340, [200, 32, 48]);
  fill(d, w, 390, 500, 490, 600, [32, 80, 200]);
  var r = run(d, w, h, { mode: 'bleach', keepColor: true });
  var red = 0, blue = 0;
  for (var i = 0; i < w * h; i++) {
    var p = i * 4;
    if (r.data[p] > r.data[p + 1] + 45 && r.data[p] > r.data[p + 2] + 45) red++;
    if (r.data[p + 2] > r.data[p] + 45 && r.data[p + 2] > r.data[p + 1] + 45) blue++;
  }
  assert(red > 20000, '红像素只剩 ' + red);
  assert(blue > 5000, '蓝像素只剩 ' + blue);
});

check('泛黄旧纸不会被整页判成彩色墨（保色默认开启）', function () {
  var w = 800, h = 1100, d = blank(w, h, [235, 215, 170]);
  for (var i = 0; i < 18; i++) fill(d, w, 80, 100 + i * 50, 720, 126 + i * 50, [30, 30, 30]);
  var r = run(d, w, h, { mode: 'bleach', keepColor: true, maxDim: 1600 });
  var mid = 0;
  for (var k = 0; k < r.w * r.h; k++) { var l = lum(r.data, k); if (l > 40 && l < 235) mid++; }
  var pct = mid / (r.w * r.h) * 100;
  assert(pct < 10, '中间调占 ' + pct.toFixed(1) + '%，纸张被当成了墨');
});

check('泛黄纸上的红章、蓝笔批注仍然保色', function () {
  [[204, 34, 34], [40, 70, 160]].forEach(function (c) {
    var w = 800, h = 1100, d = blank(w, h, [245, 232, 205]);
    fill(d, w, 200, 400, 600, 700, c);
    var r = run(d, w, h, { mode: 'bleach', keepColor: true, maxDim: 1600 });
    var colored = 0;
    for (var i = 0; i < r.w * r.h; i++) {
      var p = i * 4;
      if (Math.abs(r.data[p] - r.data[p + 1]) > 20 || Math.abs(r.data[p + 1] - r.data[p + 2]) > 20) colored++;
    }
    assert(colored > 100000, '颜色 ' + c + ' 只剩 ' + colored + ' 个彩色像素');
  });
});

check('纸张状况五档：淡墨 ≥ 标准 ≥ 污渍，且五档不能全塌成同一结果', function () {
  var w = 400, h = 500, d = blank(w, h, [255, 255, 255]);
  for (var y = 60; y < 440; y += 14) fill(d, w, 60, y, 340, y + 2, [193, 193, 193]);
  // modified：原用例只测 3 档且全用 >= —— 把 preset 处理改成恒等（最典型的回归）
  // 时照样通过。现在覆盖全部 5 档，并要求至少出现 2 个不同取值。
  var v = {}, keys = ['clean', 'standard', 'faded', 'stain', 'shadow'];
  keys.forEach(function (p) { v[p] = run(d, w, h, { mode: 'bleach', preset: p }).stats.inkRatio; });
  assert(v.faded >= v.standard && v.standard >= v.stain,
    'faded=' + v.faded.toFixed(4) + ' standard=' + v.standard.toFixed(4) + ' stain=' + v.stain.toFixed(4));
  for (var i = 0; i < keys.length; i++) assert(isFinite(v[keys[i]]), keys[i] + ' 产出 NaN');
  var uniq = {};
  keys.forEach(function (p) { uniq[v[p].toFixed(6)] = 1; });
  assert(Object.keys(uniq).length >= 2, '五档全部塌成同一结果：' + JSON.stringify(v));
});

check('极端尺寸与全黑页不崩溃、输出尺寸有效', function () {
  [[1, 1], [1, 900], [900, 1], [3, 3000]].forEach(function (s) {
    ['bleach', 'gray', 'color'].forEach(function (m) {
      var r = DocScan.process(blank(s[0], s[1], [255, 255, 255]), s[0], s[1],
        { mode: m, deskew: 'auto', maxDim: 2000 });
      assert(r.w > 0 && r.h > 0 && r.data.length === r.w * r.h * 4, s.join('x') + ' mode=' + m);
    });
  });
  var black = run(blank(200, 260, [0, 0, 0]), 200, 260, { mode: 'bleach' });
  assert(black.w > 0 && black.h > 0 && black.data.length === black.w * black.h * 4, '全黑页输出异常');
});

/* ================= 2.4.6 新增回归断言 =================
 * 这些用例分别锁住本轮修复的 P1，防止再次回退。
 * 参考实现统一用「逐像素两趟」写法，不复用被测代码里的任何位运算。 */

check('下采样早退不改写调用方原始像素（长边 2001 / maxDim 2000）', function () {
  var src = blank(2001, 2, [200, 200, 200]);
  var before = src[0];
  var ds = DocScan.downscaleRGBA(src, 2001, 2, 2000);
  assert(ds.data !== src, '早退分支仍返回输入引用');
  run(ds.data, ds.w, ds.h, { mode: 'bleach' });
  assert(src[0] === before, '原始像素被改写 ' + before + ' → ' + src[0]);
});

check('漂白模式 stats.ms 为非负耗时（计时变量未被阈值插值遮蔽）', function () {
  var r = run(blank(200, 200, [240, 240, 240]), 200, 200, { mode: 'bleach' });
  assert(isFinite(r.stats.ms) && r.stats.ms >= 0, 'stats.ms = ' + r.stats.ms);
});

check('1x1 泛黄纸不整页判墨（色度中位数小样本修复）', function () {
  var r = run(blank(1, 1, [235, 215, 170]), 1, 1, { mode: 'bleach', keepColor: true });
  assert(r.data[0] === 255 && r.data[1] === 255 && r.data[2] === 255,
    '纸面被当成墨：' + [r.data[0], r.data[1], r.data[2]]);
});

check('空数据返回合法空态，estimateSkew 不返回伪角度', function () {
  var r = DocScan.process(new Uint8ClampedArray(0), 0, 0, { mode: 'bleach' });
  assert(r.w > 0 && r.h > 0 && r.data.length === r.w * r.h * 4, '空数据输出尺寸非法');
  assert(DocScan.estimateSkew(new Uint8ClampedArray(0), 0, 0, 8) === 0, '空图返回了伪角度');
  var ds = DocScan.downscaleRGBA(new Uint8ClampedArray(0), 0, 0, 2000);
  assert(isFinite(ds.w) && isFinite(ds.h), '空图下采样产出 NaN 尺寸');
});

check('非法 preset 名（原型属性）降级到 standard，不产生 NaN', function () {
  var r = run(blank(120, 120, [255, 255, 255]), 120, 120,
    { mode: 'bleach', preset: 'constructor' });
  assert(isFinite(r.stats.inkRatio) && r.stats.inkRatio >= 0, 'inkRatio = ' + r.stats.inkRatio);
});

/* 逐像素两趟 3x3 闭运算参考实现（结构元与产品实现一致，位运算完全独立） */
function refClose(m, w, h) {
  var rb = Math.ceil(w / 8);
  function pad(a, white) {
    for (var y = 0; y < h; y++) for (var x = w; x < rb * 8; x++) {
      var q = y * rb + (x >> 3), bit = 0x80 >> (x & 7);
      if (white) a[q] |= bit; else a[q] &= ~bit;
    }
  }
  function get(a, x, y, outside) {
    if (x < 0 || x >= w) return outside;
    var yy = y < 0 ? 0 : (y >= h ? h - 1 : y);
    return (a[yy * rb + (x >> 3)] >> (7 - (x & 7))) & 1;
  }
  function step(src, horizontal, dilate) {
    var out = new Uint8Array(rb * h);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var c = get(src, x, y, dilate ? 1 : 0), a, b, q;
      if (horizontal) {
        a = get(src, x - 1, y, dilate ? 1 : 0); b = get(src, x + 1, y, dilate ? 1 : 0);
      } else {
        a = get(src, x, y - 1, dilate ? 1 : 0); b = get(src, x, y + 1, dilate ? 1 : 0);
      }
      q = dilate ? (c & a & b) : (c | a | b);
      if (q) out[y * rb + (x >> 3)] |= 0x80 >> (x & 7);
    }
    return out;
  }
  pad(m, true);
  var d1 = step(m, true, true); pad(d1, true);
  var d2 = step(d1, false, true); pad(d2, false);
  var e1 = step(d2, true, false); pad(e1, false);
  var e2 = step(e1, false, false); pad(e2, true);
  return e2;
}

check('maskClose 与逐像素 3x3 形态学一致（字节边界定向反例 + 随机）', function () {
  var w = 16, h = 5, rb = 2, m = new Uint8Array(rb * h);
  m.fill(255);
  for (var y = 0; y < h; y++) for (var q = 0; q < 2; q++) {
    var x = 9 + q; m[y * rb + (x >> 3)] &= ~(0x80 >> (x & 7));
  }
  var got = DocScanPDF._maskClose(m.slice(), w, h), exp = refClose(m.slice(), w, h);
  for (var i = 0; i < got.length; i++) assert(got[i] === exp[i], '定向反例字节 ' + i + ' 不一致');

  var seed = 20261104;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  for (var t = 0; t < 200; t++) {
    var ww = 8 + Math.floor(rnd() * 41), hh = 3 + Math.floor(rnd() * 12), rbn = Math.ceil(ww / 8);
    var mm = new Uint8Array(rbn * hh); mm.fill(255);
    for (var yy = 0; yy < hh; yy++) for (var xx = 0; xx < ww; xx++) {
      if (rnd() < 0.35) mm[yy * rbn + (xx >> 3)] &= ~(0x80 >> (xx & 7));
    }
    var g = DocScanPDF._maskClose(mm.slice(), ww, hh), e = refClose(mm.slice(), ww, hh);
    for (var j = 0; j < g.length; j++) assert(g[j] === e[j], '随机用例 ' + t + ' 字节 ' + j + ' 不一致');
  }
});

check('CRC32 已知向量与 ZIP 结构 / 文件名净化 / DOS 日期', function () {
  var txt = new Uint8Array(Buffer.from('The quick brown fox jumps over the lazy dog', 'ascii'));
  assert(DocScanPDF._crc32(txt) === 0x414fa339, 'CRC32 与 IEEE 向量不符');
  var z = DocScanPDF.zip([
    { name: 'a/b.txt', bytes: new Uint8Array([1, 2, 3]) },
    { name: '中文.png', bytes: new Uint8Array([4, 5]) }
  ]);
  var eocd = -1;
  for (var i = z.length - 22; i >= 0; i--) {
    if (z[i] === 0x50 && z[i + 1] === 0x4b && z[i + 2] === 0x05 && z[i + 3] === 0x06) { eocd = i; break; }
  }
  assert(eocd >= 0, 'EOCD 缺失');
  assert((z[eocd + 10] | (z[eocd + 11] << 8)) === 2, 'EOCD 条目数不为 2');
  var nl = z[26] | (z[27] << 8);
  var nm = String.fromCharCode.apply(null, z.slice(30, 30 + nl));
  assert(nm === 'a_b.txt', '文件名未净化：' + nm);
  var dosDate = z[14] | (z[15] << 8);
  assert(dosDate > 0, 'DOS 日期仍为 0（1980-00-00 非法）');
  assert((z[6] | (z[7] << 8)) === 0, 'ASCII 名不应置 UTF-8 标志位');
});

check('完好的 Flate 流回读校验为 true', function () {
  if (typeof DecompressionStream === 'undefined' || typeof Blob === 'undefined' || typeof Response === 'undefined') return 'skip';
  var orig = new Uint8Array(64);
  for (var i = 0; i < orig.length; i++) orig[i] = (i * 37) & 255;
  var packed = new Uint8Array(zlib.deflateSync(Buffer.from(orig)));
  return DocScanPDF._verifyLossless({ bits: orig, bytes: packed, redBits: null, redBytes: null })
    .then(function (out) { assert(out.verify === true, 'verify = ' + out.verify); });
});

check('损坏的 Flate 流必须判 verify=false（导出拦截依据）', function () {
  if (typeof DecompressionStream === 'undefined' || typeof Blob === 'undefined' || typeof Response === 'undefined') return 'skip';
  var orig = new Uint8Array(64);
  for (var i = 0; i < orig.length; i++) orig[i] = (i * 37) & 255;
  var packed = new Uint8Array(zlib.deflateSync(Buffer.from(orig)));
  packed[Math.floor(packed.length / 2)] ^= 0x55;   // 篡改中间字节
  return DocScanPDF._verifyLossless({ bits: orig, bytes: packed, redBits: null, redBytes: null })
    .then(function (out) { assert(out.verify === false, 'verify = ' + out.verify + '，损坏流会被放行'); });
});

/* ================= 2.4.7 新增：方向性断笔桥接回归断言 =================
 * 全部基于独立的 alpha 平面手工构造，不复用被测代码里的任何游程逻辑。
 * 锁住：纯白断口真的被接上、四方向各接一次、软过渡、字间距不误接、
 * 不整体加粗、方向之间不连锁扩张、added 不重复、档位端到端可跑。 */
var BG = DocScan._internals.bridgeGaps;
var ESW = DocScan._internals.estimateStrokeWidth;
var BCFG = { solid: 0.65, minRun: 2, maxGap: 2 };

function plane(w, h) { return new Float32Array(w * h); }
function hRun(a, w, y, x0, x1, v) { for (var x = x0; x <= x1; x++) a[y * w + x] = v; }
function vRun(a, w, x, y0, y1, v) { for (var y = y0; y <= y1; y++) a[y * w + x] = v; }
function dRun(a, w, x, y, dx, dy, n, v) {
  for (var i = 0; i < n; i++) a[(y + i * dy) * w + (x + i * dx)] = v;
}

check('断笔接续：水平 2px 纯白断口被接上，且补的是软过渡而非实心方棍', function () {
  var w = 16, h = 9, a = plane(w, h);
  hRun(a, w, 4, 2, 4, 1); hRun(a, w, 4, 7, 9, 1);
  var add = BG(a, w, h, BCFG);
  assert(add.length >= 2, '纯白断口未被处理（旧版缺陷）');
  assert(a[4 * w + 5] > 0.6 && a[4 * w + 6] > 0.6, '断口补墨不足：' + a[4 * w + 5] + ',' + a[4 * w + 6]);
  assert(a[4 * w + 5] < 1 && a[4 * w + 6] < 1, '补成了实心，失去软过渡');
});

check('断笔接续：垂直 1px 断口被接上', function () {
  var w = 16, h = 12, a = plane(w, h);
  vRun(a, w, 8, 2, 4, 1); vRun(a, w, 8, 6, 8, 1);
  BG(a, w, h, BCFG);
  assert(a[5 * w + 8] > 0.6, '竖向断口未接：' + a[5 * w + 8]);
});

check('断笔接续：+45° / -45° 斜向断口（撇捺）都被接上', function () {
  var w = 14, h = 14, c = plane(w, h), d = plane(w, h);
  dRun(c, w, 2, 2, 1, 1, 3, 1); dRun(c, w, 6, 6, 1, 1, 3, 1);
  BG(c, w, h, BCFG);
  assert(c[5 * w + 5] > 0.6, '+45° 断口未接：' + c[5 * w + 5]);
  dRun(d, w, 2, 11, 1, -1, 3, 1); dRun(d, w, 6, 7, 1, -1, 3, 1);
  BG(d, w, h, BCFG);
  assert(d[8 * w + 5] > 0.6, '-45° 断口未接：' + d[8 * w + 5]);
});

check('断笔接续：4px 字间距不被误接成断口', function () {
  var w = 18, h = 9, a = plane(w, h);
  hRun(a, w, 4, 2, 4, 1); hRun(a, w, 4, 9, 11, 1);
  BG(a, w, h, BCFG);
  for (var x = 5; x <= 8; x++) assert(a[4 * w + x] === 0, 'x=' + x + ' 被误补：' + a[4 * w + x]);
});

check('断笔接续：孤立 1px 噪点不构成端点，不补', function () {
  var w = 14, h = 9, a = plane(w, h);
  a[4 * w + 2] = 1; hRun(a, w, 4, 4, 6, 1);
  BG(a, w, h, BCFG);
  assert(a[4 * w + 3] === 0, '噪点被当成笔画端点：' + a[4 * w + 3]);
});

check('断笔接续：只改断口内的像素，笔画本身不加粗、方向间不连锁扩张', function () {
  var w = 18, h = 12, a = plane(w, h), y, x, i;
  for (y = 3; y <= 5; y++) { hRun(a, w, y, 2, 4, 1); hRun(a, w, y, 7, 9, 1); }
  var before = a.slice();   // 快照必须在构造笔画之后取
  BG(a, w, h, BCFG);
  var changed = 0;
  for (i = 0; i < a.length; i++) {
    if (a[i] === before[i]) continue;
    changed++;
    x = i % w; y = (i / w) | 0;
    assert(x >= 5 && x <= 6 && y >= 3 && y <= 5,
      '断口外的像素被改动（连锁扩张）：x=' + x + ',y=' + y + ',v=' + a[i]);
    assert(a[i] > 0.6 && a[i] < 1, '补墨量异常：' + a[i]);
  }
  assert(changed === 6, '改动像素数应为 3 行 × 2 列 = 6，实际 ' + changed);
});

check('断笔接续：笔画宽度由水平游程中位数估计，粗细两档可区分', function () {
  var w = 40, h = 30, thin = plane(w, h), thick = plane(w, h);
  for (var y = 0; y < h; y++) { hRun(thin, w, y, 2, 3, 1); hRun(thick, w, y, 2, 6, 1); }
  assert(ESW(thin, w, h, 0.65) === 2, '细笔画宽度应为 2，实际 ' + ESW(thin, w, h, 0.65));
  assert(ESW(thick, w, h, 0.65) === 5, '粗笔画宽度应为 5，实际 ' + ESW(thick, w, h, 0.65));
  assert(ESW(plane(2, 2), 2, 2, 0.65) === 0, '样本不足时应返回 0 让调用方走保守档');
});

check('断笔接续：added 索引不重复，横竖共补同一像素时取最大值不累加', function () {
  var w = 16, h = 16, a = plane(w, h);
  hRun(a, w, 8, 5, 7, 1); hRun(a, w, 8, 9, 11, 1);
  vRun(a, w, 8, 5, 7, 1); vRun(a, w, 8, 9, 11, 1);
  var add = BG(a, w, h, BCFG), seen = {};
  for (var i = 0; i < add.length; i++) {
    assert(!seen[add[i]], 'added 出现重复索引 ' + add[i] + '（会被墨量曲线处理两次）');
    seen[add[i]] = 1;
  }
  assert(a[8 * w + 8] > 0.6 && a[8 * w + 8] < 1,
    '交叉断口补墨应取最大而非累加：' + a[8 * w + 8]);
});

check('断笔接续：三个档位端到端均可运行，默认关闭时不改变输出', function () {
  var w = 120, h = 150, src = blank(w, h, [255, 255, 255]);
  for (var y = 30; y <= 110; y += 16) fill(src, w, 20, y, 100, y + 3, [30, 30, 30]);
  var off = run(src.slice(), w, h, { mode: 'bleach' });
  var on1 = run(src.slice(), w, h, { mode: 'bleach', inkGrow: 1 });
  var on2 = run(src.slice(), w, h, { mode: 'bleach', inkGrow: 2 });
  var on3 = run(src.slice(), w, h, { mode: 'bleach', inkGrow: 3 });
  [off, on1, on2, on3].forEach(function (r, k) {
    assert(r.data.length === w * h * 4, '档位 ' + k + ' 输出尺寸异常');
    assert(isFinite(r.stats.inkRatio) && r.stats.inkRatio >= 0 && r.stats.inkRatio <= 1,
      '档位 ' + k + ' 墨量非法：' + r.stats.inkRatio);
  });
  var off0 = run(src.slice(), w, h, { mode: 'bleach', inkGrow: 0 });
  for (var i = 0; i < off.data.length; i++) {
    assert(off.data[i] === off0.data[i], '默认与显式关闭结果不一致，位置 ' + i);
  }
  var white = 0;
  for (i = 0; i < on1.data.length; i += 4) if (on1.data[i] > 200) white++;
  assert(white > w * h * 0.6, '开启桥接后整页被判墨，白像素仅 ' + white);
});

check('断笔接续：默认档必须接上 2px 断口（旧版档与关闭档都接不上）', function () {
  var w = 200, h = 120, src = blank(w, h, [255, 255, 255]), holes = [], y, yy, k, p;
  for (y = 20; y <= 80; y += 30) {
    fill(src, w, 20, y, 180, y + 6, [10, 10, 10]);
    for (k = 0; k < 2; k++) {
      for (yy = y; yy < y + 6; yy++) {
        p = (yy * w + 98 + k) * 4;
        src[p] = src[p + 1] = src[p + 2] = 255;
        holes.push(yy * w + 98 + k);
      }
    }
  }
  function nBlack(d) {
    var n = 0;
    for (var i = 0; i < holes.length; i++) {
      var q = holes[i] * 4;
      if (0.299 * d[q] + 0.587 * d[q + 1] + 0.114 * d[q + 2] < 150) n++;
    }
    return n;
  }
  var off = run(src.slice(), w, h, { mode: 'bleach', inkGrow: 0 });
  var on = run(src.slice(), w, h, { mode: 'bleach', inkGrow: 1 });
  var legacy = run(src.slice(), w, h, { mode: 'bleach', inkGrow: 3 });
  assert(nBlack(off.data) <= 1, '关闭档不应补断口，实际补了 ' + nBlack(off.data));
  assert(nBlack(legacy.data) <= 1, '旧版档本就接不上纯白断口（根因证据），实际 ' + nBlack(legacy.data));
  assert(nBlack(on.data) >= holes.length * 0.8,
    '默认档 2px 断口接通率过低：' + nBlack(on.data) + '/' + holes.length);
});

/* ================= 2.4.9 新增：裁切框与统一裁切 =================
 * 统一裁切的"数学"在 core.unifyCrop 里，这里可以直接断言；
 * 页面层（临时画布补白、导出接线）只能靠浏览器回归，见 README 的手动验证清单。 */
console.log('\n-- 2.4.9 裁切框 / 统一裁切 --');

check('裁白边：关闭时返回整页框，开启时框与裁剪尺寸一致', function () {
  var w = 120, h = 90, src = blank(w, h, [255, 255, 255]);
  fill(src, w, 20, 15, 90, 70, [10, 10, 10]);

  var off = run(src.slice(), w, h, { mode: 'bleach', trim: false });
  assert(off.box && off.box.cut === false, '关闭裁白边时 box.cut 应为 false');
  assert(off.box.w === w && off.box.h === h, '关闭时应返回整页框，实际 ' + off.box.w + 'x' + off.box.h);
  assert(off.preW === w && off.preH === h, 'preW/preH 应等于输入尺寸');

  var on = run(src.slice(), w, h, { mode: 'bleach', trim: true });
  assert(on.box && on.box.cut === true, '开启后应判定为需要裁切');
  assert(on.w === on.box.w && on.h === on.box.h,
    '裁后尺寸必须与框一致：' + on.w + 'x' + on.h + ' vs ' + on.box.w + 'x' + on.box.h);
  assert(on.box.x >= 0 && on.box.y >= 0 && on.box.x + on.box.w <= w && on.box.y + on.box.h <= h,
    '裁切框越出页面边界');
  assert(on.box.x <= 20 && on.box.y <= 15 && on.box.x + on.box.w >= 90 && on.box.y + on.box.h >= 70,
    '裁切框没有覆盖墨迹区域，会切到内容');
});

check('裁白边：空白页与墨迹铺满整页时不裁', function () {
  var bl = run(blank(80, 60, [255, 255, 255]), 80, 60, { mode: 'bleach', trim: true });
  assert(bl.box.cut === false && bl.w === 80 && bl.h === 60, '空白页不应产生裁剪');
  // 铺满整页时若仍按墨迹框裁，等于把内容切掉一圈，必须拒绝
  var full = run(blank(80, 60, [10, 10, 10]), 80, 60, { mode: 'bleach', trim: true });
  assert(full.box.cut === false, '墨迹铺满整页时不应裁切');
});

check('统一裁切：各页裁成同一尺寸，且框覆盖每页原内容', function () {
  var items = [
    { key: 'a', preW: 1000, preH: 1400, box: { x: 100, y: 100, w: 800, h: 1200 } },
    { key: 'b', preW: 1000, preH: 1400, box: { x: 100, y: 100, w: 800, h: 900 } },   // 末页只有小半页
    { key: 'c', preW: 1000, preH: 1400, box: { x: 110, y: 100, w: 790, h: 1150 } }
  ];
  var u = DocScan.unifyCrop(items, 0.02);
  assert(!!u, '三页同尺寸应能求出统一框');
  assert(u.w === 800 && u.h === 1200, '并集应为 800x1200，实际 ' + u.w + 'x' + u.h);
  ['a', 'b', 'c'].forEach(function (k) {
    var r = u.rects[k];
    assert(r && r.w === 800 && r.h === 1200, k + ' 页尺寸未统一');
    var b = items[k === 'a' ? 0 : (k === 'b' ? 1 : 2)].box;
    assert(r.x <= b.x && r.y <= b.y && r.x + r.w >= b.x + b.w && r.y + r.h >= b.y + b.h,
      k + ' 页的统一框没有覆盖原裁切框（会切内容）');
  });
});

check('统一裁切：尺寸差 1% 仍归一组，差 20% 退回逐页', function () {
  var near = [
    { key: 'a', preW: 1000, preH: 1400, box: { x: 100, y: 100, w: 800, h: 1200 } },
    { key: 'b', preW: 1010, preH: 1414, box: { x: 101, y: 101, w: 808, h: 1212 } }
  ];
  var u = DocScan.unifyCrop(near, 0.02);
  assert(!!u && u.count === 2, '1% 尺寸差应能统一（开纸张检测后必然有差）');
  assert(u.rects.a.w === u.rects.b.w && u.rects.a.h === u.rects.b.h, '尺寸差相近的两页仍必须同尺寸');

  var far = [
    { key: 'a', preW: 1000, preH: 1400, box: { x: 100, y: 100, w: 800, h: 1200 } },
    { key: 'b', preW: 1600, preH: 2200, box: { x: 100, y: 100, w: 800, h: 1200 } }
  ];
  assert(DocScan.unifyCrop(far, 0.02) === null, '尺寸差过大应退回逐页裁，不能硬凑');
});

check('统一裁切：单页不做统一，框永不越界', function () {
  assert(DocScan.unifyCrop([{ key: 'a', preW: 800, preH: 1000, box: { x: 0, y: 0, w: 800, h: 1000 } }], 0.02) === null,
    '单页没有"统一"的意义，应返回 null');
  var u = DocScan.unifyCrop([
    { key: 'a', preW: 900, preH: 1200, box: { x: 10, y: 10, w: 880, h: 1180 } },
    { key: 'b', preW: 900, preH: 1200, box: { x: 0, y: 0, w: 900, h: 1200 } }
  ], 0.02);
  assert(!!u && u.w === 900 && u.h === 1200, '并集为整页时目标尺寸应为整页');
  ['a', 'b'].forEach(function (k) {
    var r = u.rects[k];
    assert(r.x >= 0 && r.y >= 0 && r.x + r.w <= 900 && r.y + r.h <= 1200, k + ' 页统一框越界');
  });
});

/* ---------------- 2.4.10 全篇识别范围（ROI） ---------------- */
check('ROI 归一化：整页 / 非法 / 过小一律停用，越界夹回页内', function () {
  assert(DocScan.normROI(null) === null, 'null 应停用');
  assert(DocScan.normROI({ x: 0, y: 0, w: 1, h: 1 }) === null, '整页应停用');
  assert(DocScan.normROI({ x: 0.1, y: 0.1, w: NaN, h: 0.5 }) === null, 'NaN 应停用');
  assert(DocScan.normROI({ x: 0.1, y: 0.1, w: 0.01, h: 0.5 }) === null, '过小框应停用');
  assert(DocScan.normROI({ x: -2, y: -1, w: 9, h: 9 }) === null, '钳到整页后应视为停用');
  var q = DocScan.normROI({ x: 0.8, y: 0.8, w: 0.5, h: 0.5 });
  assert(q && Math.abs(q.x + q.w - 1) < 1e-9 && Math.abs(q.y + q.h - 1) < 1e-9, '右下越界应夹回 1');
  var ok = DocScan.normROI({ x: 0.1, y: 0.2, w: 0.7, h: 0.6 });
  assert(ok && ok.w === 0.7 && ok.h === 0.6, '合法框应原样保留');
});

check('ROI 不启用时零拷贝，有效框才产出新缓冲', function () {
  var d = blank(12, 8, [255, 255, 255]);
  var r = DocScan.cropROI(d, 12, 8, null);
  assert(r.data === d && r.cut === false && r.w === 12 && r.h === 8, '应原样返回');
  var r2 = DocScan.cropROI(d, 12, 8, { x: 0, y: 0, w: 1, h: 1 });
  assert(r2.data === d && r2.cut === false, '整页框应等价于不裁');
  var r3 = DocScan.cropROI(d, 12, 8, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  assert(r3.data !== d && r3.cut === true, '有效框必须真的产出新缓冲');
});

check('ROI 物理裁掉页眉与页码：框外像素不进入结果缓冲', function () {
  var w = 60, h = 40, d = blank(w, h, [255, 255, 255]);
  fill(d, w, 0, 1, w, 3, [0, 0, 0]);          // 页眉：整行
  fill(d, w, 26, h - 3, 34, h - 1, [0, 0, 0]); // 页码
  fill(d, w, 10, 18, 50, 20, [0, 0, 0]);      // 正文
  var r = DocScan.cropROI(d, w, h, { x: 0.05, y: 0.15, w: 0.9, h: 0.7 });
  assert(r.cut && r.rect.y === 6 && r.rect.h === 28, '裁切范围应与相对框一致');
  function dark(a, W, y) {
    var n = 0;
    for (var x = 0; x < W; x++) if (lum(a, y * W + x) < 100) n++;
    return n;
  }
  assert(dark(r.data, r.w, 0) === 0, '页眉不应出现在裁后第一行');
  assert(dark(r.data, r.w, r.h - 1) === 0, '页码不应出现在裁后最后一行');
  assert(dark(r.data, r.w, 12) > 20, '正文必须保留');
  assert(dark(d, w, 2) > 0, 'cropROI 不得污染调用方数据');
});

check('ROI 相对坐标在两种页尺寸上比例一致且不越界', function () {
  var roi = { x: 0.12, y: 0.1, w: 0.76, h: 0.8 };
  var a = DocScan.cropROI(blank(200, 300, [255, 255, 255]), 200, 300, roi);
  var b = DocScan.cropROI(blank(400, 600, [255, 255, 255]), 400, 600, roi);
  assert(Math.abs(a.rect.x / 200 - b.rect.x / 400) < 0.01, 'x 比例应一致');
  assert(Math.abs(a.w / 200 - b.w / 400) < 0.01 && Math.abs(a.h / 300 - b.h / 600) < 0.01, '尺寸比例应一致');
  assert(a.rect.x + a.rect.w <= 200 && a.rect.y + a.rect.h <= 300, '不得越出页边界');
  assert(b.rect.x + b.rect.w <= 400 && b.rect.y + b.rect.h <= 600, '不得越出页边界');
});

check('ROI 极端框：贴右下角、最小面积都不产出 0 尺寸', function () {
  var d = blank(50, 30, [255, 255, 255]);
  var r1 = DocScan.cropROI(d, 50, 30, { x: 0.98, y: 0.98, w: 0.02, h: 0.02 });
  assert(r1.rect.x + r1.rect.w <= 50 && r1.rect.y + r1.rect.h <= 30, '右下角框必须被夹住');
  assert(r1.w > 0 && r1.h > 0 && r1.data.length === r1.w * r1.h * 4, '缓冲长度必须自洽');
  var r2 = DocScan.cropROI(d, 50, 30, { x: 0.5, y: 0.5, w: 0.02, h: 0.02 });
  assert(r2.w >= 1 && r2.h >= 1, '最小框至少 1 像素');
});

check('ROI 与自动裁白边组合：页眉不再撑大墨迹外框', function () {
  var w = 80, h = 60, d = blank(w, h, [255, 255, 255]);
  fill(d, w, 2, 2, 78, 4, [0, 0, 0]);        // 页眉横跨整页
  fill(d, w, 20, 25, 30, 27, [0, 0, 0]);     // 正文一小块
  var full = run(d, w, h, { trim: true });
  var r = DocScan.cropROI(d, w, h, { x: 0, y: 0.15, w: 1, h: 0.8 });
  var cut = run(r.data, r.w, r.h, { trim: true });
  assert(full.box.w > cut.box.w, '有页眉时整页墨迹框应更宽');
  assert(cut.preW === r.w && cut.preH === r.h, '裁前尺寸应等于 ROI 后的画布');
});

check('ROI 与统一裁切组合：各页框仍自洽，unifyCrop 给出共用框', function () {
  var roi = { x: 0.08, y: 0.1, w: 0.84, h: 0.8 };
  var items = [];
  for (var i = 0; i < 3; i++) {
    var w = 100, h = 140, d = blank(w, h, [255, 255, 255]);
    fill(d, w, 20 + i * 4, 40, 60 + i * 4, 42, [0, 0, 0]);
    var cr = DocScan.cropROI(d, w, h, roi);
    var r = run(cr.data, cr.w, cr.h, { trim: true });
    items.push({ key: 'p' + i, preW: r.preW, preH: r.preH, box: r.box });
    assert(r.box.x >= 0 && r.box.x + r.box.w <= r.preW, '裁切框必须落在 ROI 画布内');
  }
  var u = DocScan.unifyCrop(items, 0.015);
  assert(u && u.count === 3, '三页应能求出共用框');
  for (var k in u.rects) {
    var q = u.rects[k];
    assert(q.x >= 0 && q.x + q.w <= items[0].preW, '共用框不得越界');
  }
});

Promise.all(pending).then(function () {
  console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项' +
    (skipped ? '，跳过 ' + skipped + ' 项（当前 Node 缺 DecompressionStream）' : '') + '\n');
  process.exit(failed ? 1 : 0);
});
