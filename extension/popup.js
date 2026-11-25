const byId = id => document.getElementById(id);
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let current = null;
let busy = false;
let temporary = '';
let shown = '';

function show(text) {
  if (text === shown) return;
  shown = text;
  byId('status').textContent = text;
}

function message(type, code) {
  return chrome.runtime.sendMessage({ tabId: tab.id, type, code });
}

async function refresh() {
  current = await message('status');
  byId('home').hidden = Boolean(current);
  byId('room').hidden = !current;
  if (!current) {
    show(temporary || 'Conecta el reproductor de esta pestaña a una sala.');
    return;
  }
  byId('role').textContent = current.role === 'host' ? 'Anfitrión' : 'Invitado';
  byId('count').textContent = current.participants ? current.participants + ' en la sala' : '';
  byId('copy').hidden = !current.code || Boolean(current.error);
  if (current.error) show(current.error);
  else if (!current.connected) show(current.code ? 'Reconectando…' : 'Conectando…');
  else if (current.playerMissing) show('El reproductor cambió. Sal y vuelve a unirte desde el video.');
  else if (current.blocked) show('Pulsa reproducir en esta pestaña para permitir la sincronización.');
  else if (current.hostOnline === false) show('Esperando a que vuelva el anfitrión.');
  else show(temporary || 'Sala conectada.');
}

async function act(type, code) {
  if (busy) return;
  busy = true;
  temporary = '';
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  try {
    temporary = (await message(type, code))?.error || '';
    await refresh();
  } catch {
    show('No se pudo comunicar con DalePlay.');
  } finally {
    for (const button of document.querySelectorAll('button')) button.disabled = false;
    busy = false;
  }
}

byId('create').onclick = () => act('create');
byId('leave').onclick = () => act('leave');
byId('join').onsubmit = event => {
  event.preventDefault();
  const code = byId('code').value.trim();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(code)) {
    temporary = 'Pega el código completo de la invitación.';
    show(temporary);
    return;
  }
  act('join', code);
};
byId('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(current.code);
    temporary = 'Código copiado.';
  } catch {
    temporary = current.code;
  }
  show(temporary);
};

await refresh();
setInterval(() => { if (!busy) refresh().catch(() => {}); }, 600);
