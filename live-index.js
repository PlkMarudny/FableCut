/* ═══════════════════════════════════════════════════════════════════════════
   fMP4 time → byte index for MediaMTX recordings.

   MediaMTX writes crash-safe fragments, not a progressive MP4 with a sample
   table. A browser Range seek has no map from time to bytes unless something
   walks the boxes once and keeps that map.

   This module is that walk. It does not remux, decode, or touch the compositor.
   Preview still uses the /get blob path until a later step feeds this index
   into MSE.

   Use as a module:  const { indexFile, indexPath } = require("./live-index");
   Use from the CLI: node live-index.js <file-or-dir> [--out=path] [--json] [--no-write]
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const VERSION = 1;
const MAX_PARSE = 32 * 1024 * 1024;
const CONTAINERS = new Set([
  "moov", "trak", "mdia", "minf", "stbl", "edts", "mvex", "moof", "traf",
]);
const MEDIA_EXT = new Set([".mp4", ".m4s", ".cmfv"]);

function sidecarPath(file) {
  return file + ".idx.json";
}

function roundTime(t) {
  return Math.round(t * 1e6) / 1e6;
}

function parseMtxName(name) {
  const m = String(name).match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-(\d+))?/);
  if (!m) return null;
  const ms = m[7] ? Math.floor(Number(m[7].slice(0, 3).padEnd(3, "0"))) : 0;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${String(ms).padStart(3, "0")}`;
  return iso;
}

function peekHeader(buf, offset) {
  if (offset + 8 > buf.length) return null;
  let size = buf.readUInt32BE(offset);
  const type = buf.toString("latin1", offset + 4, offset + 8);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > buf.length) return null;
    size = Number(buf.readBigUInt64BE(offset + 8));
    header = 16;
  } else if (size === 0) {
    size = buf.length - offset;
  }
  if (!Number.isFinite(size) || size < header) return null;
  const truncated = offset + size > buf.length;
  const payloadStart = offset + header;
  return {
    type, size, header, offset, payloadStart,
    payloadEnd: truncated ? buf.length : offset + size,
    truncated,
  };
}

function walkBoxes(buf, start, end, visit, deep) {
  let off = start;
  while (off < end) {
    const b = peekHeader(buf, off);
    if (!b || b.offset + 8 > end) break;
    visit(b);
    if (deep && CONTAINERS.has(b.type) && !b.truncated)
      walkBoxes(buf, b.payloadStart, Math.min(b.payloadEnd, end), visit, true);
    if (b.size <= 0) break;
    const next = b.offset + b.size;
    if (next <= off) break;
    off = next;
  }
}

function fullBox(buf, b) {
  if (b.payloadStart + 4 > buf.length) return null;
  return {
    version: buf[b.payloadStart],
    flags: buf.readUIntBE(b.payloadStart + 1, 3),
    data: b.payloadStart + 4,
  };
}

function readMdhdTimescale(buf, b) {
  const fb = fullBox(buf, b);
  if (!fb) return 0;
  const off = fb.version === 1 ? fb.data + 16 : fb.data + 8;
  if (off + 4 > buf.length) return 0;
  return buf.readUInt32BE(off);
}

function readTkhdId(buf, b) {
  const fb = fullBox(buf, b);
  if (!fb) return 0;
  const off = fb.version === 1 ? fb.data + 16 : fb.data + 8;
  if (off + 4 > buf.length) return 0;
  return buf.readUInt32BE(off);
}

function readHdlr(buf, b) {
  const fb = fullBox(buf, b);
  if (!fb || fb.data + 8 > buf.length) return "";
  return buf.toString("latin1", fb.data + 4, fb.data + 8);
}

function readTfhdId(buf, b) {
  const fb = fullBox(buf, b);
  if (!fb || fb.data + 4 > buf.length) return 0;
  return buf.readUInt32BE(fb.data);
}

function readTfdt(buf, b) {
  const fb = fullBox(buf, b);
  if (!fb) return null;
  if (fb.version === 1) {
    if (fb.data + 8 > buf.length) return null;
    return Number(buf.readBigUInt64BE(fb.data));
  }
  if (fb.data + 4 > buf.length) return null;
  return buf.readUInt32BE(fb.data);
}

function parseMoov(moovBuf) {
  const root = peekHeader(moovBuf, 0);
  if (!root || root.type !== "moov") return { tracks: [], movieTimescale: 0 };
  const tracks = [];
  let movieTimescale = 0;
  walkBoxes(moovBuf, root.payloadStart, root.payloadEnd, (child) => {
    if (child.type === "mvhd") movieTimescale = readMdhdTimescale(moovBuf, child);
    if (child.type !== "trak") return;
    const track = { id: 0, handler: "", timescale: 0 };
    walkBoxes(moovBuf, child.payloadStart, child.payloadEnd, (b) => {
      if (b.type === "tkhd") track.id = readTkhdId(moovBuf, b);
      if (b.type === "mdhd") track.timescale = readMdhdTimescale(moovBuf, b);
      if (b.type === "hdlr") track.handler = readHdlr(moovBuf, b);
    }, true);
    tracks.push(track);
  }, false);
  return { tracks, movieTimescale };
}

function pickVideoTrack(tracks) {
  return tracks.find((t) => t.handler === "vide") || tracks[0] || null;
}

function parseMoof(moofBuf, tracks) {
  const root = peekHeader(moofBuf, 0);
  if (!root || root.type !== "moof") return null;
  const preferred = pickVideoTrack(tracks);
  let chosen = null;
  walkBoxes(moofBuf, root.payloadStart, root.payloadEnd, (child) => {
    if (child.type !== "traf") return;
    let trackId = 0, decodeTime = null;
    walkBoxes(moofBuf, child.payloadStart, child.payloadEnd, (b) => {
      if (b.type === "tfhd") trackId = readTfhdId(moofBuf, b);
      if (b.type === "tfdt") decodeTime = readTfdt(moofBuf, b);
    }, false);
    const track = tracks.find((t) => t.id === trackId) || preferred;
    const ts = (track && track.timescale) || 1;
    const rec = {
      trackId,
      decodeTime,
      t: decodeTime == null ? 0 : decodeTime / ts,
    };
    if (!chosen) chosen = rec;
    if (preferred && trackId === preferred.id) chosen = rec;
  }, false);
  return chosen;
}

function inferDuration(fragments) {
  if (!fragments.length) return 0;
  if (fragments.length === 1) return roundTime(fragments[0].t + 1);
  const deltas = [];
  for (let i = 1; i < fragments.length; i++)
    deltas.push(fragments[i].t - fragments[i - 1].t);
  deltas.sort((a, b) => a - b);
  const med = deltas[Math.floor(deltas.length / 2)];
  return roundTime(fragments[fragments.length - 1].t + med);
}

function readExact(fd, offset, n) {
  const buf = Buffer.alloc(n);
  let got = 0;
  while (got < n) {
    const k = fs.readSync(fd, buf, got, n - got, offset + got);
    if (k <= 0) return got ? buf.subarray(0, got) : null;
    got += k;
  }
  return buf;
}

function readHeader(fd, offset, fileSize) {
  if (offset + 8 > fileSize) return null;
  const head = readExact(fd, offset, 8);
  if (!head || head.length < 8) return null;
  let size = head.readUInt32BE(0);
  const type = head.toString("latin1", 4, 8);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > fileSize) return { type, size: 0, header: 16, offset, truncated: true };
    const ext = readExact(fd, offset + 8, 8);
    if (!ext || ext.length < 8) return { type, size: 0, header: 16, offset, truncated: true };
    size = Number(ext.readBigUInt64BE(0));
    header = 16;
  } else if (size === 0) {
    size = fileSize - offset;
  }
  if (!Number.isFinite(size) || size < header)
    return { type, size: 0, header, offset, truncated: true };
  return { type, size, header, offset, truncated: offset + size > fileSize };
}

/* Index a finished or growing fMP4. A truncated tail (open last part) is
   ignored so the rows that remain are Range-safe. */
function indexFile(filePath) {
  const abs = path.resolve(filePath);
  const st = fs.statSync(abs);
  const fd = fs.openSync(abs, "r");
  try {
    let offset = 0;
    let tracks = [];
    let initEnd = 0;
    const fragments = [];
    let pending = null;

    while (offset < st.size) {
      const hdr = readHeader(fd, offset, st.size);
      if (!hdr || hdr.truncated) break;

      if (hdr.type === "ftyp" || hdr.type === "styp") {
        if (offset === 0 || offset < initEnd) initEnd = offset + hdr.size;
      } else if (hdr.type === "moov") {
        if (hdr.size <= MAX_PARSE) {
          const moovBuf = readExact(fd, offset, hdr.size);
          if (moovBuf && moovBuf.length === hdr.size)
            tracks = parseMoov(moovBuf).tracks;
        }
        initEnd = offset + hdr.size;
      } else if (hdr.type === "moof") {
        let t = 0;
        if (hdr.size <= MAX_PARSE) {
          const moofBuf = readExact(fd, offset, hdr.size);
          if (moofBuf && moofBuf.length === hdr.size) {
            const info = parseMoof(moofBuf, tracks);
            if (info) t = info.t;
          }
        }
        pending = { offset, t };
      } else if (hdr.type === "mdat") {
        if (pending) {
          fragments.push({
            t: roundTime(pending.t),
            offset: pending.offset,
            size: (offset + hdr.size) - pending.offset,
          });
          pending = null;
        }
      } else if (hdr.type !== "free" && hdr.type !== "skip" && hdr.type !== "wide") {
        pending = null;
      }

      offset += hdr.size;
    }

    const video = pickVideoTrack(tracks);
    return {
      version: VERSION,
      file: abs,
      name: path.basename(abs),
      size: st.size,
      mtimeMs: st.mtimeMs,
      timescale: (video && video.timescale) || (tracks[0] && tracks[0].timescale) || 0,
      tracks: tracks.map((t) => ({ id: t.id, handler: t.handler, timescale: t.timescale })),
      init: { offset: 0, size: initEnd },
      fragments,
      duration: inferDuration(fragments),
      nameOrigin: parseMtxName(path.basename(abs)),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function isFresh(idx, filePath) {
  try {
    const st = fs.statSync(filePath);
    return idx && idx.size === st.size && Math.abs((idx.mtimeMs || 0) - st.mtimeMs) < 2;
  } catch {
    return false;
  }
}

function atomicWrite(file, text) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function writeIndex(idx, outPath) {
  const dest = outPath || sidecarPath(idx.file);
  atomicWrite(dest, JSON.stringify(idx, null, 2) + "\n");
  return dest;
}

function readIndex(filePath) {
  const dest = sidecarPath(filePath);
  if (!fs.existsSync(dest)) return null;
  try { return JSON.parse(fs.readFileSync(dest, "utf8")); }
  catch { return null; }
}

function isMediaFile(name) {
  return MEDIA_EXT.has(path.extname(name).toLowerCase());
}

function indexDir(dirPath, opts = {}) {
  const abs = path.resolve(dirPath);
  const names = fs.readdirSync(abs).filter(isMediaFile).sort();
  const segments = [];
  for (const name of names) {
    const file = path.join(abs, name);
    const idx = indexFile(file);
    if (!opts.noWrite) writeIndex(idx, opts.out && names.length === 1 ? opts.out : undefined);
    segments.push(idx);
  }
  return { version: VERSION, dir: abs, segments };
}

function indexPath(p, opts = {}) {
  const abs = path.resolve(p);
  const st = fs.statSync(abs);
  if (st.isDirectory()) return indexDir(abs, opts);
  const idx = indexFile(abs);
  if (!opts.noWrite) writeIndex(idx, opts.out);
  return idx;
}

function fragmentAt(idx, t) {
  const f = idx.fragments || [];
  if (!f.length) return null;
  if (t < f[0].t) return f[0];
  let lo = 0, hi = f.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (f[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return f[lo];
}

function fmtHMS(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00:00";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h + ":" + String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
}

function summarize(idx) {
  const n = idx.fragments.length;
  const first = n ? idx.fragments[0] : null;
  const last = n ? idx.fragments[n - 1] : null;
  const lines = [
    idx.file,
    `  init      ${idx.init.offset} + ${idx.init.size} B`,
    `  timescale ${idx.timescale}` + (idx.tracks.length
      ? "  tracks " + idx.tracks.map((t) => t.handler + ":" + t.id + "@" + t.timescale).join(",")
      : ""),
    `  fragments ${n}` + (n ? `  t ${first.t} → ${last.t}  span ${fmtHMS(idx.duration)}` : ""),
    `  file      ${idx.size} B`,
  ];
  if (n) {
    const show = n <= 5 ? idx.fragments : [idx.fragments[0], idx.fragments[1], idx.fragments[2], last];
    const seen = new Set();
    for (const f of show) {
      if (seen.has(f.offset)) continue;
      seen.add(f.offset);
      lines.push(`    t=${f.t}  off=${f.offset}  size=${f.size}`);
      if (show === idx.fragments) continue;
      if (f === idx.fragments[2] && n > 5) lines.push("    …");
    }
  }
  return lines.join("\n");
}

module.exports = {
  VERSION, sidecarPath, indexFile, indexDir, indexPath, writeIndex, readIndex,
  isFresh, fragmentAt, parseMtxName, fmtHMS, summarize,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    console.error("Usage: node live-index.js <file-or-dir> [--out=path] [--json] [--no-write]");
    process.exit(1);
  }
  const outArg = args.find((a) => a.startsWith("--out="));
  const opts = {
    out: outArg ? outArg.slice(6) : undefined,
    noWrite: args.includes("--no-write"),
  };
  try {
    const result = indexPath(target, opts);
    if (args.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.segments) {
      console.log(`Indexed ${result.segments.length} file(s) in ${result.dir}`);
      for (const idx of result.segments) {
        console.log(summarize(idx));
        if (!opts.noWrite) console.log("  wrote     " + sidecarPath(idx.file));
      }
    } else {
      console.log(summarize(result));
      if (!opts.noWrite) console.log("  wrote     " + (opts.out || sidecarPath(result.file)));
    }
  } catch (e) {
    console.error("live-index failed: " + e.message);
    process.exit(1);
  }
}
