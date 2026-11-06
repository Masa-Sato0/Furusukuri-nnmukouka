'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
function start(port = 8787) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const files = {'/': 'test-page.html', '/second.html': 'second.html', '/frame.html': 'frame.html', '/frame.js': 'frame.js', '/test-page.js': 'test-page.js', '/test-page.css': 'test-page.css'};
    const file = files[pathname] || (pathname.startsWith('/spa/') ? 'test-page.html' : null);
    if (!file) { res.writeHead(404); res.end('Not found'); return; }
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    res.writeHead(200, {'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store'});
    res.end(fs.readFileSync(path.join(__dirname, file)));
  });
  return new Promise(resolve => { server.listen(port, '0.0.0.0', () => resolve(server)); });
}
module.exports = {start};
if (require.main === module) start().then(() => console.log('ローカルテスト: http://localhost:8787 （終了はCtrl+C）'));
