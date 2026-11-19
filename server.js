'use strict';
// Just Chat - serveur minimal, zéro dépendance.
// Temps réel via Server-Sent Events (réception) + POST (envoi).
// Les messages vivent en mémoire : ils disparaissent au redémarrage.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8787);
const APP_DIR = path.join(__dirname, 'app');
const MAX_MESSAGES = 200;
const MAX_TEXT = 1000;
const MAX_NAME = 24;
const MAX_BODY = 8192;
const MIN_DELAY = 250; // ms entre deux messages d'un même client

const messages = [];
const clients = new Map(); // id de connexion -> { res, name, clientId }
const lastPost = new Map(); // clientId -> timestamp
let nextId = 1;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function headers(type) {
  return {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  };
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, headers(type));
  res.end(body);
}

function json(res, status, data) {
  send(res, status, JSON.stringify(data));
}

// Nettoie les caractères de contrôle, garde les retours à la ligne.
function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

function presence() {
  const byClient = new Map();
  for (const c of clients.values()) {
    if (c.name) byClient.set(c.clientId, { clientId: c.clientId, name: c.name });
  }
  return [...byClient.values()];
}

function broadcast(event, data) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients.values()) {
    try { c.res.write(chunk); } catch { /* client parti */ }
  }
}

function broadcastPresence() {
  const users = presence();
  broadcast('presence', { users, count: users.length });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Requête trop volumineuse'), { status: 413 }));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('JSON invalide'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'Requête invalide', 'text/plain'); }
  if (rel === '/' || rel === '') rel = '/index.html';

  const file = path.resolve(APP_DIR, '.' + rel);
  if (file !== APP_DIR && !file.startsWith(APP_DIR + path.sep)) {
    return send(res, 403, 'Accès refusé', 'text/plain');
  }
  fs.readFile(file, (err, buffer) => {
    if (err) return send(res, 404, 'Introuvable', 'text/plain; charset=utf-8');
    send(res, 200, buffer, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers('text/plain'));
    return res.end();
  }

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, users: presence().length, messages: messages.length });
    }

    if (req.method === 'GET' && url.pathname === '/api/messages') {
      const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
      return json(res, 200, { messages: messages.filter((m) => m.id > after).slice(-MAX_MESSAGES) });
    }

    if (req.method === 'GET' && url.pathname === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*'
      });

      const id = crypto.randomUUID();
      const clientId = clean(url.searchParams.get('clientId'), 64) || id;
      const name = clean(url.searchParams.get('name'), MAX_NAME) || 'Anonyme';
      clients.set(id, { res, name, clientId });

      res.write(`event: snapshot\ndata: ${JSON.stringify({
        messages: messages.slice(-MAX_MESSAGES),
        users: presence()
      })}\n\n`);
      broadcastPresence();

      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* ignoré */ }
      }, 25000);

      res.on('close', () => {
        clearInterval(ping);
        clients.delete(id);
        broadcastPresence();
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/message') {
      const body = await readBody(req);
      const name = clean(body.name, MAX_NAME) || 'Anonyme';
      const text = clean(body.text, MAX_TEXT);
      const clientId = clean(body.clientId, 64) || crypto.randomUUID();

      if (!text) return json(res, 400, { error: 'Message vide' });

      const now = Date.now();
      if (now - (lastPost.get(clientId) || 0) < MIN_DELAY) {
        return json(res, 429, { error: 'Un peu trop vite' });
      }
      lastPost.set(clientId, now);

      const message = { id: nextId++, name, text, ts: now, clientId };
      messages.push(message);
      if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);

      broadcast('message', message);
      return json(res, 200, { ok: true, message });
    }

    if (req.method === 'GET') return serveStatic(res, url.pathname);

    return json(res, 404, { error: 'Introuvable' });
  } catch (err) {
    if (!res.headersSent) json(res, err.status || 500, { error: err.message || 'Erreur serveur' });
    else res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Just Chat pret.');
  console.log(`  PC      : http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  Telephone: http://${net.address}:${PORT}  (meme Wi-Fi)`);
      }
    }
  }
});
