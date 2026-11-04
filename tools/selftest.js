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

Promise.all(pending).then(function () {
  console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项' +
    (skipped ? '，跳过 ' + skipped + ' 项（当前 Node 缺 DecompressionStream）' : '') + '\n');
  process.exit(failed ? 1 : 0);
});
