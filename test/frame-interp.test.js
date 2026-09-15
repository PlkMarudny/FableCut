/* Optical-flow in-between pair math, sliced from app.js. */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const { ROOT } = require("./helpers");

const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

function slice(startMarker, endMarker) {
  const a = SRC.indexOf(startMarker);
  const b = SRC.indexOf(endMarker, a);
  assert.ok(a >= 0, `start marker not found: ${startMarker}`);
  assert.ok(b > a, `end marker not found after it: ${endMarker}`);
  return SRC.slice(a, b);
}

const LOGIC = slice("function frameInterpMode(", "function interpSrcDt(");
const DEFAULT_PROPS = new Function(`return (${
  /const DEFAULT_PROPS = (\{[\s\S]*?\n\});/.exec(SRC)[1]
});`)();

const { frameInterpMode, wantsFrameInterp, sourceFrameStep, sourcePairAt, interpPairFromPresented } =
  new Function("clamp", `${LOGIC}\nreturn {
    frameInterpMode, wantsFrameInterp, sourceFrameStep, sourcePairAt, interpPairFromPresented
  };`)((v, a, b) => Math.min(b, Math.max(a, v)));

test("frameInterp defaults to optical and is not animatable", () => {
  assert.equal(DEFAULT_PROPS.frameInterp, "optical");
  assert.equal(frameInterpMode({}), "optical");
  assert.equal(frameInterpMode({ frameInterp: "off" }), "off");
  assert.equal(frameInterpMode({ frameInterp: "optical" }), "optical");
  assert.match(SRC, /const ANIMATABLE = \[[^\]]*\]/);
  assert.doesNotMatch(
    SRC.slice(SRC.indexOf("const ANIMATABLE"), SRC.indexOf("];", SRC.indexOf("const ANIMATABLE")) + 2),
    /frameInterp/,
  );
});

test("wantsFrameInterp only on slowed video with optical mode", () => {
  assert.equal(wantsFrameInterp("video", 0.5, "optical"), true);
  assert.equal(wantsFrameInterp("video", 1, "optical"), false);
  assert.equal(wantsFrameInterp("video", 2, "optical"), false);
  assert.equal(wantsFrameInterp("video", 0.5, "off"), false);
  assert.equal(wantsFrameInterp("audio", 0.5, "optical"), false);
  assert.equal(wantsFrameInterp("image", 0.5, "optical"), false);
});

test("sourceFrameStep rejects nonsense and falls back to 1/30", () => {
  assert.equal(sourceFrameStep(1 / 24), 1 / 24);
  assert.equal(sourceFrameStep(1 / 30), 1 / 30);
  assert.equal(sourceFrameStep(0), 1 / 30);
  assert.equal(sourceFrameStep(NaN), 1 / 30);
  assert.equal(sourceFrameStep(1), 1 / 30);
});

test("sourcePairAt is a monotonic grid on media time", () => {
  const dt = 1 / 30;
  const a = sourcePairAt(0.01, dt);
  assert.equal(a.t0, 0);
  assert.ok(Math.abs(a.t1 - dt) < 1e-9);
  assert.ok(a.alpha > 0.29 && a.alpha < 0.31);
  const b = sourcePairAt(dt, dt);
  assert.ok(Math.abs(b.t0 - dt) < 1e-9);
  assert.equal(b.alpha, 0);
  const c = sourcePairAt(dt * 2.5, dt);
  assert.ok(c.t0 > a.t0);
  assert.ok(c.t1 > a.t1);
});

test("interpPairFromPresented: lookahead window after the presented frame", () => {
  const p = interpPairFromPresented(0.01, 0, 1 / 30);
  assert.equal(p.ahead, true);
  assert.equal(p.t0, 0);
  assert.ok(Math.abs(p.t1 - 1 / 30) < 1e-9);
  assert.ok(p.alpha > 0.29 && p.alpha < 0.31);
  assert.ok(!p.stale);
});

test("interpPairFromPresented: look-behind when media time is before presented", () => {
  const dt = 1 / 30;
  const p = interpPairFromPresented(0.02, 0.04, dt);
  assert.equal(p.ahead, false);
  assert.ok(Math.abs(p.t0 - (0.04 - dt)) < 1e-9);
  assert.equal(p.t1, 0.04);
  assert.ok(p.alpha > 0 && p.alpha < 1);
});

test("interpPairFromPresented: stale when the clock ran past the open pair", () => {
  const p = interpPairFromPresented(0.2, 0, 1 / 30);
  assert.equal(p.stale, true);
  assert.equal(p.alpha, 1);
});

test("drawClip interpolates before the 2D compositor", () => {
  const draw = SRC.slice(SRC.indexOf("function drawClip("), SRC.indexOf("function detectTextDirection("));
  assert.match(draw, /maybeInterpVideo/);
  assert.match(SRC, /mciRun\(/);
  assert.match(SRC, /mciBlit2d\(/);
  assert.match(SRC, /readPixels/);
  assert.match(SRC, /webgl2/);
  assert.match(SRC, /prepareInterpFrames/);
  assert.match(SRC, /mciCrossfade/);
  assert.match(SRC, /mix\(aWarp, aHold/);
  assert.match(SRC, /mciEnsureOut2d/);
  assert.match(SRC, /mciPresentFull/);
});
