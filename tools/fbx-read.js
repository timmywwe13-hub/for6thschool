// =====================================================================
// Minimal reader for Kaydara binary FBX (the format Mixamo/Blender export).
//
// Why: the project ships no FBX importer and no npm dependencies, but the
// player's walk/run motion arrives as .fbx. This module parses the container
// into a plain node tree - { name, props, children } - so tools/fbx-bake.js
// can retarget those clips onto the game's own character rig at build time.
//
// Usage as a library:  const fbx = require('./fbx-read'); fbx.read(buffer)
// Usage as a dump:     node tools/fbx-read.js <file.fbx> [--depth N]
// =====================================================================
'use strict';
const fs = require('fs');
const zlib = require('zlib');

/* ---- property records -------------------------------------------------
   Arrays carry their element count, an encoding flag and (when the flag is
   1) the byte length of an inflated-away zlib stream holding the data. */
const ELEM = { f: 4, d: 8, l: 8, i: 4, b: 1 };

function decodeArray(code, bytes) {
  const ab = new ArrayBuffer(bytes.length);
  Buffer.from(ab).set(bytes);
  if (code === 'f') return new Float32Array(ab);
  if (code === 'd') return new Float64Array(ab);
  if (code === 'i') return new Int32Array(ab);
  if (code === 'b') return new Int8Array(ab);
  const view = new DataView(ab);                       // 'l' = int64
  const out = new Array(ab.byteLength / 8);
  for (let i = 0; i < out.length; i++) out[i] = Number(view.getBigInt64(i * 8, true));
  return out;
}

function readProperties(buf, pos, count, out) {
  for (let i = 0; i < count; i++) {
    const code = String.fromCharCode(buf.readUInt8(pos));
    pos += 1;
    switch (code) {
      case 'Y': out.push(buf.readInt16LE(pos)); pos += 2; break;
      case 'C': out.push(buf.readUInt8(pos) !== 0); pos += 1; break;
      case 'I': out.push(buf.readInt32LE(pos)); pos += 4; break;
      case 'F': out.push(buf.readFloatLE(pos)); pos += 4; break;
      case 'D': out.push(buf.readDoubleLE(pos)); pos += 8; break;
      case 'L': out.push(Number(buf.readBigInt64LE(pos))); pos += 8; break;
      case 'S': {
        const n = buf.readUInt32LE(pos); pos += 4;
        out.push(buf.toString('latin1', pos, pos + n)); pos += n;
        break;
      }
      case 'R': {
        const n = buf.readUInt32LE(pos); pos += 4;
        out.push(buf.slice(pos, pos + n)); pos += n;
        break;
      }
      case 'f': case 'd': case 'l': case 'i': case 'b': {
        const len = buf.readUInt32LE(pos); pos += 4;
        const enc = buf.readUInt32LE(pos); pos += 4;
        const clen = buf.readUInt32LE(pos); pos += 4;
        const size = enc ? clen : len * ELEM[code];
        let bytes = buf.slice(pos, pos + size);
        pos += size;
        if (enc) {
          /* FBX stores zlib streams; a few exporters write raw deflate */
          try { bytes = zlib.inflateSync(bytes); }
          catch (e) { bytes = zlib.inflateRawSync(bytes); }
        }
        out.push(decodeArray(code, bytes));
        break;
      }
      default:
        throw new Error('unknown FBX property type ' + JSON.stringify(code) + ' at ' + (pos - 1));
    }
  }
  return pos;
}

/* ---- node records -----------------------------------------------------
   A node always ends with a record of zeros: 13 bytes wide in the 32-bit
   layout and 25 bytes in the 64-bit one (FBX >= 7500). Both are consumed by
   the three offset fields plus the (empty) name length, so the loop can just
   return as soon as it sees a zero end offset. */
function readNodes(buf, pos, version) {
  const wide = version >= 7500;
  const nodes = [];
  for (;;) {
    let end, numProps;
    if (wide) {
      end = Number(buf.readBigUInt64LE(pos)); pos += 8;
      numProps = Number(buf.readBigUInt64LE(pos)); pos += 8;
      pos += 8;                                            // property list length
    } else {
      end = buf.readUInt32LE(pos); pos += 4;
      numProps = buf.readUInt32LE(pos); pos += 4;
      pos += 4;                                            // property list length
    }
    const nameLen = buf.readUInt8(pos); pos += 1;
    if (end === 0) return { nodes, pos };                  // list terminator
    const name = buf.toString('latin1', pos, pos + nameLen);
    pos += nameLen;
    const props = [];
    pos = readProperties(buf, pos, numProps, props);
    let children = [];
    if (pos < end) {
      const sub = readNodes(buf, pos, version);
      children = sub.nodes;
      pos = sub.pos;
    }
    nodes.push({ name, props, children, end });
  }
}

/* Parses a whole .fbx buffer: { version, creator, nodes }. */
function read(buf) {
  if (buf.length < 27) throw new Error('file is too short to be an FBX');
  const magic = buf.toString('latin1', 0, 21);
  if (magic !== 'Kaydara FBX Binary  \u0000' && magic !== 'Kaydara FBX Binary  ') {
    throw new Error('not a binary FBX (magic: ' + JSON.stringify(magic) + ')');
  }
  const version = buf.readUInt32LE(23);
  const top = readNodes(buf, 27, version);
  const out = { version, nodes: top.nodes, creator: '' };
  for (const n of top.nodes) if (n.name === 'Creator' && n.props.length) out.creator = n.props[0];
  return out;
}

/* ---- helpers the bake tool leans on ---------------------------------- */
/* every node called `name` anywhere below `node` (or node itself) */
function find(node, name) {
  const out = [];
  const roots = node.children ? node.children : (node.nodes || [node]);
  (function walk(list) {
    for (const n of list) {
      if (n.name === name) out.push(n);
      if (n.children && n.children.length) walk(n.children);
    }
  })(roots);
  return out;
}
/* the first property of the first <name> child, or `fallback` */
function prop(node, name, fallback) {
  const hit = (node.children || []).find(c => c.name === name);
  return hit && hit.props.length ? hit.props[0] : fallback;
}
function props(node, name) {
  const hit = (node.children || []).find(c => c.name === name);
  return hit ? hit.props : null;
}
/* a triple of numbers (Lcl Translation / PreRotation / P), zeros when absent */
function vec3(node, name, fallback) {
  const v = prop(node, name, null);
  if (!v || v.length < 3) return fallback ? fallback.slice() : [0, 0, 0];
  return [v[0], v[1], v[2]];
}

function summarize(v, max) {
  if (v && (ArrayBuffer.isView(v) || Array.isArray(v))) {
    const head = [];
    for (let i = 0; i < Math.min(v.length, max); i++) head.push(Number(v[i]).toFixed(3));
    return '{' + v.constructor.name + ' n=' + v.length + '} ' + head.join(', ') +
           (v.length > max ? ' ...' : '');
  }
  if (Buffer.isBuffer(v)) return '{raw n=' + v.length + '}';
  if (typeof v === 'string') return JSON.stringify(v.length > 60 ? v.slice(0, 60) + '...' : v);
  if (typeof v === 'number') return String(+v.toFixed(4));
  return String(v);
}

/* Human-readable tree, with the giant geometry arrays collapsed. */
const SKIP = /^(Vertices|PolygonVertexIndex|Normals|UV|UVIndex|Colors|KeyValueFloat|KeyTime)$/;
function dump(fbx, opts) {
  const depth = (opts && opts.depth) === undefined ? 3 : opts.depth;
  const lines = [];
  (function walk(list, d) {
    for (const n of list) {
      const props = n.props;
      const shown = SKIP.test(n.name) ? [] : props.slice(0, 5).map(p => summarize(p, 4));
      const kids = n.children ? n.children.length : 0;
      lines.push('  '.repeat(d) + n.name + ' [' + props.length + 'p' + (kids ? ' ' + kids + 'c' : '') + ']' +
        (shown.length ? '  ' + shown.join(' , ') : ''));
      if (d < depth) walk(n.children || [], d + 1);
    }
  })(fbx.nodes, 0);
  return lines.join('\n');
}

module.exports = { read, find, prop, props, vec3, dump, summarize };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node tools/fbx-read.js <file.fbx> [--depth N]'); process.exit(2); }
  const di = process.argv.indexOf('--depth');
  const fbx = read(fs.readFileSync(file));
  console.log(file + ': FBX ' + fbx.version + ', creator ' + JSON.stringify(fbx.creator) +
    ', ' + fbx.nodes.length + ' top-level nodes');
  console.log(dump(fbx, { depth: di < 0 ? 3 : Number(process.argv[di + 1]) }));
}
