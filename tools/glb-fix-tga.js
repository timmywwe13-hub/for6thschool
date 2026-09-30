// =====================================================================
// Rewrites the embedded textures of a .glb that are not browser-decodable.
//
//   node tools/glb-fix-tga.js <model.glb>
//
// Why: FBX2glTF copies an FBX's embedded media through untouched, and old
// rips carry .tga textures - mimeType "image/unknown", a payload no browser
// will decode ("THREE.GLTFLoader: Couldn't load texture blob:..."). This
// decodes the uncompressed/RLE truecolor TGAs, re-encodes them as PNG
// (zlib only, no npm packages) and rebuilds the binary buffer with the new
// payloads, fixing every bufferView offset that shifted.
// =====================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPG_MAGIC = [0xff, 0xd8, 0xff];

/* ---------- CRC32 (PNG chunks) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

/* RGBA pixels -> a minimal PNG (filter 0 per scanline) */
function pngEncode(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  ihdr[9] = 6;  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/* uncompressed (type 2) and RLE (type 10) truecolor TGA -> { width, height, rgba } */
function tgaDecode(buf) {
  if (buf.length < 18) throw new Error('TGA: too short');
  const idLen = buf[0], type = buf[2];
  const width = buf.readUInt16LE(12), height = buf.readUInt16LE(14);
  const depth = buf[16], desc = buf[17];
  if (type !== 2 && type !== 10) throw new Error('TGA: unsupported type ' + type);
  if (depth !== 24 && depth !== 32) throw new Error('TGA: unsupported depth ' + depth);
  const bpp = depth / 8;
  const px = Buffer.alloc(width * height * 4);
  let src = 18 + idLen, dst = 0;
  const put = () => {
    const b = buf[src], g = buf[src + 1], r = buf[src + 2], a = bpp === 4 ? buf[src + 3] : 255;
    src += bpp;
    px[dst] = r; px[dst + 1] = g; px[dst + 2] = b; px[dst + 3] = a;
    dst += 4;
  };
  const total = width * height;
  if (type === 2) {
    for (let i = 0; i < total; i++) put();
  } else {
    let i = 0;
    while (i < total) {
      const header = buf[src++];
      const count = (header & 0x7f) + 1;
      if (header & 0x80) {                       // RLE packet
        const b = buf[src], g = buf[src + 1], r = buf[src + 2], a = bpp === 4 ? buf[src + 3] : 255;
        src += bpp;
        for (let k = 0; k < count; k++) {
          px[dst] = r; px[dst + 1] = g; px[dst + 2] = b; px[dst + 3] = a; dst += 4;
        }
      } else for (let k = 0; k < count; k++) put();
      i += count;
    }
  }
  /* TGA rows run bottom-up unless descriptor bit 5 says top-down */
  if (!(desc & 0x20)) {
    const row = width * 4;
    const flip = Buffer.alloc(px.length);
    for (let y = 0; y < height; y++)
      px.copy(flip, (height - 1 - y) * row, y * row, (y + 1) * row);
    return { width, height, rgba: flip };
  }
  return { width, height, rgba: px };
}

function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: node tools/glb-fix-tga.js <model.glb>'); process.exit(2); }
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB: ' + file);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  const binStart = 20 + jsonLen + 8;
  const views = gltf.bufferViews || [];

  /* replace what needs replacing */
  const payload = new Map();                       // view index -> Buffer
  let fixed = 0;
  (gltf.images || []).forEach((img, i) => {
    if (img.bufferView === undefined) return;
    const v = views[img.bufferView];
    const off = binStart + (v.byteOffset || 0);
    const head = [...buf.slice(off, off + 4)];
    const ok = PNG_MAGIC.every((b, k) => head[k] === b) || JPG_MAGIC.every((b, k) => head[k] === b);
    if (ok) return;
    const tga = tgaDecode(buf.slice(off, off + v.byteLength));
    payload.set(img.bufferView, pngEncode(tga.width, tga.height, tga.rgba));
    console.log('  image[' + i + '] ' + (img.name || '') + ': ' + img.mimeType + ' ' +
                v.byteLength + ' B -> image/png ' + payload.get(img.bufferView).length +
                ' B (' + tga.width + 'x' + tga.height + ')');
    img.mimeType = 'image/png';
    if (img.name) img.name = img.name.replace(/\.tga$/i, '.png');
    fixed++;
  });
  if (!fixed) { console.log('nothing to fix in ' + path.basename(file)); return; }

  /* rebuild the binary buffer, 4-byte aligned, fixing offsets as we go */
  const parts = [];
  let cursor = 0;
  views.forEach((v, i) => {
    const data = payload.get(i) ||
      buf.slice(binStart + (v.byteOffset || 0), binStart + (v.byteOffset || 0) + v.byteLength);
    const pad = (4 - (cursor % 4)) % 4;
    if (pad) { parts.push(Buffer.alloc(pad)); cursor += pad; }
    v.byteOffset = cursor;
    v.byteLength = data.length;
    if (payload.has(i)) delete v.byteStride;       // never present on images anyway
    parts.push(data);
    cursor += data.length;
  });
  const binPad = (4 - (cursor % 4)) % 4;
  if (binPad) { parts.push(Buffer.alloc(binPad)); cursor += binPad; }
  const bin = Buffer.concat(parts);
  gltf.buffers[0].byteLength = cursor;

  let jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  if (jsonPad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);

  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + jsonBuf.length + 8 + bin.length, 8);
  head.writeUInt32LE(jsonBuf.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);              // JSON
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(bin.length, 0);
  binHead.writeUInt32LE(0x004e4942, 4);            // BIN
  fs.writeFileSync(file, Buffer.concat([head, jsonBuf, binHead, bin]));
  console.log('wrote ' + file + ' (' + (buf.length / 1048576).toFixed(2) + ' MB -> ' +
              ((20 + 8 + jsonBuf.length + 8 + bin.length) / 1048576).toFixed(2) + ' MB), ' +
              fixed + ' texture(s) converted');
}

main();
