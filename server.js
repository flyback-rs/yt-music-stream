const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.json': 'application/json'
};

const server = http.createServer(async (req, res) => {
  try {
    const safePath = path.normalize(req.url).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(__dirname, 'web', safePath === '/' ? 'overlay.html' : safePath);

    if (!filePath.startsWith(path.join(__dirname, 'web'))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

function startServer() {
  server.listen(8080, '127.42.0.69', () => {
    console.log('Overlay server running at http://127.42.0.69:8080');
  });
}

module.exports = { startServer };
