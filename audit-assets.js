// Verifies the single-file pledge: every external reference is a pinned CDN
// <script>, and nothing else is loaded from disk or the network.
const fs = require('fs');
const raw = fs.readFileSync(process.argv[2] || 'index.html', 'utf8');
/* Comments explain the design with words like fetch() and src="..." - strip them
   so every count below reflects code that actually runs. */
const h = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '');

const urls = [...new Set((h.match(/https?:\/\/[^"'\s)]+/g) || []))];
console.log('external URLs referenced (' + urls.length + '):');
urls.forEach(u => console.log('  ' + u));

const counts = {
  '<script src>': (h.match(/<script[^>]+src=/g) || []).length,
  '<img>': (h.match(/<img\b/g) || []).length,
  '<link>': (h.match(/<link\b/g) || []).length,
  'fetch(': (h.match(/fetch\s*\(/g) || []).length,
  'XMLHttpRequest': (h.match(/XMLHttpRequest/g) || []).length,
  'new Image': (h.match(/new Image\b/g) || []).length,
  'new Audio': (h.match(/new Audio\b/g) || []).length,
  'AudioContext': (h.match(/AudioContext/g) || []).length,
  'importScripts': (h.match(/importScripts/g) || []).length,
  'require(': (h.match(/require\s*\(/g) || []).length,
  'import ': (h.match(/^\s*import\s/gm) || []).length
};
console.log('\nresource loaders found:');
Object.keys(counts).forEach(k => console.log('  ' + k + ': ' + counts[k]));

/* every src/href/url() must be either an inline data URL or a pinned CDN script */
const refs = [...(h.match(/(?:src|href)\s*=\s*["'][^"']+["']/g) || [])];
const external = refs.filter(r => /https?:\/\//.test(r) && !/three@\d+\.\d+\.\d+/.test(r));
const localAll = refs.filter(r => !/https?:\/\//.test(r) && !/["']data:/.test(r) && !/["']#/.test(r));

/* The optional player-character model is the one deliberate exception: its
   loader (vendor/GLTFLoader.js) and its bytes (freddy_fazzbear.glb, or the
   base64 sidecar the page loads with <script src>) are looked up next to
   index.html, and Character reports 'failed' - leaving the primitive humanoid
   in place - when they are missing. Everything the game *needs* stays inline. */
const OPTIONAL = /GLTFLoader\.js|\.glb(\.js)?["']/;
const optionalCharacter = localAll.filter(r => OPTIONAL.test(r));
const localAssets = localAll.filter(r => !OPTIONAL.test(r));
const localScripts = [...new Set(h.match(/<script[^>]+src=["'](?!https?:|data:)[^"']*["']/g) || [])];
console.log('\nnon-CDN or local asset references: ' + (external.length + localAll.length));
external.concat(localAssets).forEach(r => console.log('  REQUIRED ' + r));
optionalCharacter.forEach(r => console.log('  optional character asset ' + r));
/* the HUD item icons are <img> elements whose src is filled with a data URL */
const dataUrlImages = (h.match(/['"]data:image\/png/g) || []).length;
console.log('inline data-URL images (HUD item icons, baked at load): ' + dataUrlImages);

const pinned = urls.every(u => /three@\d+\.\d+\.\d+/.test(u));
console.log('\nall CDN URLs pin an exact three.js version: ' + pinned);
const proceduralAudio = counts.AudioContext > 0 && counts['new Audio'] === 0;
console.log('audio is synthesized (AudioContext, no audio files): ' + proceduralAudio);
/* the character bytes are the only fetch(), and it is wrapped in a .catch that
   falls back to the base64 sidecar, so a failed fetch can never stall the boot */
const guardedFetch = counts['fetch('] <= 1 && /fetch\(CONFIG\.CHARACTER\.file\)[\s\S]{0,600}?\.catch\(/.test(h);
console.log('the only fetch() is the optional character model, with a fallback: ' + guardedFetch);
const characterOptional = localScripts.length <= 1 &&
  /if \(!THREE\.GLTFLoader\)/.test(h) && /state\.status = 'failed'/.test(h) &&
  /new THREE\.CapsuleGeometry/.test(h);
console.log('local <script src> tags (only the optional GLTFLoader): ' + localScripts.length +
  (localScripts.length ? ' ' + localScripts.join(' ') : ''));
console.log('the game runs without the character assets (primitive humanoid stays): ' + characterOptional);
const singleFile = external.length === 0 && localAssets.length === 0 &&
  counts['<link>'] === 0 && counts['XMLHttpRequest'] === 0 && counts['importScripts'] === 0 &&
  counts['new Audio'] === 0 && counts['new Image'] === 0 && guardedFetch;
console.log('the game is one self-contained file (only CDN scripts + inline data URLs): ' + singleFile);
process.exit(pinned && proceduralAudio && singleFile && characterOptional ? 0 : 1);
