#!/usr/bin/env node
const CDP = require('chrome-remote-interface');
const blessed = require('blessed');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const { delimiter, join } = require('node:path');
const { WebSocketServer } = require('ws');

const BROWSERS = [
  {
    name: 'Microsoft Edge',
    paths: {
      win32: { exe: 'msedge.exe', dir: 'Microsoft\\Edge\\Application' },
      darwin: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      linux: 'microsoft-edge'
    }
  },
  {
    name: 'Google Chrome',
    paths: {
      win32: { exe: 'chrome.exe', dir: 'Google\\Chrome\\Application' },
      darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      linux: 'google-chrome'
    }
  },
  {
    name: 'Chromium',
    paths: {
      win32: { exe: 'chromium.exe', dir: 'Chromium\\Application' },
      darwin: '/Applications/Chromium.app/Contents/MacOS/Chromium',
      linux: 'chromium-browser'
    }
  },
  {
    name: 'Brave',
    paths: {
      win32: { exe: 'brave.exe', dir: 'BraveSoftware\\Brave-Browser\\Application' },
      darwin: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      linux: 'brave-browser'
    }
  }
];

async function findAllBrowsers() {
  const found = [];
  const pathDirs = (process.env.PATH || '').split(delimiter);

  const getCandidatePaths = (pathInfo) => {
    if (process.platform === 'win32') {
      const { exe, dir } = pathInfo;
      const programFiles = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.PROGRAMW6432].filter(Boolean);

      return [...programFiles.map((base) => join(base, dir, exe)), ...pathDirs.map((pathDir) => join(pathDir, exe))];
    } else if (process.platform === 'darwin') {
      return [pathInfo]; // Just the absolute path
    } else {
      return pathDirs.map((dir) => join(dir, pathInfo)); // Linux
    }
  };

  for (const browser of BROWSERS) {
    const pathInfo = browser.paths[process.platform];
    if (!pathInfo) continue;

    const candidates = getCandidatePaths(pathInfo);

    // Try each candidate path until we find one that exists
    for (const candidatePath of candidates) {
      try {
        await fs.access(candidatePath, fs.constants.X_OK);
        found.push({ path: candidatePath, name: browser.name });
        break; // Found this browser, move to next
      } catch {
        // Try next candidate
      }
    }
  }

  return found;
}

async function selectBrowser(browsers) {
  return new Promise((resolve) => {
    const list = blessed.list({
      parent: screen,
      label: ' Select Browser ',
      border: 'line',
      top: 'center',
      left: 'center',
      width: '60%',
      height: Math.min(browsers.length + 4, 15),
      items: browsers.map((b) => `${b.name} - ${b.path}`),
      keys: true,
      vi: true,
      mouse: true,
      style: {
        selected: {
          bg: 'blue',
          bold: true
        },
        border: {
          fg: 'cyan'
        }
      }
    });

    list.on('select', (item, index) => {
      list.destroy();
      screen.render();
      resolve(browsers[index].path);
    });

    list.key(['escape', 'q'], () => {
      list.destroy();
      screen.render();
      resolve(null);
    });

    list.focus();
    screen.render();
  });
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

  const yt = targets.find((t) => /^https:\/\/music\.youtube\.com\/(?!sw\.js$)/.test(t.url));
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
  const browsers = await findAllBrowsers();

  if (browsers.length === 0) {
    log('No Chromium-based browser found', 'error');
    state.browserPath = null;
  } else if (browsers.length === 1) {
    state.browserPath = browsers[0].path;
    log(`Using browser: ${browsers[0].name} (${browsers[0].path})`, 'ok');
  } else {
    log(`Found ${browsers.length} browsers, please select one...`, 'info');
    screen.render();

    const selected = await selectBrowser(browsers);
    if (selected) {
      state.browserPath = selected;
      log(`Selected browser: ${selected}`, 'ok');
    } else {
      log('No browser selected', 'warn');
      state.browserPath = null;
    }
  }

  drawStatus();
  drawPlaying();
  setInterval(connect, 2000);
  screen.render();
})();
