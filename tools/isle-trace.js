// isle-trace.js - read the reference map picture (a PNG) and turn it into the
// data tables the ISLE ROYALE map is built from: the coastline (bearing ->
// radius), the inland water (as a depth field), the biome layout and the little
// offshore islets. Nothing here runs in the game - it is the one-off tool that
// produced the numbers pasted into index.html, kept so the island can be
// re-traced if the picture ever changes.
//
//   node tools/isle-trace.js map.png [out.json]
//
// It also writes tools/isle-trace-check.png: the picture with the traced
// coastline, the water field and the biome grid drawn over it, so the result
// can be eyeballed before anything is wired up.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------------------------------------------------------- PNG read
   Minimal 8-bit non-interlaced PNG decoder. The project has no npm deps (see
   the note in cdp-lib.js) and this only ever reads one screenshot. */
function readPNG(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  let plte = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') plte = data;
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error('only 8-bit PNGs are supported (this one is ' + depth + ')');
  if (interlace) throw new Error('interlaced PNGs are not supported');
  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!chans) throw new Error('unsupported colour type ' + ctype);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * chans;
  const out = Buffer.alloc(stride * h);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= chans ? cur[i - chans] : 0;
      const b = prev ? prev[i] : 0;
      const c = (prev && i >= chans) ? prev[i - chans] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (f !== 0) throw new Error('bad PNG filter ' + f);
      cur[i] = v & 255;
    }
  }
  return { w, h, chans, ctype, data: out, plte };
}

function makeSampler(png) {
  const { w, chans, ctype, data, plte } = png;
  return function px(x, y) {
    const i = (y * w + x) * chans;
    if (ctype === 3) {
      const p = data[i] * 3;
      return { r: plte[p], g: plte[p + 1], b: plte[p + 2] };
    }
    if (ctype === 0 || ctype === 4) {
      const v = data[i];
      return { r: v, g: v, b: v };
    }
    return { r: data[i], g: data[i + 1], b: data[i + 2] };
  };
}

/* ---------------------------------------------------------------- colour
   Hue in degrees, saturation and value in 0..1 - enough to separate the things
   the picture is made of (ocean, inland water, snow, sand, greenery) without
   hard-coding a palette that a different render would break. */
function hsv(c) {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hdeg = 0;
  if (d > 1e-6) {
    if (max === r) hdeg = 60 * (((g - b) / d) % 6);
    else if (max === g) hdeg = 60 * ((b - r) / d + 2);
    else hdeg = 60 * ((r - g) / d + 4);
  }
  if (hdeg < 0) hdeg += 360;
  return { h: hdeg, s: max <= 0 ? 0 : d / max, v: max };
}

/* OCEAN vs LAND: the sea is the big dark blue that reaches the frame edge, so
   flood-fill inwards from the border and call everything reached "ocean". A
   tolerance on top of the border colour keeps the vignette out of it. */
function oceanMask(png, s, tol) {
  const { w, h } = png;
  const border = [];
  for (let x = 0; x < w; x += 2) { border.push(s(x, 0)); border.push(s(x, h - 1)); }
  for (let y = 0; y < h; y += 2) { border.push(s(0, y)); border.push(s(w - 1, y)); }
  let r = 0, g = 0, b = 0;
  for (const c of border) { r += c.r; g += c.g; b += c.b; }
  const sea = { r: Math.round(r / border.length), g: Math.round(g / border.length),
                b: Math.round(b / border.length) };
  const near = c => Math.abs(c.r - sea.r) <= tol && Math.abs(c.g - sea.g) <= tol &&
                    Math.abs(c.b - sea.b) <= tol;
  const mask = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push(x); stack.push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { stack.push(y * w); stack.push(y * w + w - 1); }
  while (stack.length) {
    const idx = stack.pop();
    if (mask[idx]) continue;
    const x = idx % w, y = (idx - x) / w;
    if (!near(s(x, y))) continue;
    mask[idx] = 1;
    if (x > 0) stack.push(idx - 1);
    if (x < w - 1) stack.push(idx + 1);
    if (y > 0) stack.push(idx - w);
    if (y < h - 1) stack.push(idx + w);
  }
  return { mask, sea };
}

/* land components: the mainland is the biggest blob; the rest are the little
   offshore islets that get raised as their own bumps */
function components(png, land) {
  const { w, h } = png;
  const seen = new Int32Array(w * h).fill(-1);
  const blobs = [];
  for (let start = 0; start < w * h; start++) {
    if (!land[start] || seen[start] >= 0) continue;
    const id = blobs.length;
    let n = 0, sx = 0, sy = 0;
    let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
    const stack = [start];
    seen[start] = id;
    while (stack.length) {
      const idx = stack.pop();
      const x = idx % w, y = (idx - x) / w;
      n++; sx += x; sy += y;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      if (x > 0 && land[idx - 1] && seen[idx - 1] < 0) { seen[idx - 1] = id; stack.push(idx - 1); }
      if (x < w - 1 && land[idx + 1] && seen[idx + 1] < 0) { seen[idx + 1] = id; stack.push(idx + 1); }
      if (y > 0 && land[idx - w] && seen[idx - w] < 0) { seen[idx - w] = id; stack.push(idx - w); }
      if (y < h - 1 && land[idx + w] && seen[idx + w] < 0) { seen[idx + w] = id; stack.push(idx + w); }
    }
    blobs.push({ id, n, cx: sx / n, cy: sy / n, minx, maxx, miny, maxy });
  }
  blobs.sort((a, b) => b.n - a.n);
  return blobs;
}

/* ------------------------------------------------------------- classify
   Which of the four surfaces a land pixel is. Inland water is the same blue as
   the sea, but the caller has already ruled the sea out, so any blue left is a
   lake or a river. */
function classify(s, x, y) {
  const c = s(x, y);
  const { h, s: sat, v } = hsv(c);
  if (sat > 0.14 && h >= 148 && h <= 285 && v > 0.10 && !(v > 0.82 && sat < 0.22)) return 'water';
  if (v > 0.74 && sat < 0.22) return 'snow';
  if (h >= 16 && h < 68 && sat > 0.20) return 'sand';
  if (h >= 68 && h <= 175) return 'green';
  /* grey rock, pale ice, road markings: nearest reference colour wins */
  const refs = [[0.16, 0.17, 0.20, 'snow'], [0.66, 0.52, 0.22, 'sand'], [0.26, 0.45, 0.22, 'green']];
  let best = 'green', bestD = 1e9;
  for (const rf of refs) {
    const d = (c.r / 255 - rf[0]) ** 2 + (c.g / 255 - rf[1]) ** 2 + (c.b / 255 - rf[2]) ** 2;
    if (d < bestD) { bestD = d; best = rf[3]; }
  }
  return best;
}

/* ------------------------------------------------------------ PNG write
   Only used for the verification overlay. Filter 0 on every line, zlib deflate,
   hand-rolled CRC - the whole thing is 30 lines and needs no deps. */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function writePNG(file, w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]));
}
/* =====================================================================
   THE ANALYSIS - everything index.html needs, read off the picture.

   Coordinate note: the picture is stored top-down, so image +x is east and
   image +y is SOUTH. That is exactly the game's world axes (+x east, -z north),
   so nothing is mirrored anywhere: worldX = (px - cx) * k, worldZ = (py - cy) * k.
   ===================================================================== */
const GRID_WATER = 64;     // inland-water depth + valley fields, 64 x 64
const GRID_BIOME = 48;     // biome blocks, 48 x 48
const SHORE_SAMPLES = 48;  // coastline: one radius every 7.5 degrees of bearing
const DEPTH_PX = 3.0;      // distance inside the water that counts as full depth
const VALLEY_PX = 22;      // how far a river or lake pulls the land down around it

/* two-pass chamfer distance transform (1 / 1.4142 steps) on a seed field */
function chamfer(d, w, h) {
  const D1 = 1, D2 = 1.4142;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let best = d[i];
      if (x > 0) best = Math.min(best, d[i - 1] + D1);
      if (y > 0) best = Math.min(best, d[i - w] + D1);
      if (x > 0 && y > 0) best = Math.min(best, d[i - w - 1] + D2);
      if (x < w - 1 && y > 0) best = Math.min(best, d[i - w + 1] + D2);
      d[i] = best;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let best = d[i];
      if (x < w - 1) best = Math.min(best, d[i + 1] + D1);
      if (y < h - 1) best = Math.min(best, d[i + w] + D1);
      if (x < w - 1 && y < h - 1) best = Math.min(best, d[i + w + 1] + D2);
      if (x > 0 && y < h - 1) best = Math.min(best, d[i + w - 1] + D2);
      d[i] = best;
    }
  }
  return d;
}

/* the biggest land blob, as its own mask: a crescent island's centroid can sit
   in the sea, so the flood starts from the first land pixel found */
function mainlandMask(png, land) {
  const { w, h } = png;
  let seed = -1;
  for (let i = 0; i < w * h && seed < 0; i++) if (land[i]) seed = i;
  const one = new Uint8Array(w * h);
  const stack = [seed];
  one[seed] = 1;
  let n = 1;
  while (stack.length) {
    const idx = stack.pop();
    const x = idx % w, y = (idx - x) / w;
    if (x > 0 && land[idx - 1] && !one[idx - 1]) { one[idx - 1] = 1; n++; stack.push(idx - 1); }
    if (x < w - 1 && land[idx + 1] && !one[idx + 1]) { one[idx + 1] = 1; n++; stack.push(idx + 1); }
    if (y > 0 && land[idx - w] && !one[idx - w]) { one[idx - w] = 1; n++; stack.push(idx - w); }
    if (y < h - 1 && land[idx + w] && !one[idx + w]) { one[idx + w] = 1; n++; stack.push(idx + w); }
  }
  return { mask: one, n };
}

/* coastline: for every bearing, the last mainland pixel out from the centre,
   sampled over a small window of bearings so one stray pixel cannot spike it */
function traceShore(png, isMain, cx, cy) {
  const { w, h } = png;
  const out = [];
  for (let n = 0; n < SHORE_SAMPLES; n++) {
    const ang = (n / SHORE_SAMPLES) * Math.PI * 2;
    let best = 0;
    for (let da = -0.03; da <= 0.0301; da += 0.01) {
      const a = ang + da;
      const dx = Math.cos(a), dy = Math.sin(a);
      let last = 0;
      for (let r = 1; r < Math.max(w, h); r += 0.5) {
        const x = Math.round(cx + dx * r);
        const y = Math.round(cy + dy * r);
        if (x < 0 || y < 0 || x >= w || y >= h) break;
        if (isMain[y * w + x]) last = r;
      }
      if (last > best) best = last;
    }
    out.push([+ang.toFixed(4), +best.toFixed(2)]);
  }
  return out;
}

/* ---------- the two water fields, averaged down onto the 64 x 64 grid ----------
   The game samples these with bilinear filtering, so a cell that holds any water
   at all has to read as wet: the river is thinner than a cell. `depth` is how
   deep the carve goes (0 = dry land), `valley` is how close the nearest water is
   (9 = on the bank), which is what dips the land into a river valley. */
function buildWaterGrids(png, land, surf, dIn, dOut) {
  const { w, h } = png;
  const cell = w / GRID_WATER;
  const depth = [], valley = [];
  for (let j = 0; j < GRID_WATER; j++) {
    for (let i = 0; i < GRID_WATER; i++) {
      const x0 = Math.floor(i * cell), x1 = Math.min(w, Math.floor((i + 1) * cell));
      const y0 = Math.floor(j * cell), y1 = Math.min(h, Math.floor((j + 1) * cell));
      let wet = 0, landN = 0, deep = 0, outSum = 0, outN = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = y * w + x;
          if (!land[idx]) continue;
          landN++;
          if (surf[idx]) { wet++; deep = Math.max(deep, dIn[idx]); }
          else if (dOut[idx] < 1e5) { outSum += dOut[idx]; outN++; }
        }
      }
      if (!landN) {
        /* open sea: not water to carve, and not a valley either */
        depth.push('0');
        valley.push('0');
        continue;
      }
      const wetFrac = wet / landN;
      /* A cell counts as water once a good slice of it is water, so a lake or a
         river keeps the shape the picture draws instead of shrinking to its core.
         How deep the carve goes then follows how wet the cell is, which leaves a
         shallow shelf along every bank and full depth out in the middle. */
      const full = Math.min(9, Math.round(deep / DEPTH_PX));
      const d = wetFrac > 0.30 ? Math.max(1, Math.round(full * Math.min(1, wetFrac / 0.75))) : 0;
      const avgOut = outN ? outSum / outN : 0;
      /* wet cells and their immediate neighbours are valley floor */
      const v = wetFrac > 0.15 ? 9
        : Math.max(0, Math.min(9, Math.round((1 - Math.min(1, avgOut / VALLEY_PX)) * 9)));
      depth.push(String(d));
      valley.push(String(v));
    }
  }
  return { depth: depth.join(''), valley: valley.join('') };
}

/* ---------- biome blocks ----------
   The majority land surface of each block, with the sea and the inland water
   filled in from the nearest dry block so the underwater terrain still knows
   which biome it belongs to (a lake in the snow stays snowy underneath). */
function buildBiomeGrid(png, land, bio) {
  const { w, h } = png;
  const cell = w / GRID_BIOME;
  const cells = new Int8Array(GRID_BIOME * GRID_BIOME).fill(-1);
  for (let j = 0; j < GRID_BIOME; j++) {
    for (let i = 0; i < GRID_BIOME; i++) {
      const x0 = Math.floor(i * cell), x1 = Math.min(w, Math.floor((i + 1) * cell));
      const y0 = Math.floor(j * cell), y1 = Math.min(h, Math.floor((j + 1) * cell));
      const tally = [0, 0, 0];
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = y * w + x;
          if (!land[idx]) continue;
          const b = bio[idx];
          if (b < 3) tally[b]++;
        }
      }
      const n = tally[0] + tally[1] + tally[2];
      if (n >= 6) {
        cells[j * GRID_BIOME + i] = tally[1] > tally[0] && tally[1] >= tally[2] ? 1
          : (tally[2] > tally[0] ? 2 : 0);
      }
    }
  }
  /* fill the empty (sea / lake) blocks from the nearest known block */
  for (let pass = 0; pass < GRID_BIOME; pass++) {
    let filled = 0;
    for (let j = 0; j < GRID_BIOME; j++) {
      for (let i = 0; i < GRID_BIOME; i++) {
        const k = j * GRID_BIOME + i;
        if (cells[k] >= 0) continue;
        let sum = -1, n = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const y = j + dj, x = i + di;
            if (x < 0 || y < 0 || x >= GRID_BIOME || y >= GRID_BIOME) continue;
            const v = cells[y * GRID_BIOME + x];
            if (v >= 0) { sum = sum < 0 ? v : sum + v; n++; }
          }
        }
        if (n) { cells[k] = Math.round(sum / n); filled++; }
      }
    }
    if (!filled) break;
  }
  let out = '';
  for (let k = 0; k < cells.length; k++) out += String(Math.max(0, cells[k]));
  return out;
}

/* ---------------------------------------------------------------- the lot */
const ISLE_RADIUS_WORLD = 850;     // the island's world radius (4x Surf City's area)
const ISLE_MAP_SIZE = 2000;        // the world square that island has to fit in

function analyze(png, s, opts) {
  const { w, h } = png;
  const o = opts || {};
  /* The ocean is a flat dark blue, but it is not perfectly flat: the flood has to
     cross a slow gradient on its way in, so the tolerance cannot be tight. 46 was
     measured on this picture - the sea sits at rgb(2,21,39) and the darkest inland
     lake at rgb(4,32,56), which the water test below still catches. */
  const tol = o.tol === undefined ? 46 : o.tol;
  const { mask: ocean, sea } = oceanMask(png, s, tol);
  const land = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) land[i] = ocean[i] ? 0 : 1;
  const blobs = components(png, land);
  if (!blobs.length) throw new Error('no land found - is that really the map picture?');
  const main = mainlandMask(png, land);

  /* ---------- surface of every pixel ---------- */
  const surf = new Uint8Array(w * h);          // 1 = inland water
  const bio = new Uint8Array(w * h);           // 0 green, 1 sand, 2 snow, 3 water/skip
  const BIO = { green: 0, sand: 1, snow: 2, water: 3 };
  const tallyAll = [0, 0, 0, 0, 0];            // green, sand, snow, inland water, sea
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!land[i]) { bio[i] = 3; tallyAll[4]++; continue; }
      const c = classify(s, x, y);
      if (c === 'water') { surf[i] = 1; bio[i] = 3; tallyAll[3]++; }
      else { bio[i] = BIO[c]; tallyAll[BIO[c]]++; }
    }
  }

  /* ---------- water fields ----------
     dIn  grows INWARD from the banks, so at a water pixel it is how deep into the
          lake or river that pixel sits  -> the carve depth.
     dOut grows OUTWARD from the water, so at a dry pixel it is how far the nearest
          water is                      -> how far the land dips into the valley. */
  const BIG = 1e6;
  const dIn = new Float32Array(w * h).fill(BIG);
  const dOut = new Float32Array(w * h).fill(BIG);
  for (let i = 0; i < w * h; i++) {
    if (!land[i]) continue;
    if (surf[i]) dOut[i] = 0; else dIn[i] = 0;      // seeds: dry -> dIn, wet -> dOut
  }
  chamfer(dIn, w, h);
  chamfer(dOut, w, h);
  for (let i = 0; i < w * h; i++) {
    if (dIn[i] > BIG / 2) dIn[i] = BIG;
    if (dOut[i] > BIG / 2) dOut[i] = BIG;
  }

  /* ---------- coastline, calibration, islets ---------- */
  const shore = traceShore(png, main.mask, blobs[0].cx, blobs[0].cy);
  let maxR = 0, minR = 1e9;
  for (const entry of shore) {
    if (entry[1] > maxR) maxR = entry[1];
    if (entry[1] < minR) minR = entry[1];
  }
  if (!(maxR > 0)) throw new Error('the coastline trace found nothing - try a smaller -tol');
  const k = ISLE_RADIUS_WORLD / maxR;                 // world units per picture pixel
  const islets = [];
  for (let i = 1; i < blobs.length; i++) {
    if (blobs[i].n < 6) continue;
    islets.push({
      px: +blobs[i].cx.toFixed(2), py: +blobs[i].cy.toFixed(2),
      r: +(Math.sqrt(blobs[i].n / Math.PI)).toFixed(2), n: blobs[i].n
    });
  }

  const grids = buildWaterGrids(png, land, surf, dIn, dOut);
  return {
    image: { w, h, sea },
    mainland: { px: +blobs[0].cx.toFixed(2), py: +blobs[0].cy.toFixed(2), areaPx: blobs[0].n,
                minx: blobs[0].minx, maxx: blobs[0].maxx,
                miny: blobs[0].miny, maxy: blobs[0].maxy },
    scale: { k: +k.toFixed(5), islandRadiusPx: +maxR.toFixed(2),
             islandRadiusPxMin: +minR.toFixed(2),
             worldRadius: ISLE_RADIUS_WORLD, mapSize: ISLE_MAP_SIZE,
             /* the picture's own square in world units, centred on the island */
             imageWorldSpan: +(w * k).toFixed(1),
             imageWorldHalf: +(w * k / 2).toFixed(1) },
    shore,
    depth: grids.depth,
    valley: grids.valley,
    biome: buildBiomeGrid(png, land, bio),
    islets,
    stats: {
      landPx: blobs[0].n, isletPx: blobs.slice(1).reduce((a, b) => a + b.n, 0),
      seaPx: tallyAll[4], inlandWaterPx: tallyAll[3],
      greenPx: tallyAll[0], sandPx: tallyAll[1], snowPx: tallyAll[2]
    },
    land,
    surf,
    dIn,
    dOut,
    ocean
  };
}

/* =====================================================================
   CLI: trace a picture, write the data and a picture to check it against.
   ===================================================================== */
function blend(dst, w, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= w) return;
  const i = (y * w + x) * 3;
  if (i + 2 >= dst.length) return;
  dst[i] = Math.round(dst[i] * (1 - a) + r * a);
  dst[i + 1] = Math.round(dst[i + 1] * (1 - a) + g * a);
  dst[i + 2] = Math.round(dst[i + 2] * (1 - a) + b * a);
}

function overlay(res, png, s, outFile) {
  const { w, h } = png;
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = s(x, y);
      const i = (y * w + x) * 3;
      buf[i] = c.r; buf[i + 1] = c.g; buf[i + 2] = c.b;
    }
  }
  const BW = { 0: [40, 220, 90], 1: [240, 200, 40], 2: [140, 220, 255] };
  /* biome blocks, faint */
  const bc = w / GRID_BIOME;
  for (let j = 0; j < GRID_BIOME; j++) {
    for (let i = 0; i < GRID_BIOME; i++) {
      const v = +res.biome[j * GRID_BIOME + i];
      const col = BW[v] || [255, 0, 255];
      const x0 = Math.floor(i * bc), x1 = Math.min(w, Math.floor((i + 1) * bc));
      const y0 = Math.floor(j * bc), y1 = Math.min(h, Math.floor((j + 1) * bc));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (!res.land[y * w + x]) continue;
          blend(buf, w, x, y, col[0], col[1], col[2], 0.14);
        }
      }
      /* cell corner pins so the grid pitch is visible */
      blend(buf, w, x0, y0, 255, 255, 255, 0.5);
    }
  }
  /* inland water from the traced field, strong */
  const wc = w / GRID_WATER;
  for (let j = 0; j < GRID_WATER; j++) {
    for (let i = 0; i < GRID_WATER; i++) {
      const d = +res.depth[j * GRID_WATER + i];
      if (!d) continue;
      const x0 = Math.floor(i * wc), x1 = Math.min(w, Math.floor((i + 1) * wc));
      const y0 = Math.floor(j * wc), y1 = Math.min(h, Math.floor((j + 1) * wc));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) blend(buf, w, x, y, 0, 255, 255, 0.30 + d * 0.05);
      }
    }
  }
  /* the traced coastline, in magenta */
  const cx = res.mainland.px, cy = res.mainland.py;
  const pt = n => {
    const a = res.shore[n][0], r = res.shore[n][1];
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  };
  for (let n = 0; n < res.shore.length; n++) {
    const a = pt(n), b = pt((n + 1) % res.shore.length);
    const steps = Math.max(2, Math.round(Math.hypot(b.x - a.x, b.y - a.y)));
    for (let q = 0; q < steps; q++) {
      const t = q / steps;
      const x = Math.round(a.x + (b.x - a.x) * t), y = Math.round(a.y + (b.y - a.y) * t);
      blend(buf, w, x, y, 255, 0, 255, 1);
      blend(buf, w, x + 1, y, 255, 0, 255, 0.55);
      blend(buf, w, x, y + 1, 255, 0, 255, 0.55);
    }
  }
  /* islets */
  for (const is of res.islets) {
    for (let a = 0; a < Math.PI * 2; a += 0.08) {
      blend(buf, w, Math.round(is.px + Math.cos(a) * is.r), Math.round(is.py + Math.sin(a) * is.r),
        255, 120, 0, 1);
    }
  }
  /* centre cross */
  for (let d = -8; d <= 8; d++) {
    blend(buf, w, Math.round(cx) + d, Math.round(cy), 255, 255, 255, 1);
    blend(buf, w, Math.round(cx), Math.round(cy) + d, 255, 255, 255, 1);
  }
  writePNG(outFile, w, h, buf);
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('usage: node tools/isle-trace.js <map.png> [out.json]');
    process.exit(2);
  }
  const img = path.resolve(args[0]);
  const outJson = path.resolve(args[1] || 'tools/isle-trace.json');
  const outPng = path.join(path.dirname(outJson), 'isle-trace-check.png');
  const png = readPNG(img);
  const s = makeSampler(png);
  console.log('picture : ' + path.basename(img) + '  ' + png.w + ' x ' + png.h +
    '  colour type ' + png.ctype);
  const res = analyze(png, s);
  const st = res.stats, total = res.image.w * res.image.h;
  const pc = v => (v / total * 100).toFixed(1) + '%';
  console.log('sea     : rgb(' + [res.image.sea.r, res.image.sea.g, res.image.sea.b].join(',') + ')  ' +
    'covering ' + pc(st.seaPx));
  console.log('mainland: ' + st.landPx + ' px, centre ' + res.mainland.px + ',' + res.mainland.py +
    ', bbox ' + res.mainland.minx + '..' + res.mainland.maxx + ' x ' +
    res.mainland.miny + '..' + res.mainland.maxy);
  console.log('surface : ' + pc(st.greenPx) + ' green, ' + pc(st.sandPx) + ' sand, ' +
    pc(st.snowPx) + ' snow, ' + pc(st.inlandWaterPx) + ' inland water');
  console.log('coast   : radius ' + res.scale.islandRadiusPxMin + '..' + res.scale.islandRadiusPx +
    ' px  ->  k = ' + res.scale.k + ' world units per pixel');
  console.log('scale   : island radius ' + res.scale.worldRadius + ' world units inside a ' +
    res.scale.mapSize + ' map; the picture covers ' + res.scale.imageWorldSpan +
    ' units across (half ' + res.scale.imageWorldHalf + ')');
  console.log('islets  : ' + res.islets.length + ' (' + res.islets.slice(0, 6).map(function (i) {
    return i.r.toFixed(1) + 'px@' + i.px + ',' + i.py;
  }).join('  ') + ')');
  let wetCell = 0, deepCell = 0, valleyCell = 0, maxDepth = 0;
  for (let i = 0; i < res.depth.length; i++) {
    const d = +res.depth[i];
    if (d) wetCell++;
    if (d >= 5) deepCell++;
    if (d > maxDepth) maxDepth = d;
    if (+res.valley[i]) valleyCell++;
  }
  const g2 = GRID_WATER * GRID_WATER;
  console.log('carve   : ' + wetCell + '/' + g2 + ' cells hold water (' + deepCell +
    ' of them >= depth 5, max ' + maxDepth + '); ' + valleyCell + ' cells in a valley');
  const clean = {
    image: res.image, mainland: res.mainland, scale: res.scale, shore: res.shore,
    depth: res.depth, valley: res.valley, biome: res.biome, islets: res.islets, stats: res.stats
  };
  fs.writeFileSync(outJson, JSON.stringify(clean, null, 1));
  console.log('wrote ' + outJson);
  overlay(res, png, s, outPng);
  console.log('wrote ' + outPng + '  (open it: magenta = traced coast, cyan = carved water)');
}

if (require.main === module) main();
module.exports = { readPNG, makeSampler, hsv, oceanMask, components, classify, writePNG,
                   analyze, chamfer, buildWaterGrids, buildBiomeGrid, traceShore, GRID_WATER, GRID_BIOME };
