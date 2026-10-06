import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };

async function readJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('Send JSON with Content-Type: application/json.'), { status: 415 });
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (Buffer.byteLength(text) > 8192) throw Object.assign(new Error('Request is too large.'), { status: 413 });
  }
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

export function createAppServer(monitor, { staticDirectory = resolve('dist') } = {}) {
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    const json = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (request.method === 'GET' && url.pathname === '/api/status') return json(200, monitor.status());
        if (request.method === 'GET' && url.pathname === '/api/health') return json(200, { ok: true });
        if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
        // No login layer; same-origin JSON avoids accidental requests from unrelated web pages.
        if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) return json(403, { error: 'Cross-origin requests are not allowed.' });
        const body = await readJson(request);
        if (url.pathname === '/api/refresh') return json(200, await monitor.refresh());
        if (url.pathname === '/api/settings') {
          try { return json(200, await monitor.setSettings(body)); }
          catch (error) { return json(400, { error: error.message }); }
        }
        if (url.pathname === '/api/apply') {
          if (typeof body.creditId !== 'string' || !body.creditId.length || body.creditId.length > 512) return json(400, { error: 'A reset ID is required.' });
          return json(200, await monitor.apply(body.creditId));
        }
        return json(404, { error: 'Unknown API route.' });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'Method not allowed.' });
      const pathname = decodeURIComponent(url.pathname);
      const path = resolve(staticDirectory, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!path.startsWith(`${resolve(staticDirectory)}${sep}`)) return json(403, { error: 'Invalid path.' });
      let content;
      try { content = await readFile(path); }
      catch (error) {
        if (error.code === 'ENOENT') return json(404, { error: 'Page not found. Run npm run build to build the dashboard.' });
        throw error;
      }
      response.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) { json(error.status || 502, { error: error.message || 'Unable to complete the request.' }); }
  });
}
