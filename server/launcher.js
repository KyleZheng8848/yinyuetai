#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');
const { RuntimeManager } = require('./runtime-manager');
const { RemoteProviderManager } = require('./remote-provider-manager');
const { SmartComposerManager } = require('./smart-composer-manager');
const APP_VERSION = require('../package.json').version;

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_PREFIXES = ['/css/', '/js/', '/assets/', '/workflows/', '/outputs/'];
const PUBLIC_FILES = new Set(['/node_modules/lamejs/lame.min.js']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ico': 'image/x-icon',
};

function json(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function binary(res, status, result) {
  const body = Buffer.isBuffer(result) ? result : result.buffer;
  res.writeHead(status, {
    'Content-Type': result.contentType || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new Error('JSON 格式无效')); }
    });
    req.on('error', reject);
  });
}

function readBinary(req, maxBytes = 160 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxBytes) {
        rejected = true;
        reject(new Error('参考音频超过 160MB，请缩短后重试'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const source = new URL(origin);
    const host = String(req.headers.host || '');
    return (source.hostname === '127.0.0.1' || source.hostname === 'localhost') && source.host === host;
  } catch (_) { return false; }
}

function proxy(req, res, base, subPath) {
  let target;
  try {
    target = new URL(subPath || '/', base);
    const incoming = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    target.search = incoming.search;
  } catch (error) {
    return json(res, 400, { error: error.message });
  }
  const transport = target.protocol === 'https:' ? https : http;
  const headers = { ...req.headers, host: target.host };
  delete headers.origin;
  delete headers.referer;
  const outbound = transport.request(target, { method: req.method, headers }, (upstream) => {
    const responseHeaders = { ...upstream.headers, 'x-content-type-options': 'nosniff' };
    delete responseHeaders['access-control-allow-origin'];
    res.writeHead(upstream.statusCode || 502, responseHeaders);
    upstream.pipe(res);
  });
  outbound.on('error', (error) => json(res, 502, { error: `本地模型服务不可达：${error.message}` }));
  outbound.setTimeout(30 * 60 * 1000, () => outbound.destroy(new Error('proxy timeout')));
  req.pipe(outbound);
}

function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  if (relative !== 'index.html' && !PUBLIC_FILES.has(pathname) && !PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return json(res, 404, { error: 'not found' });
  }
  const filePath = path.resolve(ROOT, relative);
  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${path.sep}`)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(filePath, (error, data) => {
    if (error) return json(res, 404, { error: 'not found' });
    const headers = {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'Cache-Control': 'no-cache',
    };
    res.writeHead(200, headers);
    res.end(data);
  });
}

function createLauncher(options = {}) {
  const manager = new RuntimeManager({
    runtimeDir: options.runtimeDir,
    localBase: options.localBase,
    music3Base: options.music3Base,
    aceBase: options.aceBase,
    comfyBase: options.comfyBase,
  });
  const remote = new RemoteProviderManager({ runtimeDir: manager.runtimeDir, secretCodec: options.secretCodec });
  const smart = new SmartComposerManager({ runtimeDir: manager.runtimeDir, secretCodec: options.secretCodec });
  const server = http.createServer(async (req, res) => {
    let parsed;
    try { parsed = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`); }
    catch (_) { return json(res, 400, { error: 'bad request' }); }
    const pathname = parsed.pathname;

    if (!originAllowed(req)) return json(res, 403, { error: '跨来源请求已拒绝' });
    if (req.method === 'OPTIONS') return json(res, 405, { error: 'not allowed' });

    try {
      if (pathname === '/api/status' && req.method === 'GET') {
        return json(res, 200, { app: { name: '音悦台', version: APP_VERSION, mode: options.desktop ? 'desktop' : 'web' }, ...(await manager.status()), remote: { providers: remote.list() }, smart: smart.status() });
      }
      if (pathname === '/api/smart/config' && ['POST', 'PUT'].includes(req.method)) {
        return json(res, 200, { ok: true, smart: smart.configure(await readJson(req)) });
      }
      if (pathname === '/api/smart/test' && req.method === 'POST') return json(res, 200, await smart.test());
      if (pathname === '/api/smart/complete' && req.method === 'POST') return json(res, 200, { ok: true, draft: await smart.complete(await readJson(req)) });
      if (pathname === '/api/local/references' && req.method === 'POST') {
        return json(res, 201, { ok: true, reference: manager.storeReferenceAudio(await readBinary(req)) });
      }
      const referenceMatch = pathname.match(/^\/api\/local\/references\/([a-f0-9]{32})$/);
      if (referenceMatch && req.method === 'DELETE') return json(res, 200, { ok: true, removed: manager.removeReferenceAudio(referenceMatch[1]) });
      const localModelMatch = pathname.match(/^\/api\/local\/models\/([^/]+)\/(install|uninstall|generate|cancel|stop)$/);
      if (localModelMatch && localModelMatch[2] === 'install' && req.method === 'POST') {
        return json(res, 202, manager.installLocalModel(decodeURIComponent(localModelMatch[1])));
      }
      if (localModelMatch && localModelMatch[2] === 'uninstall' && req.method === 'POST') {
        return json(res, 200, manager.uninstallLocalModel(decodeURIComponent(localModelMatch[1])));
      }
      if (localModelMatch && localModelMatch[2] === 'generate' && req.method === 'POST') {
        return binary(res, 200, await manager.generateLocal(decodeURIComponent(localModelMatch[1]), await readJson(req)));
      }
      if (localModelMatch && localModelMatch[2] === 'cancel' && req.method === 'POST') {
        return json(res, 200, manager.cancelLocalGeneration(decodeURIComponent(localModelMatch[1])));
      }
      if (localModelMatch && localModelMatch[2] === 'stop' && req.method === 'POST') {
        return json(res, 200, manager.stopLocalModelService(decodeURIComponent(localModelMatch[1])));
      }
      if (pathname === '/api/local/start' && req.method === 'POST') return json(res, 202, await manager.startLocal());
      if (pathname === '/api/local/stop' && req.method === 'POST') return json(res, 200, manager.stop('local'));
      if (pathname === '/api/local/update' && req.method === 'POST') return json(res, 202, manager.updateLocal());

      const remoteMatch = pathname.match(/^\/api\/remote\/providers\/([^/]+)\/(config|test|generate)$/);
      if (remoteMatch && remoteMatch[2] === 'config' && ['POST', 'PUT'].includes(req.method)) {
        return json(res, 200, { ok: true, provider: remote.configure(decodeURIComponent(remoteMatch[1]), await readJson(req)) });
      }
      if (remoteMatch && remoteMatch[2] === 'test' && req.method === 'POST') {
        return json(res, 200, await remote.test(decodeURIComponent(remoteMatch[1])));
      }
      if (remoteMatch && remoteMatch[2] === 'generate' && req.method === 'POST') {
        return binary(res, 200, await remote.generate(decodeURIComponent(remoteMatch[1]), await readJson(req)));
      }
      if (pathname === '/api/music3/install' && req.method === 'POST') return json(res, 202, manager.installMusic3());
      if (pathname === '/api/music3/update' && req.method === 'POST') return json(res, 202, manager.updateMusic3());
      if (pathname === '/api/music3/start' && req.method === 'POST') return json(res, 202, await manager.startMusic3());
      if (pathname === '/api/music3/stop' && req.method === 'POST') return json(res, 200, manager.stop('music3'));
      if (pathname === '/api/ace/config' && req.method === 'POST') return json(res, 200, { ok: true, config: manager.configureAce(await readJson(req)) });
      if (pathname === '/api/comfy/config' && req.method === 'POST') return json(res, 200, { ok: true, config: manager.configureComfy(await readJson(req)) });
      if (pathname === '/api/comfy/start' && req.method === 'POST') return json(res, 202, await manager.startComfy(await readJson(req)));
      if (pathname === '/api/comfy/stop' && req.method === 'POST') return json(res, 200, manager.stop('comfy'));
      if (pathname === '/api/logs' && req.method === 'GET') {
        return json(res, 200, { runtime: parsed.searchParams.get('runtime') || 'ace', lines: manager.getLogs(parsed.searchParams.get('runtime'), parsed.searchParams.get('tail')) });
      }

      if (pathname.startsWith('/local/')) return proxy(req, res, manager.config.localBase, pathname.slice('/local'.length));
      if (pathname.startsWith('/music3/')) return proxy(req, res, manager.config.music3Base, pathname.slice('/music3'.length));
      if (pathname.startsWith('/ace/')) return proxy(req, res, manager.config.aceBase, pathname.slice('/ace'.length));
      if (pathname.startsWith('/comfy/')) return proxy(req, res, manager.config.comfyBase, pathname.slice('/comfy'.length));
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
      return serveStatic(res, pathname);
    } catch (error) {
      return json(res, 400, { error: error.message || String(error) });
    }
  });

  function listen() {
    const requestedPort = options.port == null ? Number(process.env.PORT || 8799) : Number(options.port);
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(requestedPort, '127.0.0.1', () => {
        server.removeListener('error', reject);
        const address = server.address();
        const baseUrl = `http://127.0.0.1:${address.port}`;
        resolve({ baseUrl, port: address.port, server, manager, remote });
      });
    });
  }

  async function close() {
    manager.stopAll();
    if (!server.listening) return;
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, manager, remote, smart, listen, close };
}

if (require.main === module) {
  const launcher = createLauncher();
  launcher.listen().then(({ baseUrl, manager }) => {
    console.log(`\n  音悦台 Studio → ${baseUrl}/`);
    console.log(`  本地音频引擎 → ${manager.config.localBase}`);
    console.log(`  ACE-Step 兼容端点 → ${manager.config.aceBase}`);
    console.log(`  ComfyUI → ${manager.config.comfyBase}\n`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  const shutdown = async () => { await launcher.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createLauncher, originAllowed };
