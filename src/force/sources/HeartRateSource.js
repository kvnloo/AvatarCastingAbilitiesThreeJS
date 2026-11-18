/**
 * Any standard BLE heart-rate strap — the WHOOP with "Broadcast Heart Rate"
 * turned on in its app — through Web Bluetooth (GATT service 0x180D).
 *
 * `connect()` must run inside a click handler (browser rule for device pickers).
 * On Linux Chrome, Web Bluetooth may need chrome://flags/#enable-web-bluetooth.
 */
export class HeartRateSource {
  constructor() {
    this.status = 'off';
    this.bpm = null;
    this._queue = [];
  }

  static get supported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  async connect() {
    if (!HeartRateSource.supported) {
      this.status = 'no Web Bluetooth';
      return;
    }
    try {
      this.status = 'pairing';
      this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
      this.device.addEventListener('gattserverdisconnected', () => (this.status = 'disconnected'));
      const server = await this.device.gatt.connect();
      const service = await server.getPrimaryService('heart_rate');
      const ch = await service.getCharacteristic('heart_rate_measurement');
      ch.addEventListener('characteristicvaluechanged', (e) => {
        this.bpm = parseHeartRate(e.target.value);
        this._queue.push(this.bpm);
      });
      await ch.startNotifications();
      this.status = this.device.name || 'live';
    } catch (err) {
      this.status = err?.name === 'NotFoundError' ? 'off' : 'failed';
    }
  }

  update(_dt, emit) {
    for (const bpm of this._queue) emit(bpm);
    this._queue.length = 0;
  }

  dispose() {
    this.device?.gatt?.disconnect();
  }
}

/** Heart Rate Measurement characteristic: flags bit 0 selects uint8 vs uint16. */
export function parseHeartRate(view) {
  const flags = view.getUint8(0);
  return flags & 1 ? view.getUint16(1, true) : view.getUint8(1);
}
