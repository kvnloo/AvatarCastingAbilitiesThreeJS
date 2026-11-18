/**
 * Muse S via the local NeuroSkill daemon.
 *
 * The daemon pairs the headset, computes band powers and composite scores and
 * broadcasts `EegBands` at ~4 Hz on `/v1/events`. `EegBands` is a high-rate
 * event, so it must be opted into with a `subscribe` command.
 *
 * The browser connects to `/neuro/...` on the Vite dev server, which proxies to
 * the daemon and attaches the bearer token server-side (see vite.config.js), so
 * the token never reaches page JavaScript.
 */
export class NeuroSkillSource {
  constructor(url = defaultUrl()) {
    this.url = url;
    this.status = 'connecting';
    this._queue = [];
    this._closed = false;
    this._lastSample = 0;
    this._connect();
  }

  _connect() {
    if (this._closed) return;
    this.status = 'connecting';
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this._retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.status = 'waiting for headset';
      ws.send(JSON.stringify({ command: 'subscribe', events: ['EegBands'] }));
    };
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'DeviceDisconnected') this.status = 'waiting for headset';
      if (msg.type !== 'EegBands' || !msg.payload) return;
      const p = msg.payload;
      this._lastSample = performance.now();
      this.status = 'live';
      this._queue.push({
        focus: p.focus ?? p.engagement,
        stillness: p.stillness,
        hr: p.hr,
        relaxation: p.relaxation
      });
    };
    ws.onclose = () => this._retry();
    ws.onerror = () => ws.close();
  }

  _retry() {
    if (this._closed) return;
    this.status = 'daemon offline';
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._connect(), 3000);
  }

  update(_dt, emit) {
    if (this.status === 'live' && performance.now() - this._lastSample > 3000) {
      this.status = 'waiting for headset';
    }
    for (const sample of this._queue) emit(sample);
    this._queue.length = 0;
  }

  dispose() {
    this._closed = true;
    clearTimeout(this._timer);
    this.ws?.close();
  }
}

function defaultUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/neuro/v1/events`;
}
