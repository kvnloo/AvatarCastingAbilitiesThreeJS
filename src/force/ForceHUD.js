import { settings } from '../config/settings.js';
import { FocusPhase } from './FocusModel.js';

/**
 * Force-mode panel: meters for power / calm, the trial, and one row per
 * signal source with its connect control. Plain DOM, like the rest of the HUD.
 */
export class ForceHUD {
  constructor(root, trainer) {
    this.trainer = trainer;
    this.el = document.createElement('div');
    this.el.className = 'hud__panel force-panel is-hidden';
    this.el.innerHTML = `
      <div class="force-panel__title">The Force <span data-f="level"></span></div>
      <div class="force-panel__status" data-f="status"></div>
      ${meter('Power', 'power')}
      ${meter('Calm', 'calm')}
      ${meter('Trial', 'hold')}
      <div class="force-panel__rows">
        <div>EEG <b data-f="eeg"></b>
          <button data-a="eeg"></button></div>
        <div>Heart <b data-f="heart"></b>
          <button data-a="heart">Connect strap</button></div>
        <div>Camera <b data-f="camera"></b>
          <button data-a="camera">Toggle</button></div>
        <div>Readiness <b data-f="readiness">—</b>
          <input data-a="readiness" type="number" min="0" max="100" placeholder="Oura" /></div>
      </div>
      <div class="force-panel__hint"><kbd>Space</kbd> focus (sim) &nbsp; <kbd>R</kbd> recalibrate &nbsp; point at a stone</div>
    `;
    root.appendChild(this.el);
    this.f = Object.fromEntries([...this.el.querySelectorAll('[data-f]')].map((n) => [n.dataset.f, n]));
    this.bars = Object.fromEntries([...this.el.querySelectorAll('[data-bar]')].map((n) => [n.dataset.bar, n]));

    const on = (a, type, fn) => this.el.querySelector(`[data-a="${a}"]`).addEventListener(type, fn);
    on('eeg', 'click', () => {
      settings.force.eegSource = settings.force.eegSource === 'muse' ? 'sim' : 'muse';
    });
    on('heart', 'click', () => trainer.connectHeart());
    on('camera', 'click', () => trainer.toggleCamera());
    on('readiness', 'change', (e) => {
      const v = e.target.value === '' ? null : Number(e.target.value);
      trainer.setReadiness(v);
    });
    this.el.querySelector('[data-a="readiness"]').addEventListener('keydown', (e) => e.stopPropagation());

    // Today's Oura readiness, if the dev server has a token for it.
    fetch('./oura/readiness')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (Number.isFinite(j?.score)) {
          trainer.setReadiness(j.score);
          this.el.querySelector('[data-a="readiness"]').value = j.score;
        }
      })
      .catch(() => {});
  }

  show(visible) {
    this.el.classList.toggle('is-hidden', !visible);
  }

  update() {
    if (this.el.classList.contains('is-hidden')) return;
    const r = this.trainer.readout;
    this.f.level.textContent = `· level ${r.level}`;
    this.f.status.textContent = statusLine(r);
    this.f.status.dataset.phase = r.phase;
    this.bars.power.style.width = `${(r.power * 100).toFixed(1)}%`;
    this.bars.calm.style.width = `${(r.calm * 100).toFixed(1)}%`;
    this.bars.hold.style.width = `${(Math.min(1, r.hold) * 100).toFixed(1)}%`;
    this.f.eeg.textContent = `${r.eegKind === 'muse' ? 'Muse' : 'sim'} · ${r.eeg}${r.focus !== null ? ` · ${Math.round(r.focus)}` : ''}`;
    this.el.querySelector('[data-a="eeg"]').textContent = r.eegKind === 'muse' ? 'Use sim' : 'Use Muse';
    this.f.heart.textContent = r.heartRate ? `${Math.round(r.heartRate)} bpm · ${r.heart}` : r.heart;
    this.f.camera.textContent = r.palm ? `${r.camera} · ${r.palm}` : r.camera;
    this.f.readiness.textContent = r.readiness ?? '—';
  }
}

function meter(label, key) {
  return `<div class="force-meter"><span>${label}</span><i><b data-bar="${key}"></b></i></div>`;
}

function statusLine(r) {
  if (r.phase === FocusPhase.NO_SIGNAL) {
    return r.eegKind === 'muse' ? `Waiting for EEG (${r.eeg})` : 'Waiting for EEG';
  }
  if (r.phase === FocusPhase.CALIBRATING) {
    return `Calibrating — breathe, stay still · ${Math.round(r.calibration * 100)}%`;
  }
  if (r.artifact) return 'Too much movement — be still';
  if (r.palm === 'closed' || r.palm === 'no hand') return 'Reach out with an open palm';
  if (r.power > 0.6) return 'You are one with the Force';
  if (r.power > 0.1) return 'It moves…';
  return 'Focus.';
}
