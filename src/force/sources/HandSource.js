/**
 * Camera → where your palm points.
 *
 * MediaPipe's HandLandmarker runs in the page (WASM + a 7 MB model fetched on
 * first use), so nothing leaves the machine. The library is imported lazily:
 * the sandbox does not pay for it unless the camera is switched on.
 *
 * Output: `aim` in NDC (x mirrored, like a mirror) of the palm centre, and
 * `open` — an open palm reaching out, the Force gesture. A closed fist is
 * "release".
 */
const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm';
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export class HandSource {
  constructor() {
    this.status = 'off';
    this.aim = null; // {x, y} NDC
    this.open = false;
    this.present = false;
  }

  async start() {
    try {
      this.status = 'loading';
      const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
      const files = await FilesetResolver.forVisionTasks(WASM);
      this.landmarker = await HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 1
      });
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      this.video = Object.assign(document.createElement('video'), {
        srcObject: this.stream,
        muted: true,
        playsInline: true
      });
      this.video.className = 'force-cam';
      document.body.appendChild(this.video);
      await this.video.play();
      this.status = 'live';
    } catch (err) {
      console.warn('[HandSource]', err);
      this.status = err?.name === 'NotAllowedError' ? 'camera blocked' : 'failed';
    }
  }

  update() {
    if (this.status !== 'live' || this.video.readyState < 2) return;
    const now = performance.now();
    if (now - (this._last ?? 0) < 33) return; // ~30 Hz is plenty
    this._last = now;
    const result = this.landmarker.detectForVideo(this.video, now);
    const hand = result.landmarks?.[0];
    this.present = !!hand;
    if (!hand) {
      this.open = false;
      return;
    }
    const palm = hand[9]; // middle-finger MCP ≈ palm centre
    this.aim = { x: -(palm.x * 2 - 1), y: -(palm.y * 2 - 1) };
    this.open = isOpenPalm(hand);
  }

  stop() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.video?.remove();
    this.landmarker?.close();
    this.status = 'off';
    this.present = false;
    this.aim = null;
  }

  dispose() {
    this.stop();
  }
}

/** Fingertips far from the wrist relative to palm size = open hand. */
export function isOpenPalm(hand) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const wrist = hand[0];
  const palm = d(wrist, hand[9]) || 1e-3;
  const tips = [8, 12, 16, 20].map((i) => d(wrist, hand[i]) / palm);
  return tips.filter((r) => r > 1.55).length >= 3;
}
