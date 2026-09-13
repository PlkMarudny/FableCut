/* Generate the playground's footage from scratch with ffmpeg.
   Run:  node docs/demo/make-media.js
   Nothing here comes from anyone's camera roll or a stock library: three
   animated gradient plates in the product's own palette, plus a soft chord
   pad. Small, licence-free, and safe to ship in a public repo. */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "media");
fs.mkdirSync(OUT, { recursive: true });

const W = 1080, H = 1920, DUR = 6;

/* an animated two-stop gradient, slowly drifting, with a touch of grain so it
   reads as footage rather than a flat fill */
function plate(name, c0, c1, speed, rot) {
  const vf = [
    `gradients=s=${W}x${H}:c0=${c0}:c1=${c1}:x0=${Math.round(W * 0.2)}:y0=${Math.round(H * 0.15)}` +
      `:x1=${Math.round(W * 0.85)}:y1=${Math.round(H * 0.9)}:speed=${speed}:nb_colors=2:d=${DUR}:r=30`,
  ];
  const filters = [
    `rotate=${rot}*PI/180:c=none:ow=${W}:oh=${H}`,
    "noise=alls=9:allf=t+u",
    "gblur=sigma=6",
    "format=yuv420p",
  ].join(",");
  run([
    "-y", "-f", "lavfi", "-i", vf[0],
    "-vf", filters,
    "-t", String(DUR), "-r", "30",
    "-c:v", "libx264", "-preset", "slow", "-crf", "30",
    "-movflags", "+faststart",
    path.join(OUT, name),
  ]);
}

/* a quiet three-note pad with a slow tremolo - enough to show a waveform and
   an audio track doing something, without being annoying on a landing page */
function pad(name, seconds) {
  const expr =
    "0.16*sin(2*PI*196*t) + 0.12*sin(2*PI*294*t) + 0.09*sin(2*PI*392*t)";
  run([
    "-y", "-f", "lavfi", "-i", `aevalsrc=${expr}:s=44100:d=${seconds}`,
    "-af", "tremolo=f=0.5:d=0.35,afade=t=in:d=0.8,afade=t=out:st=" + (seconds - 1.2) + ":d=1.2,volume=0.8",
    "-c:a", "libmp3lame", "-b:a", "96k",
    path.join(OUT, name),
  ]);
}

function run(args) {
  execFileSync("ffmpeg", ["-v", "error", ...args], { stdio: ["ignore", "inherit", "inherit"] });
  console.log("  wrote", path.basename(args[args.length - 1]));
}

try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  console.error("ffmpeg is not on PATH - the playground media can't be generated here.");
  process.exit(1);
}

console.log("generating playground footage…");
plate("plate-violet.mp4", "0x7b6cff", "0x1b1440", 0.05, 0);
plate("plate-amber.mp4", "0xffd24a", "0x5a2a00", 0.07, 0);
plate("plate-teal.mp4", "0x1fd4c3", "0x06202b", 0.06, 0);
pad("pad.mp3", 14);

let total = 0;
for (const f of fs.readdirSync(OUT)) total += fs.statSync(path.join(OUT, f)).size;
console.log("done:", (total / 1048576).toFixed(2), "MB in docs/demo/media");
