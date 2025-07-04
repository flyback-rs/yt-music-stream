#!/usr/bin/env node
const CDP = require('chrome-remote-interface');
const blessed = require('blessed');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const { delimiter, join } = require('node:path');
const { WebSocketServer } = require('ws');

const CANDIDATES = {
  win32: ['chrome.exe', 'msedge.exe', 'chromium.exe', 'brave.exe'],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ],
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge']
}[process.platform];

async function findBrowser() {
  const dirs = (process.env.PATH || '').split(delimiter);
  for (const exe of CANDIDATES) {
    if (exe.startsWith('/Applications')) {
      try {
        await fs.access(exe, fs.constants.X_OK);
        return exe;
      } catch {
        // not found
        continue;
      }
    }
    for (const dir of dirs) {
      const browserPath = join(dir, exe);
      try {
        await fs.access(browserPath, fs.constants.X_OK);
        return browserPath;
      } catch {
        // not found, that's fine
      }
    }
  }
  return null;
}

const screen = blessed.screen({ smartCSR: true, title: 'YT Music Stream Overlay' });
const status = blessed.box({
  top: 0,
  left: 0,
  width: '50%',
  height: 9,
  label: ' Setup Status ',
  border: 'line',
  tags: true
});
const playing = blessed.box({
  top: 0,
  left: '50%',
  width: '50%',
  height: 9,
  label: ' Now Playing ',
  border: 'line',
  tags: true
});
const logBox = blessed.log({
  top: 9,
  left: 0,
  width: '100%',
  bottom: 0,
  label: ' Log ',
  border: 'line',
  scrollable: true,
  tags: true
});
screen.append(status);
screen.append(playing);
screen.append(logBox);

// eslint-disable-next-line n/no-process-exit
screen.key(['q', 'Q', 'C-c'], () => process.exit(0));
screen.key(['c', 'C'], () => {
  logBox.setContent('');
  log('Log cleared');
});
screen.key(['b', 'B'], () => launch());
screen.key(['y', 'Y'], () => launch('https://music.youtube.com'));
screen.key(['?', '/'], () => log('[B]rowser  [Y]T Music  [C]lear  [Q]uit', 'info'));

function log(msg, type = 'info') {
  const color = { info: 'cyan', ok: 'green', warn: 'yellow', error: 'red' }[type] || 'white';
  const t = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  logBox.log(`{gray-fg}${t}{/} {${color}-fg}${msg}{/}`);
}

let client = null,
  pollTimer = null;

const state = {
  browserPath: null,
  browserUp: false, // DevTools port reachable?
  ytTab: false, // music.youtube.com tab open?
  track: null
};

const wss = new WebSocketServer({ port: 8787, host: '127.42.0.69' });
function broadcast(data) {
  const json = JSON.stringify(data);
  wss.clients.forEach((c) => c.readyState === c.OPEN && c.send(json));
}

const fmtTime = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const tick = (yes, txt) => `{${yes ? 'green' : 'red'}-fg}${yes ? '✓' : '✗'}{/} ${txt}`;

function drawStatus() {
  const { browserUp, ytTab, track } = state;
  const playing = !!track && !track.paused;
  const paused = !!track && track.paused;

  const lines = [
    '{bold}Browser Status{/}',
    tick(browserUp, 'Connected to CDP?'),
    browserUp ? '' : '{gray-fg}Press [B] to launch{/}',
    '',
    '{bold}YouTube Music{/}',
    tick(ytTab, 'Tab open?'),
    browserUp && !ytTab ? '{gray-fg}Press [Y] to open{/}' : '',
    '',
    '{bold}Playback{/}',
    tick(playing || paused, !track ? 'no track' : paused ? 'paused' : 'playing')
  ].join('\n');
  status.setContent(lines);
  status.style.border.fg = playing ? 'green' : browserUp ? 'yellow' : 'red';
}

function drawPlaying() {
  const track = state.track;
  if (!track) {
    playing.setContent('{gray-fg}No track{/}');
    playing.style.border.fg = 'gray';
    screen.render();
    return;
  }
  playing.setContent(
    `{bold}${track.title || '-'}{/}\n${track.artist || ''}${track.album ? ` · ${track.album}` : ''}\n`
      + `${fmtTime(track.pos)} / ${fmtTime(track.dur)}  ${track.paused ? '⏸' : '▶'}`
  );
  playing.style.border.fg = track.paused ? 'yellow' : 'green';
  screen.render();
}

function launch(url = '') {
  if (!state.browserPath) return log('No browser detected', 'error');
  const args = ['--remote-debugging-port=9222', url].filter(Boolean);

  process.platform === 'win32'
    ? spawn('cmd', ['/c', 'start', '', state.browserPath, ...args], { detached: true, stdio: 'ignore' })
    : spawn(state.browserPath, args, { detached: true, stdio: 'ignore' }).unref();

  log(`Launching ${state.browserPath}${url ? ' + YT Music' : ''}`, 'info');
}

function clearTab() {
  if (client) (client.close().catch(() => {}), (client = null));
  if (pollTimer) (clearInterval(pollTimer), (pollTimer = null));
  state.track = null;
  state.ytTab = false;
  drawStatus();
  drawPlaying();
}

async function connect() {
  /* check if CDP is reachable */
  let targets;
  try {
    targets = await CDP.List({ port: 9222 });
    state.browserUp = true;
  } catch {
    if (state.browserUp) log('Browser closed', 'warn');
    state.browserUp = false;
    clearTab();
    drawStatus();
    return;
  }

  const yt = targets.find((t) => /https:\/\/music\.youtube\.com\//.test(t.url));
  if (!yt) {
    if (state.ytTab) log('Music tab closed', 'warn');
    clearTab();
    return;
  }

  /* already connected to correct tab, nothing to do */
  if (client && client.targetId === yt.id) return;

  /* new/first tab – connect */
  clearTab();
  try {
    client = await CDP({ target: yt.id });
    client.targetId = yt.id;
    state.ytTab = true;
    log('Music tab detected', 'ok');
    startPolling();
  } catch (e) {
    log(`CDP connect failed: ${e.message}`, 'error');
  }
}

function startPolling() {
  pollTimer = setInterval(async () => {
    try {
      const {
        result: { value: track }
      } = await client.Runtime.evaluate({
        expression: `(()=>{
          const m = navigator.mediaSession;
          const v = document.querySelector('video');
          const timeInfo = document.querySelector('.time-info.style-scope.ytmusic-player-bar');
          if (!m || !m.metadata || !v || !timeInfo) return null;

          // Yes, this is a hack. Too bad!
          const [posStr, durStr] = timeInfo.textContent.split(' / ');
          const pos = posStr ? posStr.split(':').reduce((acc, val) => acc * 60 + parseFloat(val), 0) : 0;
          const dur = durStr ? durStr.split(':').reduce((acc, val) => acc * 60 + parseFloat(val), 0) : 0;

          // Choose the largest artwork entry to waste the maximum amount of bandwidth
          const artArr = m.metadata.artwork || [];
          const best   = artArr[artArr.length - 1]?.src;

          return {
            title : m.metadata.title  || '',
            artist: m.metadata.artist || '',
            album : m.metadata.album  || '',
            art   : best              || null,
            dur   : dur,
            pos   : pos,
            paused: v.paused
          }; })()`,
        returnByValue: true
      });

      const prev = state.track;
      if (track && (!prev || prev.title !== track.title)) log(`Now playing: ${track.title}`, 'info');
      if (prev && prev.paused !== track.paused) log(track.paused ? 'Paused' : 'Resumed', track.paused ? 'warn' : 'ok');
      if (!track && prev) log('Playback stopped', 'warn');

      state.track = track;
      drawStatus();
      drawPlaying();
      broadcast({
        title: track?.title,
        artist: track?.artist,
        album: track?.album,
        albumArt: track?.art,
        position: track?.pos,
        duration: track?.dur,
        paused: track?.paused
      });
    } catch {
      log('Lost tab connection', 'warn');
      clearTab();
    }
  }, 1000);
}

(async () => {
  log('YT Music Overlay starting…');
  state.browserPath = await findBrowser();
  state.browserPath ? log(`Discovered browser exe: ${state.browserPath}`, 'ok') : log('No Chromium-based browser in PATH', 'error');

  drawStatus();
  drawPlaying();
  setInterval(connect, 2000);
  screen.render();
})();
