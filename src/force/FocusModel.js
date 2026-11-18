/**
 * FocusModel — turns raw biosignals into "Force power".
 *
 * Pure logic, no DOM and no three.js, so it runs under `node --test`.
 *
 * Inputs (all optional except EEG):
 *   - EEG focus score 0–100 at ~4 Hz (NeuroSkill `EegBands.focus`, or the simulator)
 *   - head stillness 0–100 (NeuroSkill) — moving your head is not using the Force
 *   - heart rate in bpm (WHOOP broadcast, or the Muse's own PPG)
 *   - readiness 0–100 (Oura) — a once-a-day strength multiplier
 *
 * Power is *relative to you*: the first `calibrationSeconds` of a session record
 * your resting focus, and only focus clearly above that baseline lifts anything.
 * A raw 0–100 score would reward whoever happens to have a high resting beta.
 */
export const FocusPhase = Object.freeze({
  NO_SIGNAL: 'no-signal',
  CALIBRATING: 'calibrating',
  READY: 'ready'
});

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smoothstep = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export const DEFAULT_FOCUS_CONFIG = {
  calibrationSeconds: 15,
  minStd: 4, // floor on the baseline spread so a flat calibration is not hair-trigger
  threshold: 0.6, // z-score above baseline where lifting starts
  range: 1.6, // z-score span from "starts to lift" to full power
  riseTau: 0.7, // seconds; power follows focus up
  fallTau: 1.4, // seconds; and drains slower, so holding is fair
  spikeLimit: 35, // a single-sample jump this big is an artifact (jaw clench, blink burst)
  minStillness: 35, // below this the head is moving: samples are ignored
  staleSeconds: 2.5, // no EEG for this long = signal lost
  hrRange: 15, // bpm above resting at which calm reaches 0
  readinessMin: 0.8,
  readinessMax: 1.2
};

export class FocusModel {
  constructor(config = {}) {
    this.config = config; // read live, so the editor can tune it mid-session
    this.reset();
  }

  get cfg() {
    return { ...DEFAULT_FOCUS_CONFIG, ...this.config };
  }

  reset() {
    this.phase = FocusPhase.NO_SIGNAL;
    this.power = 0;
    this.target = 0;
    this.focus = null; // last accepted raw score
    this.z = 0;
    this.calm = 1;
    this.heartRate = null;
    this.readiness = null;
    this.artifact = false;
    this._calib = [];
    this._hrCalib = [];
    this._calibStart = null;
    this.baseline = null; // { mean, std, hr }
    this._lastEegAt = -Infinity;
  }

  /** Throw away the baseline and measure a new one from the next samples. */
  recalibrate() {
    const readiness = this.readiness;
    this.reset();
    this.readiness = readiness;
  }

  get calibrationProgress() {
    if (this.phase === FocusPhase.READY) return 1;
    if (this._calibStart === null) return 0;
    return clamp01((this._now - this._calibStart) / this.cfg.calibrationSeconds);
  }

  /**
   * @param {{focus:number, stillness?:number, hr?:number}} sample
   * @param {number} t seconds (monotonic)
   */
  pushEeg(sample, t) {
    this._now = t;
    const c = this.cfg;
    const f = Number(sample.focus);
    if (!Number.isFinite(f)) return;

    if (Number.isFinite(sample.hr) && sample.hr > 25) this.pushHeartRate(sample.hr, t, 'eeg');

    const moving = Number.isFinite(sample.stillness) && sample.stillness < c.minStillness;
    const spike = this.focus !== null && Math.abs(f - this.focus) > c.spikeLimit;
    this.artifact = moving || spike;
    this._lastEegAt = t;
    if (this.artifact) {
      // Accept the spike as the new reference so a genuine step change is
      // only rejected once, not forever.
      if (spike && !moving) this.focus = f;
      return;
    }
    this.focus = f;

    if (this.phase === FocusPhase.NO_SIGNAL) {
      this.phase = FocusPhase.CALIBRATING;
      this._calibStart = t;
    }

    if (this.phase === FocusPhase.CALIBRATING) {
      this._calib.push(f);
      if (t - this._calibStart >= c.calibrationSeconds && this._calib.length >= 4) {
        const n = this._calib.length;
        const mean = this._calib.reduce((a, b) => a + b, 0) / n;
        const variance = this._calib.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
        const hr = this._hrCalib.length
          ? this._hrCalib.reduce((a, b) => a + b, 0) / this._hrCalib.length
          : null;
        this.baseline = { mean, std: Math.max(c.minStd, Math.sqrt(variance)), hr };
        this.phase = FocusPhase.READY;
      }
      return;
    }

    this.z = (f - this.baseline.mean) / this.baseline.std;
    this.target = smoothstep(c.threshold, c.threshold + c.range, this.z);
  }

  /** @param {'whoop'|'eeg'} source whoop wins when both report */
  pushHeartRate(bpm, t, source = 'whoop') {
    if (!Number.isFinite(bpm) || bpm < 25) return;
    if (source === 'eeg' && this._hrSource === 'whoop' && t - this._hrAt < 5) return;
    this._hrSource = source;
    this._hrAt = t;
    this.heartRate = bpm;
    if (this.phase !== FocusPhase.READY) this._hrCalib.push(bpm);
  }

  /** Oura readiness score 0–100, or null when unknown. */
  setReadiness(score) {
    this.readiness = Number.isFinite(score) ? score : null;
  }

  /** Strength multiplier from last night's recovery. */
  get strength() {
    const c = this.cfg;
    if (this.readiness === null) return 1;
    return c.readinessMin + (c.readinessMax - c.readinessMin) * clamp01(this.readiness / 100);
  }

  /** Advance smoothing. @returns this */
  update(dt, t) {
    this._now = t;
    const c = this.cfg;

    if (t - this._lastEegAt > c.staleSeconds) {
      this.target = 0;
      if (this.phase === FocusPhase.CALIBRATING) {
        // A calibration with a hole in it is not a baseline — start over.
        this._calib = [];
        this._hrCalib = [];
        this._calibStart = null;
        this.phase = FocusPhase.NO_SIGNAL;
      }
    }
    if (this.artifact) this.target = Math.min(this.target, this.power);

    const tau = this.target > this.power ? c.riseTau : c.fallTau;
    this.power += (this.target - this.power) * (1 - Math.exp(-dt / Math.max(0.01, tau)));
    this.power = clamp01(this.power);

    const restHr = this.baseline?.hr;
    this.calm =
      this.heartRate !== null && restHr ? 1 - clamp01((this.heartRate - restHr) / c.hrRange) : 1;
    return this;
  }

  /** What the scene consumes. */
  get lift() {
    return clamp01(this.power * this.strength);
  }

  get signalLost() {
    return this.phase === FocusPhase.NO_SIGNAL;
  }
}
