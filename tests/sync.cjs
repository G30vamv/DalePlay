const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { setTimeout: sleep } = require('node:timers/promises');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const extension = path.join(root, 'extension');
const url = 'http://127.0.0.1:3190/';
const contexts = [];
const pageErrors = [];

async function waitForServer(server) {
  const lines = createInterface({ input: server.stdout });
  try {
    const signal = AbortSignal.timeout(10000);
    await Promise.race([
      once(lines, 'line', { signal }).then(([line]) => {
        assert.ok(line.endsWith(url.slice(0, -1)), 'El servidor debe escuchar en la dirección de la demo.');
      }),
      once(server, 'exit', { signal }).then(([code]) => {
        throw new Error('El servidor terminó antes de iniciar. Código ' + code);
      }),
    ]);
  } finally {
    lines.close();
  }
}

async function openProfile(directory) {
  const context = await chromium.launchPersistentContext(directory, {
    channel: 'chromium',
    headless: true,
    args: ['--disable-gpu', '--mute-audio', '--disable-extensions-except=' + extension, '--load-extension=' + extension],
  });
  contexts.push(context);
  context.setDefaultTimeout(12000);

  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const demo = context.pages()[0] ?? await context.newPage();
  demo.on('pageerror', error => pageErrors.push(error.message));
  await demo.goto(url);
  await demo.waitForFunction(() => document.querySelector('audio').readyState >= 3);
  const [demoTab] = await worker.evaluate(url => chrome.tabs.query({ url }), url);
  assert.ok(demoTab?.id, 'La extensión debe poder encontrar la pestaña de la demo.');

  const popup = await context.newPage();
  popup.on('pageerror', error => pageErrors.push(error.message));
  // Playwright abre el panel como una página. Así lo asociamos a la pestaña de la demo.
  await popup.addInitScript(tabId => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (...args) => {
      if (args[0]?.active && args[0]?.currentWindow) {
        return chrome.tabs.get(tabId).then(tab => [tab]);
      }
      return query(...args);
    };
    const clipboard = { text: '', async writeText(text) { this.text = text; } };
    Object.defineProperty(navigator, 'clipboard', { value: clipboard });
  }, demoTab.id);
  await popup.goto(new URL('/popup.html', worker.url()).href);
  return { worker, demoTab, demo, popup };
}

async function waitText(popup, selector, expected) {
  await popup.waitForFunction(({ selector, expected }) => {
    const node = document.querySelector(selector);
    return node && !node.closest('[hidden]') && node.textContent.includes(expected);
  }, { selector, expected }, { polling: 50 });
}

function command(demo, state) {
  return demo.evaluate(async ({ position, paused }) => {
    const player = document.querySelector('audio');
    if (position !== undefined) player.currentTime = position;
    if (paused === true) player.pause();
    if (paused === false) await player.play();
  }, state);
}

function waitPlayback(demo, state) {
  return demo.waitForFunction(({ paused, position, tolerance = 0.3 }) => {
    const player = document.querySelector('audio');
    return player.paused === paused && !player.seeking &&
      (position === undefined || Math.abs(player.currentTime - position) < tolerance);
  }, state, { polling: 50 });
}

function position(demo) {
  return demo.evaluate(() => document.querySelector('audio').currentTime);
}

async function checkSync(directory) {
  const host = await openProfile(path.join(directory, 'host'));
  const guest = await openProfile(path.join(directory, 'guest'));

  await host.popup.getByRole('button', { name: 'Crear sala' }).click();
  await waitText(host.popup, '#status', 'Sala conectada');
  await host.popup.getByRole('button', { name: 'Copiar código' }).click();
  const code = await host.popup.evaluate(() => navigator.clipboard.text);
  assert.match(code, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  await guest.popup.getByLabel('Código de invitación').fill(code);
  await guest.popup.getByRole('button', { name: 'Unirme' }).click();
  await waitText(guest.popup, '#count', '2 en la sala');
  await waitText(host.popup, '#count', '2 en la sala');
  console.log('PASS — creación, copia de la invitación e ingreso.');

  await command(host.demo, { paused: false });
  const initial = await Promise.race([
    waitPlayback(guest.demo, { paused: false }).then(() => 'automatic'),
    waitText(guest.popup, '#status', 'Pulsa reproducir').then(() => 'blocked'),
  ]);
  if (initial === 'blocked') {
    console.log('Chromium pidió un inicio manual para el invitado.');
    await command(guest.demo, { paused: false });
    await waitPlayback(guest.demo, { paused: false });
  }

  await command(host.demo, { paused: true });
  await waitPlayback(guest.demo, { paused: true });
  await command(host.demo, { position: 37 });
  await waitPlayback(guest.demo, { position: 37, paused: true });
  console.log('PASS — reproducción, pausa y salto en pausa.');

  await command(host.demo, { paused: false });
  await waitPlayback(guest.demo, { paused: false });
  await command(host.demo, { position: 60 });
  await waitPlayback(guest.demo, { position: 60, paused: false, tolerance: 1.5 });
  await sleep(500);
  const [hostPosition, guestPosition] = await Promise.all([position(host.demo), position(guest.demo)]);
  const difference = Math.abs(hostPosition - guestPosition);
  assert.ok(difference < 0.75, 'Desfase tras el salto en reproducción: ' + difference);
  console.log('PASS — salto en reproducción, desfase de ' + Math.round(difference * 1000) + ' ms.');

  await host.worker.evaluate(tabId => sessions.get(tabId).socket.close(), host.demoTab.id);
  await waitPlayback(guest.demo, { paused: true });
  await waitPlayback(guest.demo, { paused: false });
  await waitText(host.popup, '#count', '2 en la sala');
  assert.deepEqual(pageErrors, []);
  console.log('PASS — reconexión automática del anfitrión.');
}

async function main() {
  const executable = process.platform === 'win32' ? 'daleplay.exe' : 'daleplay';
  const directory = await mkdtemp(path.join(root, 'target', 'sync-'));
  const server = spawn(path.join(root, 'target', 'debug', executable), {
    env: { ...process.env, DALEPLAY_BIND: '127.0.0.1:3190' },
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  try {
    await waitForServer(server);
    await checkSync(directory);
  } finally {
    await Promise.all(contexts.map(context => context.close().catch(console.error)));
    if (server.pid && server.exitCode === null && server.signalCode === null) {
      const done = once(server, 'exit');
      server.kill();
      await done;
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
