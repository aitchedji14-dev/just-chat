'use strict';

const LS = {
  name: 'justchat.name',
  server: 'justchat.server',
  client: 'justchat.clientId'
};

const $ = (id) => document.getElementById(id);
const native = typeof window.JustNative !== 'undefined' && !!window.JustNative;

let name = (localStorage.getItem(LS.name) || '').trim();
let server = normalizeServer(
  (native && window.JustNative.getServer && window.JustNative.getServer()) ||
  localStorage.getItem(LS.server) ||
  (native ? '' : location.origin)
);
let clientId = localStorage.getItem(LS.client);
if (!clientId) {
  clientId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
  localStorage.setItem(LS.client, clientId);
}

let source = null;
let lastId = 0;
const seen = new Set();
let toastTimer = null;

const statusEl = $('status');
const statusText = $('statusText');
const messagesEl = $('messages');
const presenceEl = $('presence');
const input = $('input');
const sendBtn = $('send');
const modal = $('modal');
const nameInput = $('nameInput');
const serverInput = $('serverInput');
const modalError = $('modalError');

function normalizeServer(value) {
  let s = String(value || '').trim();
  if (s && !/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s.replace(/\/+$/, '');
}

function setStatus(kind, text) {
  statusEl.className = 'status ' + kind;
  statusText.textContent = text;
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

function nearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
}

function scrollDown() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function clearEmpty() {
  const empty = messagesEl.querySelector('.empty');
  if (empty) empty.remove();
}

function showEmpty() {
  messagesEl.textContent = '';
  const box = document.createElement('div');
  box.className = 'empty';
  const title = document.createElement('strong');
  title.textContent = 'Aucun message pour le moment';
  const sub = document.createElement('span');
  sub.textContent = 'Dis bonjour 👋';
  box.append(title, sub);
  messagesEl.append(box);
}

function addMessage(message) {
  if (!message || seen.has(message.id)) return;
  seen.add(message.id);
  lastId = Math.max(lastId, Number(message.id) || 0);
  clearEmpty();

  const stick = nearBottom();
  const row = document.createElement('div');
  row.className = 'msg' + (message.clientId === clientId ? ' mine' : '');

  const meta = document.createElement('div');
  meta.className = 'meta';
  const who = document.createElement('strong');
  who.textContent = message.name || 'Anonyme';
  const time = document.createElement('time');
  const date = new Date(message.ts || Date.now());
  time.dateTime = date.toISOString();
  time.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.append(who, time);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = message.text || '';

  row.append(meta, bubble);
  messagesEl.append(row);
  if (stick) scrollDown();
}

function renderPresence(users) {
  const list = Array.isArray(users) ? users : [];
  if (!list.length) {
    presenceEl.textContent = 'Personne en ligne pour le moment';
    return;
  }
  presenceEl.textContent = '';
  const count = document.createElement('b');
  count.textContent = `${list.length} en ligne`;
  presenceEl.append(count, document.createTextNode(' · ' + list.map((u) => u.name).join(', ')));
}

async function fillGap() {
  if (!lastId) return;
  try {
    const res = await fetch(server + '/api/messages?after=' + lastId);
    if (!res.ok) return;
    const data = await res.json();
    (data.messages || []).forEach(addMessage);
  } catch { /* silencieux */ }
}

function connect() {
  if (source) {
    source.close();
    source = null;
  }
  $('myName').textContent = name;
  setStatus('connecting', 'Connexion…');

  try {
    const query = `name=${encodeURIComponent(name)}&clientId=${encodeURIComponent(clientId)}`;
    source = new EventSource(server + '/stream?' + query);

    source.onopen = () => {
      setStatus('online', 'En ligne');
      fillGap();
    };
    source.onerror = () => {
      // EventSource réessaie tout seul ; sur un hébergeur gratuit le serveur
      // peut mettre ~1 min à se réveiller après une période d'inactivité.
      setStatus('connecting', 'Reconnexion… (serveur en veille ?)');
    };
    source.addEventListener('snapshot', (event) => {
      const data = JSON.parse(event.data);
      (data.messages || []).forEach(addMessage);
      if (!messagesEl.children.length) showEmpty();
      renderPresence(data.users);
      scrollDown();
    });
    source.addEventListener('message', (event) => {
      addMessage(JSON.parse(event.data));
    });
    source.addEventListener('presence', (event) => {
      renderPresence(JSON.parse(event.data).users);
    });
  } catch {
    setStatus('offline', 'Adresse du serveur invalide');
  }
}

function openModal(title) {
  $('modalTitle').textContent = title;
  nameInput.value = name;
  serverInput.value = server;
  modalError.textContent = '';
  modal.hidden = false;
  setTimeout(() => nameInput.focus(), 50);
}

function saveSettings() {
  const newName = nameInput.value.replace(/\s+/g, ' ').trim().slice(0, 24);
  const newServer = normalizeServer(serverInput.value);
  if (!newName) {
    modalError.textContent = 'Choisis un nom pour continuer.';
    return;
  }
  if (!newServer) {
    modalError.textContent = 'Indique l’adresse du serveur (ex. http://192.168.1.10:8787).';
    return;
  }
  try {
    const url = new URL(newServer);
    if (!/^https?:$/.test(url.protocol)) throw new Error('protocole');
  } catch {
    modalError.textContent = 'Adresse invalide. Elle doit commencer par http://';
    return;
  }

  name = newName;
  server = newServer;
  localStorage.setItem(LS.name, name);
  localStorage.setItem(LS.server, server);
  if (native && window.JustNative.setServer) window.JustNative.setServer(server);
  modal.hidden = true;
  connect();
}

$('saveBtn').addEventListener('click', saveSettings);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSettings(); });
serverInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSettings(); });
$('nameBtn').addEventListener('click', () => openModal('Changer de nom'));
$('settingsBtn').addEventListener('click', () => openModal('Réglages'));

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

input.addEventListener('input', () => {
  resizeInput();
  sendBtn.disabled = !input.value.trim();
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  resizeInput();
  sendBtn.disabled = true;

  try {
    const res = await fetch(server + '/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, text, clientId })
    });
    if (!res.ok) throw new Error('envoi refusé');
    const data = await res.json();
    addMessage(data.message); // l'événement SSE peut arriver en même temps : Set évite le doublon
  } catch {
    input.value = text;
    resizeInput();
    sendBtn.disabled = false;
    toast('Message non envoyé — vérifie la connexion');
  }
});

// Sur le plan gratuit de Render, le service s'endort après 15 min sans
// requête. Tant que l'application est ouverte, on garde le serveur éveillé.
setInterval(() => {
  if (server && source && source.readyState === EventSource.OPEN) {
    fetch(server + '/health').catch(() => {});
  }
}, 4 * 60 * 1000);

if (!name || !server) {
  openModal('Bienvenue sur Just Chat');
  setStatus('offline', 'À configurer');
} else {
  connect();
}
