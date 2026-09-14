/* Export video-sync — sliced from app.js so tests exercise production logic,
   not a reimplemented predicate. */
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

const WAIT_HELPERS = slice("function notePresented(", "function assignVideoTime(");
const PLAY = slice("function playAdvanceVideo(", "const EXPORT_PREFETCH_S");

function loadWait() {
  return new Function(`${WAIT_HELPERS}
    return { notePresented, presentedClose, waitForPresentedFrame };`)();
}

function loadPlay(hardSeekVideo = () => Promise.resolve()) {
  return new Function(
    "hardSeekVideo",
    `${WAIT_HELPERS}
     ${PLAY}
     return { notePresented, presentedClose, playAdvanceVideo };`
  )(hardSeekVideo);
}

function mockVideo({
  currentTime = 0,
  paused = true,
  readyState = 2,
  rvfcMediaTime,
  rvfcDelayMs = 0,
  noRvfc = false,
  noRvfcFire = false,
} = {}) {
  const el = {
    currentTime,
    paused,
    readyState,
    muted: false,
    playbackRate: 1,
    _fcPresentedTime: null,
    _fcPrevMuted: null,
    pause() { el.paused = true; },
    play() { el.paused = false; return Promise.resolve(); },
    addEventListener() {},
    removeEventListener() {},
  };
  if (!noRvfc) {
    el.requestVideoFrameCallback = (cb) => {
      if (noRvfcFire) return;
      const fire = () => cb(0, { mediaTime: rvfcMediaTime ?? currentTime });
      if (rvfcDelayMs > 0) setTimeout(fire, rvfcDelayMs);
      else queueMicrotask(fire);
    };
    el.cancelVideoFrameCallback = () => {};
  }
  return el;
}

const { waitForPresentedFrame } = loadWait();

test("waitForPresentedFrame: timeout rejects without recording currentTime", async () => {
  const el = mockVideo({ noRvfcFire: true });
  await assert.rejects(() => waitForPresentedFrame(el, 15), /presented frame timeout/);
  assert.equal(el._fcPresentedTime, null);
});

test("waitForPresentedFrame: rvfc without mediaTime times out instead of using currentTime", async () => {
  const el = mockVideo();
  el.requestVideoFrameCallback = (cb) => { cb(0, {}); };
  await assert.rejects(() => waitForPresentedFrame(el, 50), /presented frame timeout/);
  assert.equal(el._fcPresentedTime, null);
});

test("waitForPresentedFrame: records finite mediaTime from rvfc", async () => {
  const el = mockVideo({ rvfcMediaTime: 0.04 });
  await waitForPresentedFrame(el, 80);
  assert.equal(el._fcPresentedTime, 0.04);
});

test("playAdvanceVideo: no hard-seek when presented reached target but clock ran ahead", async () => {
  let hardSeeks = 0;
  const play = loadPlay(() => { hardSeeks++; return Promise.resolve(); }).playAdvanceVideo;
  const el = mockVideo({ currentTime: 0.055, rvfcMediaTime: 0.039 });
  await play(el, 0.04, 0.01, 1, { keepPlaying: false });
  assert.equal(hardSeeks, 0);
  assert.equal(el._fcPresentedTime, 0.039);
});

test("playAdvanceVideo: hard-seeks when picture never reaches target", async () => {
  let hardSeeks = 0;
  const play = loadPlay(() => { hardSeeks++; return Promise.resolve(); }).playAdvanceVideo;
  const el = mockVideo({ currentTime: 0.07, noRvfcFire: true });
  await play(el, 0.04, 0.01, 1, { keepPlaying: false });
  assert.equal(hardSeeks, 1);
}, { timeout: 1000 });

test("playAdvanceVideo: tolerates small clock drift when picture is on target", async () => {
  let hardSeeks = 0;
  const play = loadPlay(() => { hardSeeks++; return Promise.resolve(); }).playAdvanceVideo;
  const el = mockVideo({ currentTime: 0.025, rvfcMediaTime: 0.02 });
  await play(el, 0.02, 0.01, 1, { keepPlaying: false });
  assert.equal(hardSeeks, 0);
});

test("playAdvanceVideo: hard-seeks when presented picture overshoots target", async () => {
  let hardSeeks = 0;
  const play = loadPlay(() => { hardSeeks++; return Promise.resolve(); }).playAdvanceVideo;
  const el = mockVideo({ currentTime: 0.06, rvfcMediaTime: 0.041 });
  await play(el, 0.04, 0.01, 1, { keepPlaying: false });
  assert.equal(hardSeeks, 1);
});
