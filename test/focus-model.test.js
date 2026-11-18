import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FocusModel, FocusPhase } from '../src/force/FocusModel.js';

/** Feed `seconds` of 4 Hz samples produced by `fn(t)`, advancing the model. */
function run(model, from, seconds, fn) {
  let t = from;
  const dt = 0.25;
  for (; t < from + seconds; t += dt) {
    const s = fn(t);
    if (s) model.pushEeg(s, t);
    model.update(dt, t);
  }
  return t;
}

const jitter = (base, amp = 3) => (t) => ({ focus: base + amp * Math.sin(t * 7.3) });

function calibrated(base = 50) {
  const m = new FocusModel({ calibrationSeconds: 10 });
  const t = run(m, 0, 11, jitter(base));
  assert.equal(m.phase, FocusPhase.READY);
  return { m, t };
}

test('no lift before calibration finishes, even with high focus', () => {
  const m = new FocusModel({ calibrationSeconds: 10 });
  run(m, 0, 8, () => ({ focus: 95 }));
  assert.equal(m.phase, FocusPhase.CALIBRATING);
  assert.equal(m.lift, 0);
});

test('resting at baseline does not lift', () => {
  const { m, t } = calibrated(50);
  run(m, t, 10, jitter(50));
  assert.ok(m.lift < 0.05, `lift ${m.lift}`);
});

test('sustained focus above baseline lifts; letting go drains', () => {
  const { m, t } = calibrated(50);
  const t2 = run(m, t, 6, jitter(72));
  assert.ok(m.lift > 0.8, `lift while focused ${m.lift}`);
  run(m, t2, 8, jitter(50));
  assert.ok(m.lift < 0.1, `lift after release ${m.lift}`);
});

test('baseline is personal: a high resting score still has to rise', () => {
  const { m, t } = calibrated(80);
  run(m, t, 6, jitter(80));
  assert.ok(m.lift < 0.05, `lift ${m.lift}`);
});

test('a one-sample spike (jaw clench) does not lift', () => {
  const { m, t } = calibrated(50);
  let t2 = run(m, t, 2, jitter(50));
  m.pushEeg({ focus: 99 }, t2);
  m.update(0.25, t2);
  t2 = run(m, t2 + 0.25, 1, jitter(50));
  assert.ok(m.lift < 0.05, `lift ${m.lift}`);
});

test('head movement samples are ignored', () => {
  const { m, t } = calibrated(50);
  run(m, t, 6, (tt) => ({ focus: 90, stillness: 10 + tt * 0 }));
  assert.ok(m.lift < 0.05, `lift ${m.lift}`);
});

test('signal loss drops the rock and resets an unfinished calibration', () => {
  const { m, t } = calibrated(50);
  const t2 = run(m, t, 6, jitter(75));
  assert.ok(m.lift > 0.8);
  run(m, t2, 6, () => null);
  assert.ok(m.lift < 0.1, `lift ${m.lift}`);

  const fresh = new FocusModel({ calibrationSeconds: 10 });
  const t3 = run(fresh, 0, 5, jitter(50));
  run(fresh, t3, 4, () => null);
  assert.equal(fresh.phase, FocusPhase.NO_SIGNAL);
});

test('heart rate above resting lowers calm; whoop beats muse PPG', () => {
  const m = new FocusModel({ calibrationSeconds: 10 });
  let t = 0;
  for (; t < 11; t += 0.25) {
    m.pushHeartRate(60, t, 'whoop');
    m.pushEeg({ focus: 50, hr: 90 }, t); // ignored: whoop is fresher
    m.update(0.25, t);
  }
  assert.equal(Math.round(m.baseline.hr), 60);
  m.pushHeartRate(75, t, 'whoop');
  m.update(0.25, t);
  assert.ok(m.calm < 0.05, `calm ${m.calm}`);
});

test('oura readiness scales strength', () => {
  const m = new FocusModel();
  assert.equal(m.strength, 1);
  m.setReadiness(100);
  assert.ok(Math.abs(m.strength - 1.2) < 1e-9);
  m.setReadiness(0);
  assert.ok(Math.abs(m.strength - 0.8) < 1e-9);
  m.recalibrate();
  assert.ok(Math.abs(m.strength - 0.8) < 1e-9, 'readiness survives recalibration');
});
