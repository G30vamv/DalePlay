const endpoint = 'ws://127.0.0.1:3190/room';
const sessions = new Map();

function mediaIdentity(rawUrl) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Abre una página con un reproductor web.');
  const videoId = url.hostname === 'www.youtube.com' && url.searchParams.get('v');
  return url.origin + url.pathname + (videoId ? '?v=' + encodeURIComponent(videoId) : '');
}

function stop(tabId) {
  const session = sessions.get(tabId);
  if (!session) return;
  sessions.delete(tabId);
  clearTimeout(session.retry);
  clearInterval(session.heartbeat);
  session.socket?.close();
  chrome.tabs.sendMessage(tabId, { type: 'set_role', role: null }).catch(() => {});
}

function send(session, data) {
  if (session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify(data));
}

function connect(session) {
  const { tabId } = session;
  const socket = new WebSocket(endpoint);
  session.socket = socket;

  socket.onopen = async () => {
    const playback = session.role === 'host'
      ? (await chrome.tabs.sendMessage(tabId, { type: 'read_player' }).catch(() => null))?.playback
      : undefined;
    if (sessions.get(tabId) !== session || session.socket !== socket) return;
    if (session.role === 'host' && !playback) {
      session.error = 'El reproductor se cerró. Sal de la sala y vuelve a crearla.';
      socket.close();
      return;
    }
    const type = session.role === 'guest' ? 'join' : session.key ? 'resume' : 'create';
    send(session, { type, code: session.code, media: session.media, key: session.key, playback });
    session.heartbeat = setInterval(() => send(session, { type: 'ping' }), 15000);
  };

  socket.onmessage = async ({ data }) => {
    if (sessions.get(tabId) !== session || session.socket !== socket) return;
    const message = JSON.parse(data);
    if (message.type === 'error') {
      if (message.message === 'El anfitrión sigue conectado.' && session.key) {
        socket.close();
        return;
      }
      session.error = message.message;
      socket.close();
    }
    if (message.type === 'joined') {
      session.code = message.code;
      session.key = message.key;
      session.connected = true;
      session.attempts = 0;
    }
    if (message.type === 'state') {
      session.participants = message.participants;
      session.hostOnline = message.host_online;
      if (session.role === 'guest') {
        const result = await chrome.tabs.sendMessage(tabId, {
          type: 'apply_playback', playback: message.playback
        }).catch(() => null);
        session.blocked = Boolean(result?.blocked);
        session.playerMissing = !result;
      }
    }
  };

  socket.onclose = () => {
    if (sessions.get(tabId) !== session || session.socket !== socket) return;
    clearInterval(session.heartbeat);
    session.connected = false;
    if (session.error) return;
    if (!session.code || ++session.attempts > 20) {
      session.error = 'No se pudo conectar con el servidor de DalePlay.';
      return;
    }
    session.retry = setTimeout(() => connect(session), 1000);
  };
}

async function start(tabId, role, code) {
  if (sessions.has(tabId)) throw new Error('Ya hay una sala abierta en esta pestaña.');
  const tab = await chrome.tabs.get(tabId);
  const media = mediaIdentity(tab.url);
  await chrome.scripting.executeScript({ target: { tabId }, files: ['player.js'] });
  const selected = await chrome.tabs.sendMessage(tabId, { type: 'select_player' });
  if (selected.error) throw new Error(selected.error);
  await chrome.tabs.sendMessage(tabId, { type: 'set_role', role });
  const session = { tabId, media, role, code, attempts: 0, participants: 0 };
  sessions.set(tabId, session);
  connect(session);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === 'playback' && sender.tab) {
    const session = sessions.get(sender.tab.id);
    if (session?.role === 'host' && session.connected) {
      send(session, { type: 'playback', playback: message.playback });
    }
    return;
  }
  if (sender.url !== chrome.runtime.getURL('popup.html')) return;
  const tabId = message.tabId;
  const session = sessions.get(tabId);
  if (message.type === 'status') {
    if (!session) respond(null);
    else {
      const { role, code, participants, connected, hostOnline, blocked, playerMissing, error } = session;
      respond({ role, code, participants, connected, hostOnline, blocked, playerMissing, error });
    }
  }
  if (message.type === 'leave') {
    stop(tabId);
    respond({});
  }
  if (message.type === 'create' || message.type === 'join') {
    start(tabId, message.type === 'create' ? 'host' : 'guest', message.code)
      .then(() => respond({})).catch(error => respond({ error: error.message }));
    return true;
  }
});

chrome.tabs.onRemoved.addListener(stop);
chrome.tabs.onUpdated.addListener((tabId, change) => {
  const session = sessions.get(tabId);
  if (!session) return;
  if (change.status === 'loading' && !change.url) stop(tabId);
  if (!change.url) return;
  try {
    if (mediaIdentity(change.url) !== session.media) stop(tabId);
  } catch {
    stop(tabId);
  }
});
