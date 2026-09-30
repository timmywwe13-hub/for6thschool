// Builds `web/`: the folder you drag onto a static host (Netlify Drop, Cloudflare
// Pages, a web server, GitHub Pages ...) and the folder to zip for Deno Deploy.
//
//   node tools/web-build.js
//
// Why it is not just "copy the whole project":
//
//   * The `.glb.js` sidecars are ~41 MB of base64 and exist for ONE reason - a
//     `file://` page cannot fetch() its siblings, so the game falls back to a
//     <script> sidecar. Served over http(s) the game fetches the raw `.glb` and
//     never asks for the sidecar, so a deploy does not need them. Dropping them
//     halves the upload and, more importantly, keeps every file under 10 MB -
//     Netlify Drop stalls on bigger files and likes the whole folder under 50 MB.
//   * Everything else in the project (scenarios/, tools/, playtest/, the probe
//     logs, the .fbx sources, lobby-server.js) is development material.
//
// The asset list is READ OUT OF index.html rather than hard-coded: whatever the
// game actually asks for is what gets copied, so a new skin cannot be forgotten.
//
// It also fills in the one line the deploy needs - CONFIG.DEFAULT_RELAY - so the
// folder you drag onto a host is online for everybody who opens the link without
// anybody pasting a relay address (see DEPLOY-ONLINE.md 3). That substitution
// happens HERE, at build time, because `index.html` itself has to stay neutral:
// the scenario harness loads that file, and several of its checks are about the
// no-transport path - a relay baked into the source would have them dial the
// internet instead of the lobby they start themselves.
//
//   node tools/web-build.js                                     the address below
//   ISLE_RELAY=wss://other-host/isle node tools/web-build.js     a different one
//   ISLE_RELAY= node tools/web-build.js                          none (leave it empty)
//
// The lobby can also be a Supabase project, which needs nobody to keep anything
// running, and the same build bakes that in instead:
//
//   ISLE_SUPABASE_URL=https://abcdefghijkl.supabase.co \
//   ISLE_SUPABASE_KEY=sb_publishable_... node tools/web-build.js
//
// With both set, the deploy prefers Supabase and the relay address is only the
// fallback it walks to if the project stops answering (see CONFIG in index.html
// and DEPLOY-ONLINE.md 2b).
//
// PowerShell:  $env:ISLE_RELAY='wss://other-host/isle'; node tools/web-build.js
const RELAY = process.env.ISLE_RELAY !== undefined
  ? process.env.ISLE_RELAY.trim()
  : 'wss://glad-mustang-5022.timmywwe13-hub.deno.net/isle';
/* A project needs both halves, and half of one is worth saying out loud rather
   than deploying a game that dials nothing. */
const SUPA_URL = String(process.env.ISLE_SUPABASE_URL || '').trim();
const SUPA_KEY = String(process.env.ISLE_SUPABASE_KEY || '').trim();
const SUPA_HALF = (SUPA_URL ? 1 : 0) + (SUPA_KEY ? 1 : 0);
const SUPA = SUPA_HALF === 2 ? { url: SUPA_URL, key: SUPA_KEY } : null;
if (SUPA_HALF === 1) {
  console.log('\n  WARNING: a Supabase project needs BOTH ISLE_SUPABASE_URL and');
  console.log('           ISLE_SUPABASE_KEY - only one was set, so neither is baked in.');
}
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'web');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* index.html plus every asset it names: file:'...' in the config blocks, and
   every <script src="..."> that is not a CDN. Only plausible file names count -
   the same word appears in comments and in prose ("file: 'the .glb'") and a
   stray match would be reported as a missing asset. */
const ASSET = /\bfile:\s*'([^'\n]+)'/g;
const PLAUSIBLE = /^[A-Za-z0-9_][\w./()@+-]*$/;
function wantedFrom(rel) {
  if (/^(https?:)?\/\//i.test(rel) || rel.startsWith('data:')) return false;
  if (!PLAUSIBLE.test(rel)) return false;
  return /\.(glb|gltf|bin|png|jpe?g|webp|gif|json|js)$/i.test(rel) || rel.indexOf('/') > 0;
}
const wanted = new Set(['index.html']);
for (const m of html.matchAll(ASSET)) {
  if (wantedFrom(m[1])) wanted.add(m[1]);
}
for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/gi)) {
  if (wantedFrom(m[1])) wanted.add(m[1]);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const copied = [];
const missing = [];
let biggest = { name: '', size: 0 };
let total = 0;
for (const rel of Array.from(wanted).sort()) {
  const from = path.join(ROOT, rel.split('/').join(path.sep));
  if (!fs.existsSync(from) || !fs.statSync(from).isFile()) { missing.push(rel); continue; }
  const to = path.join(OUT, rel.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  const size = fs.statSync(to).size;
  total += size;
  if (size > biggest.size) biggest = { name: rel, size };
  copied.push({ rel, size });
}

const mb = n => (n / (1024 * 1024)).toFixed(1) + ' MB';

/* ---------- the two lines the deploy adds ----------
   `^  DEFAULT_RELAY: '...',$` matches the assignment in CONFIG and nothing else:
   the example inside the comment above it is indented further, and the same word
   appears in prose all over the file. The Supabase pair is matched the same way,
   one line at a time, and each is read back afterwards: what a drag-and-drop
   deploy carries is worth checking. */
let baked = '';
let bakedSupa = false;
function bake(pagePath, lineRe, replacement, what, emptyRe) {
  const page = fs.readFileSync(pagePath, 'utf8');
  if (!lineRe.test(page)) {
    console.log('\n  WARNING: no ' + what + ' line to fill in - the deploy will not carry it.');
    return false;
  }
  fs.writeFileSync(pagePath, page.replace(lineRe, replacement));
  const readBack = fs.readFileSync(pagePath, 'utf8');
  if (readBack.indexOf(replacement.trim()) < 0) {
    throw new Error(what + ' did not make it into ' + pagePath);
  }
  if (emptyRe && emptyRe.test(readBack)) {
    throw new Error('an empty ' + what + ' is still in ' + pagePath);
  }
  return true;
}
if (RELAY || SUPA) {
  const pagePath = path.join(OUT, 'index.html');
  if (RELAY) {
    if (bake(pagePath, /^  DEFAULT_RELAY: '[^']*',$/m, "  DEFAULT_RELAY: '" + RELAY + "',",
      'CONFIG.DEFAULT_RELAY', /^  DEFAULT_RELAY: ''$/m)) {
      baked = RELAY;
    }
  }
  if (SUPA) {
    const okUrl = bake(pagePath, /^  SUPABASE_URL: '[^']*',$/m,
      "  SUPABASE_URL: '" + SUPA.url + "',", 'CONFIG.SUPABASE_URL', /^  SUPABASE_URL: ''$/m);
    const okKey = bake(pagePath, /^  SUPABASE_KEY: '[^']*',$/m,
      "  SUPABASE_KEY: '" + SUPA.key + "',", 'CONFIG.SUPABASE_KEY', /^  SUPABASE_KEY: ''$/m);
    bakedSupa = okUrl && okKey;
  }
}

console.log('web build -> ' + OUT);
for (const f of copied) console.log('  ' + mb(f.size).padStart(8) + '  ' + f.rel);
if (missing.length) {
  console.log('\n  NOT FOUND (the game would fall back or go without):');
  for (const m of missing) console.log('    ' + m);
}
console.log('\n  ' + copied.length + ' files, ' + mb(total) +
  ', biggest ' + biggest.name + ' at ' + mb(biggest.size));
if (bakedSupa) {
  console.log('  CONFIG.SUPABASE_URL in web/index.html: ' + SUPA.url);
  console.log('  CONFIG.SUPABASE_KEY in web/index.html: ' + SUPA.key.slice(0, 12) + '… (' +
    SUPA.key.length + ' chars - the publishable key is meant to be in here)');
  console.log('  the deploy joins the Supabase channel for its room code, with nothing to run');
  console.log('  the one line for the game\'s FRIENDS panel too:  supabase:' + SUPA.url + '|' +
    SUPA.key);
}
console.log('  CONFIG.DEFAULT_RELAY in web/index.html: ' + (baked
  ? baked + (bakedSupa
    ? '  (fallback - dialled when the Supabase project above stops answering)'
    : '  (dialled on boot - nothing to paste, for anybody)')
  : '(none)'));
if (!bakedSupa && !baked) {
  console.log('  NO LOBBY IN THIS DEPLOY: it dials nothing until somebody pastes an address');
  console.log('  into FRIENDS. Set ISLE_SUPABASE_URL + ISLE_SUPABASE_KEY (or ISLE_RELAY) and');
  console.log('  build again - see DEPLOY-ONLINE.md 2b.');
}
if (biggest.size > 10 * 1024 * 1024) {
  console.log('  WARNING: a file over 10 MB - drag-and-drop hosts may stall on it');
}
if (total > 50 * 1024 * 1024) {
  console.log('  WARNING: over 50 MB - drag-and-drop hosts prefer less');
}
console.log('\n  Drag-and-drop deploy:  https://app.netlify.com/drop  <- drag this web folder in');
console.log('  No git needed, no account needed: it answers with a https://<name>.netlify.app link.');
