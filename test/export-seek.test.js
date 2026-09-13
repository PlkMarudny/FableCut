/* Export video-sync helpers — play-ahead should not hard-seek when the
   presented picture already reached the target even if currentTime drifted. */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

function playAdvanceNeedsHardSeek(presented, mt, slop, currentTime, eps) {
  const pictureShort = presented == null || presented < mt - slop * 2;
  return pictureShort && Math.abs(currentTime - mt) > Math.max(eps * 2, 0.008);
}

test("play-ahead: no hard-seek when presented reached target but clock ran ahead", () => {
  const mt = 0.04, slop = 0.002, eps = 0.01;
  assert.equal(playAdvanceNeedsHardSeek(0.039, mt, slop, 0.055, eps), false);
  assert.equal(playAdvanceNeedsHardSeek(0.041, mt, slop, 0.06, eps), false);
});

test("play-ahead: hard-seek when picture is still short of target", () => {
  const mt = 0.04, slop = 0.002, eps = 0.01;
  assert.equal(playAdvanceNeedsHardSeek(0.028, mt, slop, 0.07, eps), true);
  assert.equal(playAdvanceNeedsHardSeek(null, mt, slop, 0.07, eps), true);
});

test("play-ahead: tolerate small clock drift when picture is on target", () => {
  const mt = 0.02, slop = 0.002, eps = 0.01;
  assert.equal(playAdvanceNeedsHardSeek(0.02, mt, slop, 0.025, eps), false);
});
