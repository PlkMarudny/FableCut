"use strict";
const fs = require("fs");
const path = require("path");

const PROFILES_FILE = path.join(__dirname, "encoding-profiles.json");

const VIDEO_CODECS = new Set(["libx264", "libx265"]);
const VIDEO_PRESETS = new Set([
  "ultrafast", "superfast", "veryfast", "faster", "fast",
  "medium", "slow", "slower", "veryslow",
]);
const PIX_FMTS = new Set(["yuv420p", "yuv422p", "yuv444p"]);
const AUDIO_CODECS = new Set(["aac", "libopus"]);
const X264_TUNES = new Set(["film", "animation", "grain", "stillimage", "fastdecode", "zerolatency"]);
const X264_PROFILES = new Set(["baseline", "main", "high", "high10", "high422", "high444"]);
const BITRATE_RE = /^\d+([kKmM])?$/;
const ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;
const LOGLEVELS = new Set(["quiet", "panic", "fatal", "error", "warning", "info", "verbose", "debug", "trace"]);
/* "mkv" is an extension, not an ffmpeg muxer name — normalized to "matroska" */
const MUX_FORMAT_ALIAS = { mp4: "mp4", mov: "mov", matroska: "matroska", mkv: "matroska" };
const FORMAT_EXT = { mp4: ".mp4", mov: ".mov", matroska: ".mkv" };
const EXT_FORMAT = { ".mp4": "mp4", ".m4v": "mp4", ".mov": "mov", ".mkv": "matroska" };
const OUT_EXT = new Set([".mp4", ".mov", ".mkv", ".m4v"]);
const SAFE_FFMPEG_STR = /^[\w=.,:/+\-[\]()%| ]{0,512}$/;
/* ffmpeg levels that suppress error text; the frame-pipe pass keeps stderr for
   diagnostics only (never shown unless the encode fails), so it is clamped up */
const QUIET_LEVELS = new Set(["quiet", "panic", "fatal"]);

const BUILTIN = {
  default: "delivery",
  profiles: {
    draft: {
      label: "Draft · H.264 fast",
      description: "Quick preview — smaller file, faster encode.",
      jpegQuality: 0.85,
      video: { codec: "libx264", preset: "veryfast", crf: 23, pixFmt: "yuv420p" },
      audio: { codec: "aac", bitrate: "128k" },
      mux: { movflags: "+faststart" },
    },
    delivery: {
      label: "Delivery · H.264 balanced",
      description: "Default export — good quality and compatibility.",
      jpegQuality: 0.95,
      video: { codec: "libx264", preset: "fast", crf: 18, pixFmt: "yuv420p" },
      audio: { codec: "aac", bitrate: "192k" },
      mux: { movflags: "+faststart" },
    },
    hq: {
      label: "High quality · H.264 slow",
      description: "Best H.264 quality — slower encode, larger file.",
      jpegQuality: 0.98,
      video: { codec: "libx264", preset: "slow", crf: 16, pixFmt: "yuv420p" },
      audio: { codec: "aac", bitrate: "256k" },
      mux: { movflags: "+faststart" },
    },
  },
};

let cache = null;
let cacheMtime = -1;

function clampNum(v, fallback, min, max) {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* like clampNum, but reports a silent clamp — an out-of-range value that gets
   quietly corrected is how you end up exporting 8 kHz audio and not knowing */
function clampReported(v, fallback, min, max, label, warn) {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  const c = Math.min(max, Math.max(min, n));
  if (c !== n) warn(`${label} ${n} out of range — clamped to ${c}`);
  return c;
}

function validateVideo(v, fallback, warn) {
  const out = { ...fallback, ...(v || {}) };
  const drop = (key, why) => { delete out[key]; warn(`video.${key} ignored — ${why}`); };
  if (!VIDEO_CODECS.has(out.codec)) {
    warn(`video.codec "${out.codec}" not allowed — using ${fallback.codec}`);
    out.codec = fallback.codec;
  }
  if (!VIDEO_PRESETS.has(out.preset)) {
    warn(`video.preset "${out.preset}" not allowed — using ${fallback.preset}`);
    out.preset = fallback.preset;
  }
  out.crf = Math.round(clampReported(out.crf, fallback.crf, 0, 51, "video.crf", warn));
  if (!PIX_FMTS.has(out.pixFmt)) {
    warn(`video.pixFmt "${out.pixFmt}" not allowed — using ${fallback.pixFmt}`);
    out.pixFmt = fallback.pixFmt;
  }
  if (out.tune && !X264_TUNES.has(out.tune)) drop("tune", "unknown tune");
  if (out.profile && !X264_PROFILES.has(out.profile)) drop("profile", "unknown H.264 profile");
  if (out.g != null) {
    const g = Math.round(clampNum(out.g, 0, 1, 600));
    if (g > 0) out.g = g; else drop("g", "must be 1–600");
  }
  if (out.maxrate && !BITRATE_RE.test(String(out.maxrate))) drop("maxrate", 'expected e.g. "60M"');
  if (out.bufsize && !BITRATE_RE.test(String(out.bufsize))) drop("bufsize", 'expected e.g. "70M"');
  for (const key of ["x264opts", "vf"]) {
    if (!out[key]) { delete out[key]; continue; }
    const s = String(out[key]).trim();
    if (s && SAFE_FFMPEG_STR.test(s)) out[key] = s;
    else drop(key, "contains characters outside the allowed ffmpeg option set");
  }
  if (out.x264opts && out.codec !== "libx264")
    drop("x264opts", `only applies to libx264, not ${out.codec} (which takes -x265-params)`);
  return out;
}

function validateAudio(a, fallback, warn) {
  const out = { ...fallback, ...(a || {}) };
  if (!AUDIO_CODECS.has(out.codec)) {
    warn(`audio.codec "${out.codec}" not allowed — using ${fallback.codec}`);
    out.codec = fallback.codec;
  }
  if (!BITRATE_RE.test(String(out.bitrate || ""))) {
    warn(`audio.bitrate "${out.bitrate}" invalid — using ${fallback.bitrate}`);
    out.bitrate = fallback.bitrate;
  }
  if (out.sampleRate != null) {
    const sr = Math.round(clampReported(out.sampleRate, 0, 8000, 192000, "audio.sampleRate", warn));
    if (sr > 0) out.sampleRate = sr;
    else { delete out.sampleRate; warn("audio.sampleRate ignored — must be 8000–192000"); }
  }
  if (out.strict != null) {
    const st = String(out.strict);
    if (["-2", "-1", "0", "1", "experimental"].includes(st)) out.strict = st;
    else { delete out.strict; warn(`audio.strict "${st}" ignored`); }
  }
  return out;
}

function validateMux(m, fallback, warn) {
  const given = m && typeof m === "object" ? m : {};
  const out = { ...fallback, ...given };
  // an explicit null/"" clears an inherited value (e.g. drop +faststart)
  if ("movflags" in given && (given.movflags === null || given.movflags === "")) delete out.movflags;
  else if (out.movflags != null && typeof out.movflags !== "string") out.movflags = fallback.movflags;
  if (out.format) {
    const fmt = MUX_FORMAT_ALIAS[String(out.format).toLowerCase()];
    if (fmt) out.format = fmt;
    // what replaces it is resolved below (from the extension, else mp4)
    else { delete out.format; warn(`mux.format "${given.format}" unknown — ignored (allowed: mp4, mov, matroska)`); }
  }
  if (out.extension) {
    const raw = String(out.extension).toLowerCase();
    const ext = raw.startsWith(".") ? raw : `.${raw}`;
    if (OUT_EXT.has(ext)) out.extension = ext;
    else { delete out.extension; warn(`mux.extension "${given.extension}" unsupported`); }
  }
  // a bare extension implies the container; keeps -f and the filename in step
  if (!out.format && out.extension) out.format = EXT_FORMAT[out.extension];
  /* A mismatch is reconciled, not just flagged, so exportContainer() and
     exportOutputExtension() can never disagree. `format` selects the muxer and
     therefore the bytes written, so it wins and the file is renamed to match —
     the alternative would quietly write a different container than requested. */
  if (out.format && out.extension && EXT_FORMAT[out.extension] !== out.format) {
    const corrected = FORMAT_EXT[out.format];
    warn(`mux.extension ${out.extension} does not match mux.format ${out.format} — using ${corrected}`);
    out.extension = corrected;
  }
  return out;
}

function validateEncode(e, fallback, warn) {
  const out = { ...fallback, ...(e || {}) };
  if (out.loglevel && !LOGLEVELS.has(String(out.loglevel))) {
    warn(`encode.loglevel "${out.loglevel}" unknown — ignored`);
    delete out.loglevel;
  }
  if (out.hideBanner != null) out.hideBanner = !!out.hideBanner;
  if (out.stats != null) out.stats = !!out.stats;
  return out;
}

function normalizeProfile(id, raw, fallback) {
  const base = fallback || BUILTIN.profiles.delivery;
  const p = raw && typeof raw === "object" ? raw : {};
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  const mux = validateMux(p.mux, base.mux, warn);
  const audio = validateAudio(p.audio, base.audio, warn);
  const container = exportContainer({ mux });
  /* Opus has no MOV mapping at all, and MP4 needs the experimental flag —
     without this the mux pass dies only after every frame has been rendered. */
  if (audio.codec === "libopus") {
    if (container === "mov") {
      warn("audio.codec libopus cannot be stored in MOV — using aac");
      audio.codec = "aac";
    } else if (container === "mp4" && audio.strict == null) {
      audio.strict = "-2";
    }
  }
  return {
    id,
    label: String(p.label || base.label || id),
    description: String(p.description || p.desc || base.description || ""),
    jpegQuality: clampReported(p.jpegQuality, base.jpegQuality, 0.5, 1, "jpegQuality", warn),
    video: validateVideo(p.video, base.video, warn),
    audio,
    mux,
    encode: validateEncode(p.encode, base.encode || {}, warn),
    warnings,
  };
}

function profilesFileMtime() {
  try { return fs.statSync(PROFILES_FILE).mtimeMs; } catch { return 0; }
}

function loadEncodeProfiles(force) {
  /* mtime check instead of a plain memo: the MCP server is long-lived and has
     no file watcher, so a cache-only read would serve stale profiles forever */
  const mtime = profilesFileMtime();
  if (cache && !force && mtime === cacheMtime) return cache;

  let file = null;
  let fileError = null;
  try {
    if (fs.existsSync(PROFILES_FILE)) {
      file = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8").replace(/^\uFEFF/, ""));
    }
  } catch (e) { fileError = `encoding-profiles.json could not be parsed (${e.message}) — using built-in profiles`; }

  const profiles = {};
  for (const [id, raw] of Object.entries(BUILTIN.profiles)) {
    profiles[id] = normalizeProfile(id, raw, raw);
  }
  const issues = fileError ? [fileError] : [];
  if (file?.profiles && typeof file.profiles === "object") {
    for (const [id, raw] of Object.entries(file.profiles)) {
      if (!ID_RE.test(id)) {
        issues.push(`profile id "${id}" skipped — must start with a letter and use [A-Za-z0-9_-] only`);
        continue;
      }
      profiles[id] = normalizeProfile(id, raw, profiles[id] || BUILTIN.profiles.delivery);
    }
  }
  for (const p of Object.values(profiles))
    for (const w of p.warnings) issues.push(`${p.id}: ${w}`);

  let defaultId = typeof file?.default === "string" ? file.default : BUILTIN.default;
  if (!profiles[defaultId]) {
    if (file?.default) issues.push(`default "${file.default}" is not a defined profile — using delivery`);
    defaultId = "delivery";
  }

  cache = { default: defaultId, profiles, issues };
  cacheMtime = mtime;
  return cache;
}

function invalidateEncodeProfiles() {
  cache = null;
  cacheMtime = -1;
}

function resolveProfile(id) {
  const cfg = loadEncodeProfiles();
  const pid = id || cfg.default;
  const p = cfg.profiles[pid];
  if (!p) throw new Error(`Unknown encoding profile "${pid}"`);
  return p;
}

function profileSummary(p) {
  const v = p.video;
  const a = p.audio;
  const bits = [`${v.codec} preset=${v.preset} crf=${v.crf}`];
  if (v.g) bits.push(`g=${v.g}`);
  if (v.vf) bits.push("vf");
  if (v.x264opts) bits.push("x264opts");
  bits.push(`${a.codec} ${a.bitrate}`);
  if (a.sampleRate) bits.push(`${a.sampleRate / 1000}kHz`);
  if (p.mux?.format) bits.push(p.mux.format);
  bits.push(`JPEG ${Math.round(p.jpegQuality * 100)}%`);
  return bits.join(" · ");
}

function ffmpegGlobalArgs(profile) {
  const enc = profile.encode || {};
  const args = [];
  if (enc.hideBanner) args.push("-hide_banner");
  if (enc.stats) args.push("-stats");
  if (enc.loglevel) {
    /* stderr is captured for failure reporting and never shown otherwise, so a
       silencing loglevel would only cost us the reason an export died */
    args.push("-loglevel", QUIET_LEVELS.has(enc.loglevel) ? "error" : enc.loglevel);
  }
  return args;
}

function exportContainer(profile) {
  return profile.mux?.format || EXT_FORMAT[profile.mux?.extension] || "mp4";
}

function exportOutputExtension(profile) {
  if (profile.mux?.extension) return profile.mux.extension;
  return FORMAT_EXT[exportContainer(profile)] || ".mp4";
}

function listProfilesPublic(detail) {
  const cfg = loadEncodeProfiles();
  const out = {
    default: cfg.default, profiles: {},
    file: path.basename(PROFILES_FILE),
    issues: cfg.issues || [],
  };
  for (const [id, p] of Object.entries(cfg.profiles)) {
    // jpegQuality is needed by the browser to encode frames — always included
    const base = {
      label: p.label,
      description: p.description,
      jpegQuality: p.jpegQuality,
      extension: exportOutputExtension(p),
      summary: profileSummary(p),
    };
    out.profiles[id] = detail
      ? { ...base, video: p.video, audio: p.audio, mux: p.mux, encode: p.encode, warnings: p.warnings }
      : base;
  }
  return out;
}

function buildVideoEncodeArgs(profile, fps, outputPath) {
  const v = profile.video;
  const args = [...ffmpegGlobalArgs(profile),
    "-y", "-f", "image2pipe", "-framerate", String(fps), "-i", "-",
    "-c:v", v.codec,
  ];
  if (v.codec === "libx264" || v.codec === "libx265") {
    args.push("-preset", v.preset, "-crf", String(v.crf));
    if (v.g) args.push("-g", String(v.g));
    if (v.maxrate) args.push("-maxrate", v.maxrate);
    if (v.bufsize) args.push("-bufsize", v.bufsize);
    // libx264-only private option (libx265 takes -x265-params instead)
    if (v.x264opts && v.codec === "libx264") args.push("-x264opts", v.x264opts);
    if (v.tune) args.push("-tune", v.tune);
    if (v.profile) args.push("-profile:v", v.profile);
  }
  /* JPEG frames from the browser are full-range BT.601 (JFIF). Convert them to
     limited-range BT.709 and tag the stream, otherwise x264 emits bt470bg/pc/
     unknown and players do the wrong YUV→RGB conversion — darker than preview.
     Profile `vf` (if any) is appended so color conversion always runs first. */
  const colorVf = "scale=in_range=full:in_color_matrix=bt601:out_range=tv:out_color_matrix=bt709";
  args.push("-vf", v.vf ? `${colorVf},${v.vf}` : colorVf);
  args.push("-pix_fmt", v.pixFmt,
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    outputPath);
  return args;
}

function buildMuxArgs(profile, videoPath, wavPath, outPath) {
  const a = profile.audio;
  const container = exportContainer(profile);
  const args = [...ffmpegGlobalArgs(profile), "-y", "-i", videoPath];
  if (wavPath) args.push("-i", wavPath);
  args.push("-c:v", "copy");
  if (wavPath) {
    args.push("-c:a", a.codec);
    args.push("-b:a", a.bitrate);
    if (a.sampleRate) args.push("-ar", String(a.sampleRate));
    if (a.strict != null) args.push("-strict", String(a.strict));
    args.push("-shortest");
  }
  // Re-assert the bt709 tags on the mux — a stream-copy pass can drop the
  // container-level colr atom even though the SPS still carries them.
  args.push("-colorspace", "bt709", "-color_primaries", "bt709",
    "-color_trc", "bt709", "-color_range", "tv");
  // -movflags is an MP4/MOV muxer option; Matroska warns and ignores it
  if (profile.mux?.movflags && container !== "matroska")
    args.push("-movflags", profile.mux.movflags);
  args.push("-f", container, outPath);
  return args;
}

module.exports = {
  PROFILES_FILE,
  loadEncodeProfiles,
  invalidateEncodeProfiles,
  resolveProfile,
  listProfilesPublic,
  profileSummary,
  buildVideoEncodeArgs,
  buildMuxArgs,
  exportContainer,
  exportOutputExtension,
};
