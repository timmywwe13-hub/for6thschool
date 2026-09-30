// Headless-browser validation harness.
// Boots Edge/Chrome via the DevTools protocol, loads index.html from file://,
// collects console errors / uncaught exceptions, then runs a named scenario.
//
// Usage: node cdp-test.js <scenario-in-scenarios-folder>
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* Overridable so several scenarios can be exercised at the same time: each run
   gets its own browser. Leave it unset and the browser picks its own port, which
   is what the suite runner does - a fixed port handed to a fresh browser the
   moment the previous one is killed is a race: the dying browser still holds the
   socket, the new one quietly binds another port, and the harness polls a port
   nobody is listening on until it gives up ("browser did not expose a page
   target"). With 0 the port is read back from DevToolsActivePort instead. */
const PORT = process.env.CDP_PORT === undefined ? 0 : Number(process.env.CDP_PORT);
/* Where a browser could be, in the order we would rather have it: an override
   first (CI sets BROWSER_PATH), then the platform's usual installs. The game is
   developed on Windows and the same harness has to run on a Linux runner, so
   nothing here may assume a drive letter. */
function browserCandidates() {
  const out = [];
  if (process.env.BROWSER_PATH) out.push(process.env.BROWSER_PATH);
  if (process.env.CHROME_PATH) out.push(process.env.CHROME_PATH);
  if (process.platform === 'win32') {
    const dirs = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'],
                  process.env.LOCALAPPDATA].filter(Boolean);
    for (const d of dirs) {
      out.push(path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      out.push(path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    out.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    out.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    out.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable');
    out.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
  }
  return out;
}
const BROWSERS = browserCandidates();

const scenario = process.argv[2] || 'boot';
const htmlPath = path.resolve(__dirname, 'index.html');
const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function findBrowser() {
  for (const b of BROWSERS) if (b && fs.existsSync(b)) return b;
  throw new Error('no Chrome/Edge/Chromium found - set BROWSER_PATH to one');
}

async function launch() {
  const exe = findBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'br-cdp-'));
  const args = [
    '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader', '--no-sandbox',
    '--disable-extensions', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,800', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, 'about:blank'
  ];
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d.toString(); });
  /* With PORT 0 the debug port is whatever the browser chose: it writes it to
     <profile>/DevToolsActivePort the moment it is listening. */
  const portFile = path.join(profile, 'DevToolsActivePort');
  let port = PORT;
  let targets = null;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    if (!port) {
      try {
        const txt = fs.readFileSync(portFile, 'utf8').split('\n');
        if (txt[0]) port = Number(txt[0]);
      } catch (e) { /* not written yet */ }
    }
    if (!port) continue;
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/list');
      targets = (await r.json()).filter(t => t.type === 'page');
      if (targets.length) break;
    } catch (e) { /* not up yet */ }
  }
  if (!targets || !targets.length) {
    proc.kill();
    throw new Error('browser did not expose a page target\n' + stderr.slice(-800));
  }
  return { proc, profile, wsUrl: targets[0].webSocketDebuggerUrl };
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  let nextId = 1;
  const pending = new Map();
  const logs = [];
  const notes = [];
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(msg.error.message + ' (' + msg.error.code + ')'));
      else p.res(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      logs.push({ kind: msg.params.type,
        text: msg.params.args.map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ') });
    } else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'log' || msg.params.type === 'info')) {
      /* informational lines (the character loader reports through these) are
         shown but never counted as problems */
      notes.push({ kind: msg.params.type,
        text: msg.params.args.map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ') });
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      logs.push({ kind: 'exception', text: (d.exception && d.exception.description) || d.text });
    } else if (msg.method === 'Log.entryAdded' && (msg.params.entry.level === 'error' || msg.params.entry.level === 'warning')) {
      logs.push({ kind: 'log:' + msg.params.entry.level, text: msg.params.entry.text + ' ' + (msg.params.entry.url || '') });
    }
  };
  /* sessionId targets a page inside the same browser: the cross-device
     scenario drives two pages (two "machines") over one connection */
  const send = (method, params, sessionId) => new Promise((res, rej) => {
    const id = nextId++;
    const msg = { id, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify(msg));
  });
  return { ws, send, ready, logs, notes };
}

module.exports = { launch, connect, sleep, fileUrl, findBrowser };
