/**
 * Simulated headset: hold Space to "concentrate".
 *
 * Emits the same 0–100 focus score at the same ~4 Hz cadence as the Muse via
 * NeuroSkill, so the whole pipeline (calibration, smoothing, artifact gate) is
 * exercised without a headset. Runs on wall-clock time like a real headset,
 * independent of frame rate. A tuning aid, not a way to win.
 */
export class SimSource {
  constructor(isHeld, now = () => performance.now() / 1000) {
    this.isHeld = isHeld;
    this.now = now;
    this.status = 'sim';
    this._t = now();
    this._level = 48;
  }

  /** @param {(sample:object)=>void} emit */
  update(_dt, emit) {
    const now = this.now();
    while (now - this._t >= 0.25) {
      this._t += 0.25;
      const goal = this.isHeld() ? 76 : 48;
      this._level += (goal - this._level) * (1 - Math.exp(-0.25 / 1.2));
      emit({ focus: this._level + (Math.random() - 0.5) * 8, stillness: 90 });
    }
  }

  dispose() {}
}
