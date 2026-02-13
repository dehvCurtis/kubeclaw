'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { Ollama } = require('ollama');
const { Agent } = require('./agent');

const WS_PORT = 18789;
const HTTP_PORT = 18790;
const CONFIG_PATH = '/home/node/.openclaw/openclaw.json';
const HEARTBEAT_INTERVAL = 30_000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MAX_MESSAGE_SIZE = 65_536;  // 64 KB
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW = 60_000; // 60 seconds

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// --- Prometheus Metrics ---

let connectionsActive = 0;
let connectionsTotal = 0;
let messagesTotal = 0;
let errorsTotal = 0;
let rateLimitedTotal = 0;

function formatMetrics() {
  return [
    '# HELP openclaw_ws_connections_active Current open WebSocket connections',
    '# TYPE openclaw_ws_connections_active gauge',
    `openclaw_ws_connections_active ${connectionsActive}`,
    '',
    '# HELP openclaw_ws_connections_total Total WebSocket connections since start',
    '# TYPE openclaw_ws_connections_total counter',
    `openclaw_ws_connections_total ${connectionsTotal}`,
    '',
    '# HELP openclaw_ws_messages_total Total messages received',
    '# TYPE openclaw_ws_messages_total counter',
    `openclaw_ws_messages_total ${messagesTotal}`,
    '',
    '# HELP openclaw_ws_errors_total Total errors sent',
    '# TYPE openclaw_ws_errors_total counter',
    `openclaw_ws_errors_total ${errorsTotal}`,
    '',
    '# HELP openclaw_ws_rate_limited_total Total rate-limited rejections',
    '# TYPE openclaw_ws_rate_limited_total counter',
    `openclaw_ws_rate_limited_total ${rateLimitedTotal}`,
    '',
  ].join('\n');
}

function log(level, msg, extra = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...extra };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    log('warn', 'Config not found, using defaults', { path: CONFIG_PATH });
    return {};
  }
}

const config = loadConfig();
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const ollama = new Ollama({ host: process.env.OLLAMA_HOST || 'http://ollama:11434' });

// --- Static file serving ---

function serveStatic(req, res) {
  let urlPath = new URL(req.url, `http://localhost:${WS_PORT}`).pathname;

  // SPA fallback: serve index.html for / and paths without a file extension
  if (urlPath === '/' || !path.extname(urlPath)) {
    urlPath = '/index.html';
  }

  const filePath = path.join(PUBLIC_DIR, urlPath);

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end();
      return;
    }
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// --- HTTP + WebSocket Server (port 18789) ---

const server = http.createServer(serveStatic);

const wss = new WebSocketServer({ server });

server.listen(WS_PORT, () => {
  log('info', 'HTTP + WebSocket server listening', { port: WS_PORT });
});

function heartbeat() {
  this.isAlive = true;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${WS_PORT}`);
  const token = url.searchParams.get('token') || req.headers['x-gateway-token'] || '';

  if (GATEWAY_TOKEN && token !== GATEWAY_TOKEN) {
    log('warn', 'Authentication failed', { ip: req.socket.remoteAddress });
    ws.close(4401, 'Unauthorized');
    return;
  }

  ws.isAlive = true;
  ws.on('pong', heartbeat);

  const agent = new Agent(ollama, config, log);
  const messageTimestamps = [];

  connectionsActive++;
  connectionsTotal++;

  log('info', 'Client connected', { ip: req.socket.remoteAddress });

  function send(obj) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function sendError(code, message) {
    errorsTotal++;
    send({ type: 'error', code, message });
  }

  ws.on('message', (data) => {
    // Message size check (before JSON.parse)
    if (data.length > MAX_MESSAGE_SIZE) {
      rateLimitedTotal++;
      sendError('message_too_large', `Message exceeds maximum size of ${MAX_MESSAGE_SIZE} bytes`);
      return;
    }

    // Rate limiting
    const now = Date.now();
    messageTimestamps.push(now);
    // Remove timestamps outside the window
    while (messageTimestamps.length > 0 && messageTimestamps[0] <= now - RATE_LIMIT_WINDOW) {
      messageTimestamps.shift();
    }
    if (messageTimestamps.length > RATE_LIMIT_MAX) {
      rateLimitedTotal++;
      sendError('rate_limited', `Rate limit exceeded: max ${RATE_LIMIT_MAX} messages per ${RATE_LIMIT_WINDOW / 1000}s`);
      return;
    }

    messagesTotal++;

    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      sendError('invalid_message', 'Invalid JSON');
      return;
    }

    if (!msg.type) {
      sendError('invalid_message', 'Missing type field');
      return;
    }

    if (msg.type === 'reset') {
      agent.reset();
      send({ type: 'done', usage: null });
      return;
    }

    if (msg.type === 'message') {
      if (typeof msg.content !== 'string' || !msg.content.trim()) {
        sendError('invalid_message', 'Missing or empty content');
        return;
      }

      log('info', 'Message received', { size: msg.content.length });

      agent.stream(msg.content, {
        onChunk: (text) => send({ type: 'chunk', content: text }),
        onDone: (usage) => send({ type: 'done', usage }),
        onError: (err) => {
          errorsTotal++;
          send({ type: 'error', code: err.code, message: err.message });
        },
      });
      return;
    }

    sendError('invalid_message', `Unknown type: ${msg.type}`);
  });

  ws.on('close', (code, reason) => {
    connectionsActive--;
    log('info', 'Client disconnected', { code, reason: reason.toString() });
  });
});

const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

wss.on('close', () => clearInterval(pingInterval));

// --- HTTP Health Server ---

const healthServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.method === 'GET' && req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(formatMetrics());
    return;
  }
  res.writeHead(404);
  res.end();
});

healthServer.listen(HTTP_PORT, () => {
  log('info', 'HTTP health server listening', { port: HTTP_PORT });
});

// --- Graceful Shutdown ---

function shutdown(signal) {
  log('info', 'Shutting down', { signal });

  clearInterval(pingInterval);

  wss.clients.forEach((ws) => ws.close(1001, 'Server shutting down'));

  wss.close(() => {
    server.close(() => {
      healthServer.close(() => {
        log('info', 'Shutdown complete');
        process.exit(0);
      });
    });
  });

  setTimeout(() => {
    log('warn', 'Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

log('info', 'OpenClaw Gateway v0.5.0 started', { config: Object.keys(config) });
