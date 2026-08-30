/* ═══════════════════════════════════════════════════════════════════════════
   Encoding profiles — user-editable ffmpeg settings for Fast export.

   A profile is a raw ffmpeg argument list plus the two things that are NOT
   ffmpeg arguments: the browser's JPEG frame quality and the output extension.
   There is deliberately no allow-list — encoding-profiles.json is a local file
   the user owns, the browser only ever sends a profile *id*, and args are
   passed to spawn() as an array (no shell), so validating codec names would buy
   nothing but a smaller set of usable formats. Typos are caught by dryRunProfile
   against the real ffmpeg build instead, which also knows which encoders it has.

   Export is ONE ffmpeg pass; this module owns the input side and the output
   path, the profile owns everything in between:

     ffmpeg -y -f image2pipe -framerate <fps> -i - [-i audio.wav]
            <profile args…> <out><extension>
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PROFILES_FILE = path.join(__dirname, "encoding-profiles.json");

/* Used when encoding-profiles.json is missing or unparseable, so export still
   works out of the box. Not a merge base: profiles are taken as written. */
const BUILTIN_ID = "delivery";
const BUILTIN = {
  label: "Delivery · H.264 balanced",
  description: "Built-in fallback — good quality and compatibility.",
  jpegQuality: 0.95,
  extension: ".mp4",
  args: ["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest"],
};

let cache = null;
let cacheMtime = -1;

function normalizeProfile(id, raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  // a string is split on whitespace as a convenience; the array form is
  // canonical because it needs no quoting (e.g. -vf drawtext=text='hi')
  const args = Array.isArray(p.args)
    ? p.args.map(String)
    : String(p.args || "").split(/\s+/).filter(Boolean);
  const ext = String(p.extension || BUILTIN.extension).trim().toLowerCase();
  const q = Number(p.jpegQuality);
  return {
    id,
    label: String(p.label || id),
    description: String(p.description || p.desc || ""),
    jpegQuality: q >= 0.1 && q <= 1 ? q : BUILTIN.jpegQuality,
    extension: ext.startsWith(".") ? ext : `.${ext}`,
    args,
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
  const issues = [];
  try {
    if (fs.existsSync(PROFILES_FILE))
      file = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8").replace(/^\uFEFF/, ""));
    else issues.push(`${path.basename(PROFILES_FILE)} not found — using the built-in profile`);
  } catch (e) {
    issues.push(`${path.basename(PROFILES_FILE)} could not be parsed (${e.message}) — using the built-in profile`);
  }

  const profiles = {};
  if (file?.profiles && typeof file.profiles === "object")
    for (const [id, raw] of Object.entries(file.profiles)) profiles[id] = normalizeProfile(id, raw);
  for (const [id, p] of Object.entries(profiles))
    if (!p.args.length) issues.push(`profile "${id}" has no args — ffmpeg will pick its own defaults`);
  if (!Object.keys(profiles).length) profiles[BUILTIN_ID] = normalizeProfile(BUILTIN_ID, BUILTIN);

  let defaultId = typeof file?.default === "string" ? file.default : BUILTIN_ID;
  if (!profiles[defaultId]) {
    const first = Object.keys(profiles)[0];
    if (file?.default) issues.push(`default "${file.default}" is not a defined profile — using ${first}`);
    defaultId = first;
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

function profileSummary(p, max = 120) {
  const s = (p.args || []).join(" ") || "(no args — ffmpeg defaults)";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
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
      extension: p.extension,
      summary: profileSummary(p),
    };
    out.profiles[id] = detail ? { ...base, args: p.args } : base;
  }
  return out;
}

/* JPEG frames from the browser are full-range BT.601 (JFIF). Convert them to
   limited-range BT.709 and tag the stream, otherwise x264 emits bt470bg/pc/
   unknown and players do the wrong YUV→RGB conversion — darker than preview.
   This is an input-side concern (the JPEG pipe), so it is prepended to the
   profile's own -vf rather than left for every profile to remember. */
const JPEG_COLOR_VF = "scale=in_range=full:in_color_matrix=bt601:out_range=tv:out_color_matrix=bt709";
const JPEG_COLOR_TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];

function withJpegColor(profileArgs) {
  const args = profileArgs.slice();
  const vfAt = args.indexOf("-vf");
  if (vfAt >= 0 && args[vfAt + 1] != null) args[vfAt + 1] = `${JPEG_COLOR_VF},${args[vfAt + 1]}`;
  else args.unshift("-vf", JPEG_COLOR_VF);
  if (!args.includes("-colorspace")) args.push(...JPEG_COLOR_TAGS);
  return args;
}

/* The single export pass. Frames arrive on stdin as a JPEG stream; the audio
   mix (when the timeline has any) is already on disk by the time we spawn. */
function buildExportArgs(profile, { fps, wavPath, outPath }) {
  // -hide_banner so a failure's stderr tail is the actual error, not the build config
  const args = ["-y", "-hide_banner", "-f", "image2pipe", "-framerate", String(fps), "-i", "-"];
  if (wavPath) args.push("-i", wavPath);
  args.push(...withJpegColor(profile.args), outPath);
  return args;
}

/* Run the profile's args once against a synthetic input before the browser
   renders anything. Without this a typo (or an encoder this ffmpeg build lacks)
   would only surface when ffmpeg exits — i.e. after every frame was rendered.
   Async spawn so /api/export/begin does not block the event loop. */
function dryRunProfile(profile, { fps = 30, hasAudio = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-dry-"));
  const out = path.join(dir, `probe${profile.extension}`);
  const args = ["-y", "-hide_banner", "-f", "lavfi",
    "-i", `color=c=black:s=64x64:r=${fps}:d=0.1`];
  if (hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  args.push("-t", "0.1", ...withJpegColor(profile.args), out);
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
      resolve(result);
    };
    let proc;
    try {
      proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      finish({ ok: false, error: e.message || String(e) });
      return;
    }
    proc.on("error", (e) => finish({ ok: false, error: e.message || String(e) }));
    proc.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
    proc.on("close", (code) => {
      if (code === 0) { finish({ ok: true }); return; }
      const lines = stderr.trim().split("\n").filter(Boolean);
      finish({ ok: false, error: lines.slice(-3).join(" · ") || `ffmpeg exited ${code}` });
    });
  });
}

module.exports = {
  PROFILES_FILE,
  loadEncodeProfiles,
  invalidateEncodeProfiles,
  resolveProfile,
  listProfilesPublic,
  profileSummary,
  buildExportArgs,
  dryRunProfile,
};
