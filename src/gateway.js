'use strict';

const http = require('node:http');
const fs = require('node:fs');
const { WebSocketServer } = require('ws');

const WS_PORT = 18789;
const HTTP_PORT = 18790;
const CONFIG_PATH = '/home/node/.openclaw/openclaw.json';
const HEARTBEAT_INTERVAL = 30_000;

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

// --- WebSocket Server ---

const wss = new WebSocketServer({ port: WS_PORT }, () => {
  log('info', 'WebSocket server listening', { port: WS_PORT });
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

  log('info', 'Client connected', { ip: req.socket.remoteAddress });

  ws.on('message', (data) => {
    log('info', 'Message received', { size: data.length });
    ws.send(data);
  });

  ws.on('close', (code, reason) => {
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

const httpServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.writeHead(404);
  res.end();
});

httpServer.listen(HTTP_PORT, () => {
  log('info', 'HTTP health server listening', { port: HTTP_PORT });
});

// --- Graceful Shutdown ---

function shutdown(signal) {
  log('info', 'Shutting down', { signal });

  clearInterval(pingInterval);

  wss.clients.forEach((ws) => ws.close(1001, 'Server shutting down'));

  wss.close(() => {
    httpServer.close(() => {
      log('info', 'Shutdown complete');
      process.exit(0);
    });
  });

  setTimeout(() => {
    log('warn', 'Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

log('info', 'OpenClaw Gateway v0.1.0 started', { config: Object.keys(config) });
