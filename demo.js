/* =============================================================
 * demo.js — 合成示例：模拟"手机顺手拍的一张红头文件"
 * 用于一键体验 / 算法自检（含透视、斜向光斑、手机阴影、传感器噪点）
 * ============================================================= */
(function (global) {
  'use strict';

  var BODY = [
    '各区县市场监督管理局，市局各有关处室、直属单位：',
    '为深入贯彻落实食品安全"四个最严"要求，进一步压实属地监管责任和',
    '企业主体责任，切实保障人民群众"舌尖上的安全"，经研究，决定于2026年',
    '11月至12月在全市范围内开展食品安全专项检查。现将有关事项通知如下。',
    '一、检查范围',
    '全市食品生产企业、食品加工小作坊、农贸市场、大型商超、餐饮服务单位，',
    '重点检查学校食堂、集体用餐配送单位、中央厨房及网络订餐平台入网商户。',
    '二、检查重点',
    '（一）主体资格。严查无证无照经营、超范围经营、出租出借许可证等行为。',
    '（二）原料采购。核查进货查验记录、供货者资质、检验合格证明是否齐全。',
    '（三）加工过程。重点检查交叉污染防控、食品添加剂使用、留样管理情况。',
    '（四）标签标识。排查虚假标注生产日期、保质期及成分表等突出问题。',
    '三、工作要求',
    '（一）加强组织领导。各单位要成立工作专班，主要负责同志亲自部署，',
    '确保检查工作不留死角、不走过场。',
    '（二）严格依法处置。对检查中发现的违法违规行为，要依法从严查处；',
    '涉嫌犯罪的，及时移送公安机关。',
    '（三）及时报送信息。请各单位于2026年12月20日前将工作总结报送市局',
    '食品经营安全监督管理处，联系人：张××，联系电话：010-8888××××。'
  ];

  function arcText(ctx, text, cx, cy, r, startAngle, endAngle, font) {
    ctx.save();
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var n = text.length;
    for (var i = 0; i < n; i++) {
      var t = n === 1 ? 0.5 : i / (n - 1);
      var ang = startAngle + (endAngle - startAngle) * t;
      ctx.save();
      ctx.translate(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
      ctx.rotate(ang + Math.PI / 2);
      ctx.fillText(text[i], 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  function makeDoc(scale) {
    scale = scale || 1;
    var W = 1240, H = 1754; // A4 @150dpi
    var c = document.createElement('canvas');
    c.width = Math.round(W * scale); c.height = Math.round(H * scale);
    var x = c.getContext('2d');
    x.scale(scale, scale);
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, W, H);

    // 红头
    x.fillStyle = '#c81e1e';
    x.font = 'bold 58px "SimSun","宋体",serif';
    x.textAlign = 'center';
    x.textBaseline = 'alphabetic';
    x.fillText('××市市场监督管理局文件', W / 2, 160);

    // 红色横线 + 五角星分隔
    x.fillStyle = '#c81e1e';
    x.fillRect(90, 196, W - 180, 4);

    // 发文字号
    x.fillStyle = '#1a1a1a';
    x.font = '22px "SimSun","宋体",serif';
    x.fillText('×市监发〔2026〕15号', W / 2, 246);

    // 分隔线
    x.fillStyle = '#c81e1e';
    x.fillRect(90, 268, W - 180, 2);

    // 标题
    x.fillStyle = '#111111';
    x.font = 'bold 34px "SimSun","宋体",serif';
    x.fillText('关于开展2026年度食品安全', W / 2, 360);
    x.fillText('专项检查的通知', W / 2, 408);

    // 正文
    x.textAlign = 'left';
    x.font = '24px "SimSun","宋体",serif';
    x.fillStyle = '#1a1a1a';
    var y = 490;
    for (var i = 0; i < BODY.length; i++) {
      var line = BODY[i];
      var indent = (i === 0) ? 0 : 48;
      x.fillText(line, 96 + indent, y);
      y += 46;
    }

    // 图片区（模拟插入的现场照片）
    var px = 96, py = y + 10, pw = 320, ph = 210;
    var grad = x.createLinearGradient(px, py, px + pw, py + ph);
    grad.addColorStop(0, '#8d99ae');
    grad.addColorStop(0.5, '#5c6b82');
    grad.addColorStop(1, '#39465c');
    x.fillStyle = grad;
    x.fillRect(px, py, pw, ph);
    x.fillStyle = 'rgba(255,255,255,0.25)';
    x.beginPath(); x.arc(px + 90, py + 70, 34, 0, 7); x.fill();
    x.fillStyle = 'rgba(255,255,255,0.12)';
    x.fillRect(px, py + 140, pw, 40);
    x.strokeStyle = '#b9c2cf'; x.lineWidth = 2;
    x.strokeRect(px, py, pw, ph);

    // 印章（红色圆形 + 五角星 + 环形文字）
    var sx = 900, sy = 1500, sr = 108;
    x.save();
    x.globalAlpha = 0.82;
    x.strokeStyle = '#c81e1e';
    x.lineWidth = 7;
    x.beginPath(); x.arc(sx, sy, sr, 0, Math.PI * 2); x.stroke();
    // 五角星
    x.fillStyle = '#c81e1e';
    x.beginPath();
    for (var k = 0; k < 5; k++) {
      var a1 = -Math.PI / 2 + k * Math.PI * 2 / 5;
      var a2 = a1 + Math.PI / 5;
      x.lineTo(sx + Math.cos(a1) * 32, sy + Math.sin(a1) * 32);
      x.lineTo(sx + Math.cos(a2) * 13, sy + Math.sin(a2) * 13);
    }
    x.closePath(); x.fill();
    arcText(x, '××市市场监督管理局', sx, sy, sr - 22, -Math.PI * 0.94, -Math.PI * 0.06, 'bold 21px "SimSun","宋体",serif');
    x.restore();

    // 落款
    x.fillStyle = '#1a1a1a';
    x.font = '24px "SimSun","宋体",serif';
    x.textAlign = 'right';
    x.fillText('××市市场监督管理局', W - 120, 1650);
    x.fillText('2026年10月28日', W - 120, 1700);

    // 纸张微纹理（真实纸面不是纯白）
    var img = x.getImageData(0, 0, c.width, c.height);
    var d = img.data;
    for (var q = 0; q < d.length; q += 4) {
      var v = (Math.random() - 0.5) * 6;
      d[q] += v; d[q + 1] += v; d[q + 2] += v;
    }
    x.putImageData(img, 0, 0);
    return c;
  }

  // 单应矩阵：把 dst 四点映射到 src 四点（8 元一次方程组，高斯消元）
  function solveH(dst, src) {
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var x = dst[i].x, y = dst[i].y, u = src[i].x, v = src[i].y;
      A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
    }
    for (var k = 0; k < 8; k++) {
      var piv = k;
      for (var r = k + 1; r < 8; r++) if (Math.abs(A[r][k]) > Math.abs(A[piv][k])) piv = r;
      if (piv !== k) { var t = A[k]; A[k] = A[piv]; A[piv] = t; var tb = b[k]; b[k] = b[piv]; b[piv] = tb; }
      for (r = k + 1; r < 8; r++) {
        var f = A[r][k] / (A[k][k] || 1e-12);
        if (!f) continue;
        for (var c = k; c < 8; c++) A[r][c] -= f * A[k][c];
        b[r] -= f * b[k];
      }
    }
    var out = new Float64Array(8);
    for (k = 7; k >= 0; k--) {
      var sum = b[k];
      for (var j = k + 1; j < 8; j++) sum -= A[k][j] * out[j];
      out[k] = sum / (A[k][k] || 1e-12);
    }
    return out;
  }

  // 逐像素反算把文件贴到桌面（无网格接缝，2×2 超采样）
  function drawWarped(ctx, img, quad) {
    var W = img.width, H = img.height;
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    quad.forEach(function (p) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    });
    var ox = Math.max(0, Math.floor(minX) - 2), oy = Math.max(0, Math.floor(minY) - 2);
    var ow = Math.min(ctx.canvas.width - ox, Math.ceil(maxX - minX) + 5);
    var oh = Math.min(ctx.canvas.height - oy, Math.ceil(maxY - minY) + 5);

    var srcData = img.getContext('2d').getImageData(0, 0, W, H).data;
    var out = ctx.createImageData(ow, oh);
    var od = out.data;
    var Hm = solveH(quad, [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }]);
    var a = Hm[0], b = Hm[1], c = Hm[2], d = Hm[3], e = Hm[4], f = Hm[5], g = Hm[6], h = Hm[7];

    function tap(u, v, o) {
      if (u < 0 || v < 0 || u > W - 1 || v > H - 1) return false;
      var x0 = u | 0, y0 = v | 0;
      var x1 = x0 + 1 < W ? x0 + 1 : x0, y1 = y0 + 1 < H ? y0 + 1 : y0;
      var fx = u - x0, fy = v - y0;
      var i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4;
      var i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
      var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      o[0] += srcData[i00] * w00 + srcData[i10] * w10 + srcData[i01] * w01 + srcData[i11] * w11;
      o[1] += srcData[i00 + 1] * w00 + srcData[i10 + 1] * w10 + srcData[i01 + 1] * w01 + srcData[i11 + 1] * w11;
      o[2] += srcData[i00 + 2] * w00 + srcData[i10 + 2] * w10 + srcData[i01 + 2] * w01 + srcData[i11 + 2] * w11;
      return true;
    }

    var acc = [0, 0, 0];
    for (var y = 0; y < oh; y++) {
      for (var x = 0; x < ow; x++) {
        var px = ox + x + 0.5, py = oy + y + 0.5;
        // 2×2 超采样
        acc[0] = acc[1] = acc[2] = 0;
        var hit = 0;
        for (var sy = -0.25; sy <= 0.25; sy += 0.5) {
          for (var sx = -0.25; sx <= 0.25; sx += 0.5) {
            var X = px + sx, Y = py + sy;
            var den = g * X + h * Y + 1;
            var u = (a * X + b * Y + c) / den;
            var v = (d * X + e * Y + f) / den;
            if (tap(u, v, acc)) hit++;
          }
        }
        if (!hit) continue;
        var o = (y * ow + x) * 4;
        od[o] = acc[0] / hit; od[o + 1] = acc[1] / hit; od[o + 2] = acc[2] / hit;
        od[o + 3] = (hit / 4) * 255;
      }
    }
    var tmp = document.createElement('canvas');
    tmp.width = ow; tmp.height = oh;
    tmp.getContext('2d').putImageData(out, 0, 0);
    ctx.drawImage(tmp, ox, oy);
  }

  function makePhoto(opt) {
    opt = opt || {};
    var k = opt.scale || 1;
    var W = Math.round(1120 * k), H = Math.round(1480 * k);
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var x = c.getContext('2d');

    // 桌面（深灰木纹感）
    var bg = x.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#5b5f66');
    bg.addColorStop(0.45, '#3d4046');
    bg.addColorStop(1, '#2a2d31');
    x.fillStyle = bg;
    x.fillRect(0, 0, W, H);
    for (var i = 0; i < 900; i++) {
      x.fillStyle = 'rgba(255,255,255,' + (Math.random() * 0.03) + ')';
      x.fillRect(Math.random() * W, Math.random() * H, Math.random() * 160 + 20, 1);
    }

    // 文件（带透视，略旋转）
    var doc = makeDoc(k);
    var quad = [
      { x: 118 * k, y: 74 * k },
      { x: 995 * k, y: 132 * k },
      { x: 966 * k, y: 1398 * k },
      { x: 96 * k, y: 1332 * k }
    ];
    // 投影
    x.save();
    x.filter = 'blur(18px)';
    x.fillStyle = 'rgba(0,0,0,0.45)';
    x.beginPath();
    x.moveTo(quad[0].x + 16 * k, quad[0].y + 22 * k);
    x.lineTo(quad[1].x + 22 * k, quad[1].y + 26 * k);
    x.lineTo(quad[2].x + 20 * k, quad[2].y + 22 * k);
    x.lineTo(quad[3].x + 14 * k, quad[3].y + 20 * k);
    x.closePath(); x.fill();
    x.restore();

    drawWarped(x, doc, quad, 26, 36);

    // 光照：左上强光 + 斜向阴影带 + 手机遮挡阴影
    var lg = x.createRadialGradient(330 * k, 250 * k, 40 * k, 330 * k, 250 * k, 1050 * k);
    lg.addColorStop(0, 'rgba(255,255,255,0.30)');
    lg.addColorStop(0.45, 'rgba(255,255,255,0.06)');
    lg.addColorStop(1, 'rgba(0,0,0,0.30)');
    x.globalCompositeOperation = 'multiply';
    x.fillStyle = lg;
    x.fillRect(0, 0, W, H);

    var sg = x.createLinearGradient(420*k, 0, 1120*k, 1100*k);
    sg.addColorStop(0, 'rgba(255,255,255,1)');
    sg.addColorStop(0.34, 'rgba(255,255,255,1)');
    sg.addColorStop(0.55, 'rgba(150,150,155,1)');
    sg.addColorStop(1, 'rgba(96,96,104,1)');
    x.fillStyle = sg;
    x.fillRect(0, 0, W, H);
    x.globalCompositeOperation = 'source-over';

    // 手机一侧的软阴影
    x.save();
    x.filter = 'blur(60px)';
    x.fillStyle = 'rgba(0,0,0,0.34)';
    x.beginPath();
    x.ellipse(930 * k, 760 * k, 210 * k, 760 * k, -0.14, 0, Math.PI * 2);
    x.fill();
    x.restore();

    // 传感器噪点 + 轻微模糊
    var img = x.getImageData(0, 0, W, H);
    var d = img.data;
    for (var p = 0; p < d.length; p += 4) {
      var nz = (Math.random() + Math.random() + Math.random() - 1.5) * 9;
      d[p] += nz; d[p + 1] += nz; d[p + 2] += nz;
    }
    x.putImageData(img, 0, 0);

    // 输出为带压缩的画布
    var out = document.createElement('canvas');
    out.width = W; out.height = H;
    var o = out.getContext('2d');
    o.filter = 'blur(0.4px)';
    o.drawImage(c, 0, 0);
    o.filter = 'none';
    return out;
  }

  function makeTextScan() {
    // 模拟"纯文字"的一页，用于体积测试
    return makeDoc();
  }

  global.DocScanDemo = { makeDoc: makeDoc, makePhoto: makePhoto, makeTextScan: makeTextScan };
})(typeof window !== 'undefined' ? window : globalThis);
