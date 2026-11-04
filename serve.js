'use strict';
/* 零依赖静态服务器：双击 serve.bat 或 `node serve.js` 即可，
 * 默认监听 127.0.0.1:8765，只服务本目录，不对外网开放。 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8765;
const HOST = '127.0.0.1';
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
};

// modified：补充非法 URL 解码处理与目录边界校验，避免异常请求打垮服务或访问兄弟目录。
const server = http.createServer((req, res) => {
  // modified：所有纯文本响应统一带 Content-Type 与 nosniff。
  // 原来 400/403 没有 MIME，浏览器会嗅探内容；200 也没有 nosniff。
  function send(code, text) {
    res.writeHead(code, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    });
    res.end(req.method === 'HEAD' ? undefined : text);
  }
  // modified：只服务静态 GET/HEAD。原实现 POST /index.html 也会返回全文。
  if (req.method !== 'GET' && req.method !== 'HEAD') { send(405, 'method not allowed'); return; }
  let rel;
  try {
    rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  } catch (e) {
    send(400, 'bad request'); return;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  // modified：拒绝控制字符（含 %00）与任何以点开头的路径段。
  // 原实现只做词法前缀校验，GET /.git/config 会把仓库配置原样返回（实测 200）。
  if (/[\x00-\x1f]/.test(rel)) { send(400, 'bad request'); return; }
  if (/(^|\/)\./.test(rel)) { send(403, 'forbidden'); return; }
  // 防目录穿越：目录边界必须包含分隔符，不能误放同名前缀的兄弟目录
  const file = path.resolve(ROOT, '.' + rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    send(403, 'forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      // modified：404 必须显式声明纯文本，且不回显请求路径。
      // 不设 Content-Type 时浏览器会按内容嗅探，请求路径里的标记会被当成 HTML 执行。
      send(404, 'not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});
// modified：端口被占用时原来会以未捕获的 'error' 事件崩掉进程，且没有任何提示。
server.on('error', (e) => {
  console.error('服务启动失败：' + e.message + '（端口 ' + PORT + ' 已被占用，可用 PORT=8799 之类换端口重试）');
  process.exitCode = 1;
});
server.listen(PORT, HOST, () => {
  console.log('澄文扫描台 已启动：http://' + HOST + ':' + PORT + '/');
  console.log('按 Ctrl+C 停止。');
});
