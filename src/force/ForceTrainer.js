import { Mesh, Vector3, TorusGeometry, MeshBasicMaterial, AdditiveBlending, Group, Color } from 'three';
import { createRockGeometry } from '../assets/ProceduralGeometry.js';
import { createRockMaterial } from '../materials/RockMaterial.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { FocusModel, FocusPhase } from './FocusModel.js';
import { SimSource } from './sources/SimSource.js';
import { NeuroSkillSource } from './sources/NeuroSkillSource.js';
import { HeartRateSource } from './sources/HeartRateSource.js';
import { HandSource } from './sources/HandSource.js';

/**
 * Training stones. The avatar turns to face −Z in force mode, so the stones sit
 * in front of him and the default camera looks over his shoulder at them.
 */
const ROCKS = [
  { x: -2.6, z: -3.4, size: 0.5, seed: 3 },
  { x: 0.2, z: -4.6, size: 0.75, seed: 9 },
  { x: 2.8, z: -3.2, size: 0.4, seed: 17 }
];

const _ndc = new Vector3();
const _emit = {};
const _pos = new Vector3();

/**
 * Force mode: focus lifts the stone you point at.
 *
 *   EEG focus (Muse via NeuroSkill, or the Space-bar simulator) ─┐
 *   heart rate (WHOOP broadcast, or the Muse PPG) ── calm ───────┼─ FocusModel → lift
 *   Oura readiness ── strength ──────────────────────────────────┘
 *   camera palm / mouse ── which stone
 *
 * Owns no render loop of its own; App calls `update(dt, elapsed)` once a frame.
 */
export class ForceTrainer {
  /** @param {object} ctx { scene, camera, environment, particles, lights, decals, bursts, shake, flash, input, character, toast } */
  constructor(ctx) {
    this.ctx = ctx;
    this.active = false;
    this.model = new FocusModel(settings.force);
    this.heart = new HeartRateSource();
    this.hand = new HandSource();
    this.eeg = null;
    this._eegKind = null;
    this.level = 1;
    this.holdTime = 0;
    this.target = 1;

    this.group = new Group();
    this.group.name = 'ForceTrainer';
    this.group.visible = false;
    ctx.scene.add(this.group);

    this.rocks = ROCKS.map((r) => {
      const material = createRockMaterial(ctx.environment, 0.4);
      const mesh = new Mesh(createRockGeometry(r.seed, 1), material);
      mesh.scale.setScalar(r.size);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      return { ...r, mesh, material, rest: r.size * 0.55, y: r.size * 0.55, vy: 0, glow: 0, airborne: false };
    });
    for (const rock of this.rocks) rock.mesh.position.set(rock.x, rock.y, rock.z);

    // The trial ring: hold the stone inside it.
    this.ring = new Mesh(
      new TorusGeometry(1, 0.025, 8, 96),
      new MeshBasicMaterial({ color: new Color(settings.force.auraColor), transparent: true, blending: AdditiveBlending, depthWrite: false })
    );
    this.ring.rotation.x = Math.PI / 2;
    this.ring.layers.set(LAYER.VFX);
    this.group.add(this.ring);

    this.dust = ctx.particles.get('force.dust', {
      capacity: 1600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.dust.uniforms.uGravity.value.set(0, 0.4, 0);
    this.dust.uniforms.uDrag.value = 2.4;
    this.dust.uniforms.uEndSize.value = 2.0;
    this.dust.uniforms.uFadeIn.value = 0.15;
    this.dust.uniforms.uFadeOut.value = 0.4;
    // Grey stone dust, not the default fire ramp.
    this.dust.setGradient(new Color('#c9c3b8'), new Color('#9a948a'), new Color('#5d5852'), new Color('#2a2826'));
    this.dustEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */

  setActive(active) {
    if (active === this.active) return;
    this.active = active;
    this.group.visible = active;
    if (active) {
      this._prevPose = settings.character.pose;
      this._prevFacing = this.ctx.character.facing;
      this.ctx.character.setPose('sitting');
      this.ctx.character.setFacing(Math.PI);
      this.model.recalibrate();
    } else {
      this.ctx.character.setPose(this._prevPose ?? 'idle');
      this.ctx.character.setFacing(this._prevFacing ?? 0);
      this._releaseLight();
      this.eeg?.dispose();
      this.eeg = null;
      this._eegKind = null;
      this.hand.stop();
    }
  }

  recalibrate() {
    this.model.recalibrate();
    this.ctx.toast('Recalibrating — sit still and relax');
  }

  connectHeart() {
    return this.heart.connect();
  }

  toggleCamera() {
    if (this.hand.status === 'off' || this.hand.status === 'failed' || this.hand.status === 'camera blocked') {
      return this.hand.start();
    }
    this.hand.stop();
  }

  setReadiness(score) {
    this.model.setReadiness(score);
  }

  reset() {
    for (const rock of this.rocks) Object.assign(rock, { y: rock.rest, vy: 0, glow: 0, airborne: false });
    this.holdTime = 0;
  }

  /* ------------------------------------------------------------------ */

  _syncEegSource() {
    const kind = settings.force.eegSource === 'muse' ? 'muse' : 'sim';
    if (kind === this._eegKind) return;
    this.eeg?.dispose();
    this.eeg =
      kind === 'muse' ? new NeuroSkillSource() : new SimSource(() => this.ctx.input.keys.has('Space'));
    this._eegKind = kind;
    this.model.recalibrate();
  }

  /**
   * Which stone you are pointing at. Measured against each stone's spot on the
   * floor, not its current height — a rising stone would otherwise slide away
   * from the cursor and hand the Force to its neighbour every few frames.
   * Switching also needs a clear margin (hysteresis).
   */
  _pickTarget() {
    const aim = this.hand.present && this.hand.aim ? this.hand.aim : this.ctx.input.pointer;
    const dist = this.rocks.map((rock) => {
      _ndc.set(rock.x, rock.rest, rock.z).project(this.ctx.camera);
      return Math.hypot(_ndc.x - aim.x, _ndc.y - aim.y);
    });
    const best = dist.indexOf(Math.min(...dist));
    if (best !== this.target && dist[best] < 0.45 && dist[best] + 0.12 < dist[this.target]) {
      this.target = best;
    }
  }

  update(dt, elapsed) {
    if (!this.active) return;
    const cfg = settings.force;
    const t = performance.now() / 1000;

    this._syncEegSource();
    this.eeg.update(dt, (sample) => this.model.pushEeg(sample, t));
    this.heart.update(dt, (bpm) => this.model.pushHeartRate(bpm, t, 'whoop'));
    this.hand.update();
    // Biosignals live in wall-clock time; the sim clock may be slowed or clamped.
    const wallDt = Math.min(0.5, t - (this._lastT ?? t));
    this._lastT = t;
    this.model.update(wallDt, t);
    this._pickTarget();

    // With the camera on, the Force flows through an open palm only.
    const gate = this.hand.status === 'live' && cfg.requireOpenPalm ? (this.hand.open ? 1 : 0) : 1;
    const lift = this.model.lift * gate;
    const shake = 1 - this.model.calm;

    this.rocks.forEach((rock, i) => {
      const held = i === this.target && lift > 0.02;
      if (held) {
        const goalY = rock.rest + lift * cfg.liftHeight;
        rock.vy += (cfg.stiffness * (goalY - rock.y) - cfg.damping * rock.vy) * dt;
        rock.airborne = true;
      } else {
        rock.vy -= 14 * dt;
      }
      rock.y += rock.vy * dt;

      if (rock.y <= rock.rest) {
        if (rock.airborne && rock.vy < -2) this._land(rock, -rock.vy);
        rock.y = rock.rest;
        rock.vy = rock.vy < -2 ? -rock.vy * 0.18 : 0;
        if (rock.vy === 0) rock.airborne = false;
      }

      const height = rock.y - rock.rest;
      const w = cfg.wobble * shake * Math.min(1, height);
      rock.mesh.position.set(
        rock.x + w * Math.sin(elapsed * 23 + i),
        rock.y + w * 0.5 * Math.sin(elapsed * 31 + i * 2),
        rock.z + w * Math.cos(elapsed * 19 + i)
      );
      if (height > 0.05) {
        rock.mesh.rotation.y += cfg.spin * dt;
        rock.mesh.rotation.x += cfg.spin * 0.4 * dt;
      }
      rock.glow += ((held ? lift : 0) - rock.glow) * (1 - Math.exp(-dt / 0.25));
      rock.material.userData.sync?.(rock.glow * 2.5);
      rock.material.userData.uniforms.uGlowColor.value.copy(getColor(cfg.auraColor));
    });

    const rock = this.rocks[this.target];
    this._updateAura(rock, lift, dt, elapsed);
    this._updateTrial(rock, dt);
  }

  _updateAura(rock, lift, dt, elapsed) {
    const cfg = settings.force;
    if (!this.light) this.light = this.ctx.lights.acquire();
    _pos.set(rock.x, rock.y + 0.4, rock.z);
    this.ctx.lights.set(this.light, _pos, getColor(cfg.auraColor), cfg.lightIntensity * (0.15 + lift), cfg.lightRadius, dt);

    // Dust kicked off the floor under a stone that is being pulled up.
    const count = this.dustEmitter.tick(dt, cfg.dustRate * lift * Math.max(0, 1 - (rock.y - rock.rest) / 2.5));
    if (count > 0) {
      Object.assign(_emit, {
        position: _pos.set(rock.x, 0.06, rock.z),
        radius: rock.size * 1.4,
        direction: null,
        speed: 0.8,
        spread: 1,
        size: 0.3,
        sizeVariance: 0.5,
        life: 1.2,
        lifeVariance: 0.4,
        spin: 0.6,
        tint: null,
        inherit: null,
        anchor: null,
        time: elapsed
      });
      this.dust.emit(count, _emit);
    }
  }

  _updateTrial(rock, dt) {
    const cfg = settings.force;
    const goal = cfg.goalHeight + (this.level - 1) * cfg.goalStep;
    this.ring.position.set(rock.x, rock.rest + goal, rock.z);
    this.ring.scale.setScalar(rock.size * 1.8);

    const inRing = Math.abs(rock.y - rock.rest - goal) < cfg.goalBand;
    this.holdTime = inRing ? this.holdTime + dt : Math.max(0, this.holdTime - dt * 2);
    this.ring.material.opacity = 0.35 + 0.65 * (this.holdTime / cfg.goalHold);

    if (this.holdTime >= cfg.goalHold) {
      this.holdTime = 0;
      this.level += 1;
      const aura = getColor(cfg.auraColor);
      this.ctx.bursts.spawn(BurstMode.AIR, rock.mesh.position, { radius: 0.3, endRadius: 3.5, life: 0.9, colorA: aura, colorB: aura, colorC: aura });
      this.ctx.flash.trigger(aura, 0.35);
      this.ctx.toast(`Trial passed — level ${this.level}`);
    }
  }

  _land(rock, speed) {
    const cfg = settings.force;
    const strength = Math.min(1, speed / 8);
    this.ctx.shake.add(cfg.landShake * strength, 4, 17);
    this.ctx.decals.spawn(DecalType.DUSTRING, _pos.set(rock.x, 0, rock.z), {
      radius: rock.size * 2,
      life: 1.1,
      intensity: 0.8 * strength,
      colorA: getColor(settings.earth.colorRock),
      colorB: getColor(settings.earth.colorRockDark)
    });
  }

  _releaseLight() {
    this.ctx.lights.release(this.light);
    this.light = null;
  }

  /** Snapshot for the HUD. */
  get readout() {
    const m = this.model;
    return {
      phase: m.phase,
      calibration: m.calibrationProgress,
      focus: m.focus,
      z: m.z,
      power: m.lift,
      calm: m.calm,
      heartRate: m.heartRate,
      readiness: m.readiness,
      artifact: m.artifact,
      eeg: this._eegKind === 'sim' ? 'hold Space' : (this.eeg?.status ?? 'off'),
      eegKind: this._eegKind,
      heart: this.heart.status,
      camera: this.hand.status,
      palm: this.hand.status === 'live' ? (this.hand.present ? (this.hand.open ? 'open' : 'closed') : 'no hand') : null,
      level: this.level,
      hold: this.holdTime / settings.force.goalHold
    };
  }

  dispose() {
    this.setActive(false);
    this.heart.dispose();
    this.ctx.scene.remove(this.group);
    for (const rock of this.rocks) {
      rock.mesh.geometry.dispose();
      rock.material.dispose();
    }
    this.ring.geometry.dispose();
    this.ring.material.dispose();
  }
}

export { FocusPhase };
