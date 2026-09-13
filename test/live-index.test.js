/* live-index.js: time → byte map for MediaMTX-style fragmented MP4.
   The builder below is only a box salad — just enough ISO-BMFF for the
   walker to find mdhd / tfdt and the moof+mdat pairs. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ROOT } = require("./helpers");
const {
  indexFile, indexDir, indexPath, writeIndex, readIndex, isFresh,
  fragmentAt, sidecarPath, parseMtxName, summarize,
} = require("../live-index");

function box(type, ...parts) {
  const payload = Buffer.concat(parts.map((p) => Buffer.isBuffer(p) ? p : Buffer.from(p)));
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + payload.length, 0);
  h.write(type, 4, 4, "latin1");
  return Buffer.concat([h, payload]);
}

function fullBox(type, version, flags, payload) {
  const vf = Buffer.alloc(4);
  vf.writeUInt8(version, 0);
  vf.writeUIntBE(flags, 1, 3);
  return box(type, vf, payload);
}

function ftyp() {
  const p = Buffer.alloc(12);
  p.write("isom", 0, 4, "latin1");
  p.write("isom", 8, 4, "latin1");
  return box("ftyp", p);
}

function mdhd(timescale) {
  const p = Buffer.alloc(20);
  p.writeUInt32BE(timescale, 8);
  return fullBox("mdhd", 0, 0, p);
}

function tkhd(id) {
  const p = Buffer.alloc(12);
  p.writeUInt32BE(id, 8);
  return fullBox("tkhd", 0, 0, p);
}

function hdlr(handler) {
  const p = Buffer.alloc(8);
  p.write(handler, 4, 4, "latin1");
  return fullBox("hdlr", 0, 0, p);
}

function trak(id, handler, timescale) {
  return box("trak", tkhd(id), box("mdia", mdhd(timescale), hdlr(handler)));
}

function tfhd(trackId) {
  const p = Buffer.alloc(4);
  p.writeUInt32BE(trackId, 0);
  return fullBox("tfhd", 0, 0, p);
}

function tfdt(t, version = 0) {
  if (version === 1) {
    const p = Buffer.alloc(8);
    p.writeBigUInt64BE(BigInt(t), 0);
    return fullBox("tfdt", 1, 0, p);
  }
  const p = Buffer.alloc(4);
  p.writeUInt32BE(t, 0);
  return fullBox("tfdt", 0, 0, p);
}

function traf(trackId, decodeTime, tfdtVersion) {
  return box("traf", tfhd(trackId), tfdt(decodeTime, tfdtVersion));
}

function mdat(n = 8) {
  return box("mdat", Buffer.alloc(n));
}

function buildFmp4({
  tracks = [{ id: 1, handler: "vide", timescale: 1000 }],
  parts = [0, 1000, 2000],
  tfdtVersion = 0,
  extraAudio = false,
} = {}) {
  const chunks = [ftyp(), box("moov", ...tracks.map((t) => trak(t.id, t.handler, t.timescale)))];
  const video = tracks.find((t) => t.handler === "vide") || tracks[0];
  const audio = tracks.find((t) => t.handler === "soun");
  for (const tick of parts) {
    const trafs = [traf(video.id, tick, tfdtVersion)];
    if (extraAudio && audio) {
      const aTick = Math.round(tick * audio.timescale / video.timescale);
      trafs.push(traf(audio.id, aTick, tfdtVersion));
    }
    chunks.push(box("moof", ...trafs), mdat(16));
  }
  return Buffer.concat(chunks);
}

function writeTmp(t, name, buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-idx-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf);
  return { dir, file };
}

test("indexes a single-track fMP4: init, times, contiguous moof+mdat", (t) => {
  const buf = buildFmp4();
  const { file } = writeTmp(t, "seg.mp4", buf);
  const idx = indexFile(file);

  assert.equal(idx.version, 1);
  assert.equal(idx.timescale, 1000);
  assert.equal(idx.fragments.length, 3);
  assert.deepEqual(idx.fragments.map((f) => f.t), [0, 1, 2]);
  assert.equal(idx.duration, 3);
  assert.ok(idx.init.size > 0);
  assert.equal(idx.init.offset, 0);

  const ftypSize = buf.readUInt32BE(0);
  assert.equal(buf.toString("latin1", 4, 8), "ftyp");
  const moovSize = buf.readUInt32BE(ftypSize);
  assert.equal(buf.toString("latin1", ftypSize + 4, ftypSize + 8), "moov");
  assert.equal(idx.init.size, ftypSize + moovSize);

  let cursor = idx.init.size;
  for (const f of idx.fragments) {
    assert.equal(f.offset, cursor);
    assert.equal(buf.toString("latin1", f.offset + 4, f.offset + 8), "moof");
    const moofSize = buf.readUInt32BE(f.offset);
    assert.equal(buf.toString("latin1", f.offset + moofSize + 4, f.offset + moofSize + 8), "mdat");
    assert.equal(f.offset + f.size, f.offset + moofSize + buf.readUInt32BE(f.offset + moofSize));
    cursor = f.offset + f.size;
  }
  assert.equal(cursor, buf.length);
  assert.equal(idx.size, buf.length);
});

test("uses the video track timescale when audio is muxed in the same moof", (t) => {
  const buf = buildFmp4({
    tracks: [
      { id: 1, handler: "vide", timescale: 90000 },
      { id: 2, handler: "soun", timescale: 48000 },
    ],
    parts: [0, 90000, 180000],
    extraAudio: true,
  });
  const { file } = writeTmp(t, "av.mp4", buf);
  const idx = indexFile(file);
  assert.equal(idx.timescale, 90000);
  assert.deepEqual(idx.fragments.map((f) => f.t), [0, 1, 2]);
  assert.equal(idx.tracks.length, 2);
});

test("reads 64-bit tfdt and ignores a truncated last mdat", (t) => {
  const full = buildFmp4({ parts: [0, 1000], tfdtVersion: 1 });
  const { file } = writeTmp(t, "trunc.mp4", full.subarray(0, full.length - 4));
  const idx = indexFile(file);
  assert.equal(idx.fragments.length, 1, "incomplete last fragment must be dropped");
  assert.equal(idx.fragments[0].t, 0);
});

test("fragmentAt binary-searches the last row at or before t", (t) => {
  const { file } = writeTmp(t, "seek.mp4", buildFmp4({ parts: [0, 1000, 2000, 3000] }));
  const idx = indexFile(file);
  assert.equal(fragmentAt(idx, -1).t, 0);
  assert.equal(fragmentAt(idx, 0).t, 0);
  assert.equal(fragmentAt(idx, 1.5).t, 1);
  assert.equal(fragmentAt(idx, 3).t, 3);
  assert.equal(fragmentAt(idx, 99).t, 3);
});

test("sidecar write + isFresh, and a size change invalidates", (t) => {
  const { file } = writeTmp(t, "fresh.mp4", buildFmp4());
  const idx = indexFile(file);
  const dest = writeIndex(idx);
  assert.equal(dest, sidecarPath(file));
  assert.equal(isFresh(readIndex(file), file), true);
  fs.appendFileSync(file, Buffer.from("xxxx"));
  assert.equal(isFresh(readIndex(file), file), false);
});

test("indexes a directory of MediaMTX-named segments", (t) => {
  const a = buildFmp4({ parts: [0, 1000] });
  const b = buildFmp4({ parts: [0] });
  const { dir } = writeTmp(t, "2026-09-08_12-44-42-636196.mp4", a);
  fs.writeFileSync(path.join(dir, "2026-09-08_13-44-42-000000.mp4"), b);
  fs.writeFileSync(path.join(dir, "notes.txt"), "ignore");
  const cat = indexDir(dir);
  assert.equal(cat.segments.length, 2);
  assert.equal(cat.segments[0].fragments.length, 2);
  assert.equal(cat.segments[1].fragments.length, 1);
  assert.equal(cat.segments[0].nameOrigin, "2026-09-08T12:44:42.636");
  assert.ok(fs.existsSync(sidecarPath(cat.segments[0].file)));
  assert.ok(fs.existsSync(sidecarPath(cat.segments[1].file)));
});

test("parseMtxName reads the MediaMTX segment filename", () => {
  assert.equal(parseMtxName("2026-09-08_12-44-42-636196.mp4"), "2026-09-08T12:44:42.636");
  assert.equal(parseMtxName("clip.mp4"), null);
});

test("CLI writes a sidecar and prints a human summary", (t) => {
  const { file } = writeTmp(t, "cli.mp4", buildFmp4());
  const r = spawnSync(process.execPath, [path.join(ROOT, "live-index.js"), file], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fragments 3/);
  assert.match(r.stdout, /timescale 1000/);
  assert.match(summarize(readIndex(file)), /t 0 → 2/);
  assert.ok(fs.existsSync(sidecarPath(file)));
});

test("indexPath --no-write does not create a sidecar", (t) => {
  const { file } = writeTmp(t, "nowrite.mp4", buildFmp4());
  indexPath(file, { noWrite: true });
  assert.equal(fs.existsSync(sidecarPath(file)), false);
});
