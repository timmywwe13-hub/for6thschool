// img-to-b64.js - Node twin of tools/img-to-b64.ps1. Packs a PNG into a classic
// script that hands the bytes to the page as base64, for the file:// fallback:
//   node tools/img-to-b64.js isle_map.png ISLE_MAP_B64 isle_map.png.js
//
// Same reason as the .glb sidecars: a file:// page may not fetch() a sibling
// file, while <script src="..."> always loads. The game turns the base64 into a
// data: URL, which - unlike an <img src="isle_map.png"> read off the disk - does
// NOT taint the canvas the minimap reads back with getImageData().
const fs = require('fs');
const path = require('path');

const [, , imgArg, globalName, outArg] = process.argv;
if (!imgArg || !globalName) {
  console.error('usage: node tools/img-to-b64.js picture.png GLOBAL_NAME [out.js]');
  process.exit(2);
}
const img = path.resolve(imgArg);
const out = path.resolve(outArg || (img + '.js'));
const bytes = fs.readFileSync(img);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) {
  throw new Error(path.basename(img) + ' is not a PNG (bad magic)');
}
/* IHDR holds the size right after the 8-byte signature + 4-byte chunk length:
   worth printing, because ISLE_ART.w/h and the pixel trace are calibrated to it */
const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
console.log('packing ' + path.basename(img) + ' (' + w + 'x' + h + ', ' +
  (bytes.length / 1048576).toFixed(2) + ' MB) ...');
const text =
  '/* ' + path.basename(img) + ' as base64 - GENERATED, do not edit.\n' +
  '   Rebuild with:  node tools/img-to-b64.js ' + path.basename(img) + ' ' + globalName + '\n' +
  '   (or powershell -NoProfile -File tools/img-to-b64.ps1)\n' +
  '   Only read by the game when the page is opened from file:// and the picture\n' +
  '   itself cannot be loaded. Sets window.' + globalName + '.\n' +
  '   Picture: ' + w + 'x' + h + ', ' + bytes.length + ' bytes. */\n' +
  'window.' + globalName + " = '" + bytes.toString('base64') + "';\n";
fs.writeFileSync(out, text, 'utf8');
console.log('wrote ' + out + ' (' + (fs.statSync(out).size / 1048576).toFixed(2) + ' MB)');
