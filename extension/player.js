(() => {
  if (globalThis.dalePlayPlayerInstalled) return;
  globalThis.dalePlayPlayerInstalled = true;

  let role = null;
  let player = null;

  function read() {
    return { position: player.currentTime, paused: player.paused || player.ended || player.seeking || player.readyState < HTMLMediaElement.HAVE_FUTURE_DATA };
  }

  function publish(event) {
    if (role === 'host' && event.target === player) {
      chrome.runtime.sendMessage({ type: 'playback', playback: read() }).catch(() => {});
    }
  }

  for (const event of ['play', 'pause', 'seeking', 'seeked', 'ended', 'playing', 'waiting']) {
    document.addEventListener(event, publish, true);
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === 'select_player') {
      const candidates = [...document.querySelectorAll('video, audio')]
        .filter(element => (element.currentSrc || element.srcObject) && !element.ended);
      player = candidates.find(element => !element.paused)
        ?? candidates.find(element => element.matches('video') && element.getBoundingClientRect().width > 0)
        ?? candidates[0];
      role = null;
      respond(player ? { playback: read() } : { error: 'No se encontró un reproductor en esta pestaña.' });
    }
    if (message.type === 'set_role') {
      role = message.role;
      respond(player && { playback: read() });
    }
    if (message.type === 'read_player') {
      respond(player?.isConnected ? { playback: read() } : null);
    }
    if (message.type === 'apply_playback' && role === 'guest' && player?.isConnected) {
      const { position, paused } = message.playback;
      const target = Math.min(position, Number.isFinite(player.duration) ? player.duration : position);
      try {
        if (Math.abs(player.currentTime - target) > (paused ? 0.12 : 0.55)) player.currentTime = target;
        if (paused) {
          player.pause();
          respond({});
        } else if (player.paused) {
          player.play().then(() => respond({})).catch(() => respond({ blocked: true }));
          return true;
        } else {
          respond({});
        }
      } catch {
        respond({ blocked: true });
      }
    }
  });
})();
