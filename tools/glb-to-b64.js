// glb-to-b64.js - fast Node twin of tools/glb-to-b64.ps1 (the PowerShell one
// crawls on multi-megabyte models). Packs a .glb into a classic script that
// hands the bytes to the page as base64, for the file:// fallback:
//   node tools/glb-to-b64.js fortnite_aura.glb AURA_GLB_B64 fortnite_aura.glb.js
const fs = require('fs');
const path = require('path');

const [, , glbArg, globalName, outArg] = process.argv;
if (!glbArg || !globalName) {
  console.error('usage: node tools/glb-to-b64.js model.glb GLOBAL_NAME [out.js]');
  process.exit(2);
}
const glb = path.resolve(glbArg);
const out = path.resolve(outArg || (glb + '.js'));
const bytes = fs.readFileSync(glb);
if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'glTF') {
  throw new Error(path.basename(glb) + ' is not a binary glTF container (bad magic)');
}
const declared = bytes.readUInt32LE(8);
if (declared !== bytes.length) {
  console.warn('GLB length mismatch: header says ' + declared + ', the file has ' + bytes.length);
}
console.log('packing ' + path.basename(glb) + ' (' + (bytes.length / 1048576).toFixed(2) + ' MB) ...');
const text =
  '/* ' + path.basename(glb) + ' as base64 - GENERATED, do not edit.\n' +
  '   Rebuild with:  node tools/glb-to-b64.js ' + path.basename(glb) + ' ' + globalName + '\n' +
  '   (or powershell -NoProfile -File tools/glb-to-b64.ps1)\n' +
  '   Only read by the game when the page is opened from file:// and the .glb\n' +
  '   itself cannot be fetched. Sets window.' + globalName + '.\n' +
  '   Model: ' + bytes.length + ' bytes. */\n' +
  'window.' + globalName + " = '" + bytes.toString('base64') + "';\n";
fs.writeFileSync(out, text, 'utf8');
console.log('wrote ' + out + ' (' + (fs.statSync(out).size / 1048576).toFixed(2) + ' MB)');
