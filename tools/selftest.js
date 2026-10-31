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
var DocScan = require(path.join(__dirname, '..', 'core.js'));

var BASE = { deskew: 'off', trimEdge: false, edgeClean: 0, sharpen: 0, denoise: 0, maxDim: 2000 };
var passed = 0, failed = 0;

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

function check(name, fn) {
  try {
    fn();
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

check('shade=0 时连续调逐像素不改动（去掉光照校正后原样输出）', function () {
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

check('纸张状况五档的出墨顺序：淡墨 ≥ 标准 ≥ 污渍', function () {
  var w = 400, h = 500, d = blank(w, h, [255, 255, 255]);
  for (var y = 60; y < 440; y += 14) fill(d, w, 60, y, 340, y + 2, [193, 193, 193]);
  var v = {};
  ['faded', 'standard', 'stain'].forEach(function (p) {
    v[p] = run(d, w, h, { mode: 'bleach', preset: p }).stats.inkRatio;
  });
  assert(v.faded >= v.standard && v.standard >= v.stain,
    'faded=' + v.faded.toFixed(4) + ' standard=' + v.standard.toFixed(4) + ' stain=' + v.stain.toFixed(4));
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

console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项\n');
process.exit(failed ? 1 : 0);
