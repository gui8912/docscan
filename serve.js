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
http.createServer((req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  } catch (e) {
    res.writeHead(400); res.end('bad request'); return;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  // 防目录穿越：目录边界必须包含分隔符，不能误放同名前缀的兄弟目录
  const file = path.resolve(ROOT, '.' + rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      // modified：404 必须显式声明纯文本，且不回显请求路径。
      // 不设 Content-Type 时浏览器会按内容嗅探，请求路径里的标记会被当成 HTML 执行。
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}).listen(PORT, HOST, () => {
  console.log('澄文扫描台 已启动：http://' + HOST + ':' + PORT + '/');
  console.log('按 Ctrl+C 停止。');
});
