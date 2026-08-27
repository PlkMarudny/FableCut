/* FableCut per-track + stereo master meter worklet.
   Inputs 0…nAudio−1 = A-track buses; input nAudio = video/other spill on master.
   Pass-through sum → stereo out. Reports per A-track + post-sum master L/R. */
function shelfCoeffs(fs) {
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.5);
  const a0 = 1 + K / Q + K * K;
  return {
    b0: (Vh + Vb * K / Q + K * K) / a0,
    b1: 2 * (K * K - Vh) / a0,
    b2: (Vh - Vb * K / Q + K * K) / a0,
    a1: 2 * (K * K - 1) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}
function hpfCoeffs(fs) {
  const f0 = 38.13547087613982;
  const Q = 0.5003270373238773;
  const K = Math.tan(Math.PI * f0 / fs);
  const a0 = 1 + K / Q + K * K;
  return {
    b0: 1 / a0,
    b1: -2 / a0,
    b2: 1 / a0,
    a1: 2 * (K * K - 1) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}
function makeBiquad(c) {
  return { b0: c.b0, b1: c.b1, b2: c.b2, a1: c.a1, a2: c.a2, z1: 0, z2: 0 };
}
function biquadStep(f, x) {
  const y = f.b0 * x + f.z1;
  f.z1 = f.b1 * x - f.a1 * y + f.z2;
  f.z2 = f.b2 * x - f.a2 * y;
  return y;
}

class FableCutMeterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this._hopBlocks = Math.max(1, opts.hopBlocks || 8);
    this._nTracks = Math.max(1, opts.nTracks || 1);
    this._nAudio = Math.max(0, opts.nAudioTracks ?? opts.nTracks ?? 1);
    this._ids = opts.trackIds || [];
    this._block = 0;
    this._sumSq = new Float64Array(this._nTracks);
    this._peak = new Float64Array(this._nTracks);
    this._sumSqK = new Float64Array(this._nTracks);
    this._frames = 0;

    const shelf = shelfCoeffs(sampleRate);
    const hpf = hpfCoeffs(sampleRate);
    this._shelfL = [];
    this._hpfL = [];
    this._shelfR = [];
    this._hpfR = [];
    for (let t = 0; t < this._nTracks; t++) {
      this._shelfL.push(makeBiquad(shelf));
      this._hpfL.push(makeBiquad(hpf));
      this._shelfR.push(makeBiquad(shelf));
      this._hpfR.push(makeBiquad(hpf));
    }

    // Momentary = 400 ms of block mean-squares (BS.1770)
    const hopFrames = 128 * this._hopBlocks;
    this._lufsLen = Math.max(1, Math.round(0.4 * sampleRate / hopFrames));
    this._lufsRing = [];
    this._lufsIdx = [];
    this._lufsFilled = [];
    for (let t = 0; t < this._nTracks; t++) {
      this._lufsRing.push(new Float64Array(this._lufsLen));
      this._lufsIdx.push(0);
      this._lufsFilled.push(0);
    }

    // Stereo master (post-sum L/R + momentary stereo LUFS)
    this._mSumSqL = 0;
    this._mSumSqR = 0;
    this._mPeakL = 0;
    this._mPeakR = 0;
    this._mSumSqK = 0;
    this._mShelfL = makeBiquad(shelf);
    this._mHpfL = makeBiquad(hpf);
    this._mShelfR = makeBiquad(shelf);
    this._mHpfR = makeBiquad(hpf);
    this._mLufsRing = new Float64Array(this._lufsLen);
    this._mLufsIdx = 0;
    this._mLufsFilled = 0;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const outL = output && output[0];
    const outR = output && (output[1] || output[0]);
    if (outL) outL.fill(0);
    if (outR && outR !== outL) outR.fill(0);

    let frames = 0;
    for (let t = 0; t < this._nTracks; t++) {
      const chans = inputs[t];
      const has = chans && chans[0];
      const L = has ? chans[0] : null;
      const R = has ? (chans[1] || chans[0]) : null;
      const n = L ? L.length : (outL ? outL.length : 128);
      frames = n;

      let sum = this._sumSq[t];
      let peak = this._peak[t];
      let sumK = this._sumSqK[t];
      const sL = this._shelfL[t], hL = this._hpfL[t];
      const sR = this._shelfR[t], hR = this._hpfR[t];

      for (let i = 0; i < n; i++) {
        const l = L ? L[i] : 0;
        const r = R ? R[i] : 0;
        const mono = (l + r) * 0.5;
        sum += mono * mono;
        const aL = l >= 0 ? l : -l;
        const aR = r >= 0 ? r : -r;
        if (aL > peak) peak = aL;
        if (aR > peak) peak = aR;

        const fl = biquadStep(hL, biquadStep(sL, l));
        const fr = biquadStep(hR, biquadStep(sR, r));
        sumK += fl * fl + fr * fr;

        if (outL) outL[i] += l;
        if (outR && outR !== outL) outR[i] += r;
      }
      this._sumSq[t] = sum;
      this._peak[t] = peak;
      this._sumSqK[t] = sumK;
    }

    if (outL && frames) {
      let mSqL = this._mSumSqL;
      let mSqR = this._mSumSqR;
      let mPkL = this._mPeakL;
      let mPkR = this._mPeakR;
      let mSqK = this._mSumSqK;
      const mSL = this._mShelfL, mHL = this._mHpfL;
      const mSR = this._mShelfR, mHR = this._mHpfR;
      for (let i = 0; i < frames; i++) {
        const l = outL[i];
        const r = outR ? outR[i] : l;
        mSqL += l * l;
        mSqR += r * r;
        const aL = l >= 0 ? l : -l;
        const aR = r >= 0 ? r : -r;
        if (aL > mPkL) mPkL = aL;
        if (aR > mPkR) mPkR = aR;
        const fl = biquadStep(mHL, biquadStep(mSL, l));
        const fr = biquadStep(mHR, biquadStep(mSR, r));
        mSqK += fl * fl + fr * fr;
      }
      this._mSumSqL = mSqL;
      this._mSumSqR = mSqR;
      this._mPeakL = mPkL;
      this._mPeakR = mPkR;
      this._mSumSqK = mSqK;
    }

    if (frames) this._frames += frames;
    this._block++;

    if (this._block >= this._hopBlocks) {
      const n = Math.max(1, this._frames);
      const rms = new Array(this._nAudio);
      const peak = new Array(this._nAudio);
      const lufs = new Array(this._nAudio);
      for (let t = 0; t < this._nAudio; t++) {
        rms[t] = Math.sqrt(this._sumSq[t] / n);
        peak[t] = this._peak[t];

        // Channel-weighted mean square for this hop (L+R, G=1 each)
        const blockMs = this._sumSqK[t] / n;
        const ring = this._lufsRing[t];
        const idx = this._lufsIdx[t];
        ring[idx] = blockMs;
        this._lufsIdx[t] = (idx + 1) % this._lufsLen;
        if (this._lufsFilled[t] < this._lufsLen) this._lufsFilled[t]++;
        let acc = 0;
        const filled = this._lufsFilled[t];
        for (let i = 0; i < filled; i++) acc += ring[i];
        const meanMs = acc / Math.max(1, filled);
        lufs[t] = meanMs > 1e-12 ? -0.691 + 10 * Math.log10(meanMs) : -70;

        this._sumSq[t] = 0;
        this._peak[t] = 0;
        this._sumSqK[t] = 0;
      }

      const blockMs = this._mSumSqK / n;
      const mRing = this._mLufsRing;
      const mIdx = this._mLufsIdx;
      mRing[mIdx] = blockMs;
      this._mLufsIdx = (mIdx + 1) % this._lufsLen;
      if (this._mLufsFilled < this._lufsLen) this._mLufsFilled++;
      let mAcc = 0;
      for (let i = 0; i < this._mLufsFilled; i++) mAcc += mRing[i];
      const mMeanMs = mAcc / Math.max(1, this._mLufsFilled);
      const master = {
        rmsL: Math.sqrt(this._mSumSqL / n),
        rmsR: Math.sqrt(this._mSumSqR / n),
        peakL: this._mPeakL,
        peakR: this._mPeakR,
        lufs: mMeanMs > 1e-12 ? -0.691 + 10 * Math.log10(mMeanMs) : -70,
      };
      this._mSumSqL = 0;
      this._mSumSqR = 0;
      this._mPeakL = 0;
      this._mPeakR = 0;
      this._mSumSqK = 0;

      this.port.postMessage({
        type: "meter",
        trackIds: this._ids,
        rms,
        peak,
        lufs,
        master,
        frames: n,
      });
      this._block = 0;
      this._frames = 0;
    }
    return true;
  }
}

registerProcessor("fablecut-meter", FableCutMeterProcessor);
