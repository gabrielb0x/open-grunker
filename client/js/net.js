/**
 * Open Grunker — realtime client.
 *
 * Thin event-emitting wrapper over the WebSocket: batches input at the tick
 * rate, keeps a smoothed estimate of the server clock, and measures RTT so the
 * server can lag-compensate our shots.
 */
import * as K from '/shared/constants.js';

export class Net {
  constructor() {
    this.ws = null;
    this.listeners = new Map();
    this.connected = false;
    this.rtt = 0.08;
    this.rttSamples = [];
    this.clockOffset = 0;         // serverTimeMs - performance.now()
    this.clockReady = false;
    this.inputBatch = [];
    this.lastFlush = 0;
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.myId = 0;
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return this;
  }

  emit(event, ...args) {
    const set = this.listeners.get(event);
    if (set) for (const fn of set) fn(...args);
  }

  /** @param {{name?:string, token?:string, classId?:string, room?:string, spectate?:boolean}} opts */
  connect(opts = {}) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;

    this.disconnect();
    const ws = new WebSocket(url);
    this.ws = ws;
    this.opts = opts;

    // Every handler checks that it still belongs to the live socket: closing
    // one connection to open another must never disturb the new one.
    const current = () => this.ws === ws;

    ws.addEventListener('open', () => {
      if (!current()) return;
      this.connected = true;
      this.send({
        o: K.C2S.HELLO,
        protocol: K.PROTOCOL_VERSION,
        name: opts.name,
        token: opts.token || undefined,
        classId: opts.classId,
        room: opts.room || undefined,
        spectate: opts.spectate ? 1 : undefined,
      });
      this.pingTimer = setInterval(() => this.ping(), 1000);
      this.ping();
    });

    ws.addEventListener('message', (ev) => {
      if (!current()) return;
      this.bytesIn += ev.data.length ?? 0;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this._handle(msg);
    });

    ws.addEventListener('close', (ev) => {
      if (!current()) return;                  // already replaced or closed by us
      this.connected = false;
      clearInterval(this.pingTimer);
      this.emit('close', ev.code, ev.reason);
    });

    ws.addEventListener('error', () => { if (current()) this.emit('error'); });
  }

  disconnect() {
    clearInterval(this.pingTimer);
    if (this.ws) {
      const ws = this.ws;
      // Detach first: the close event that follows belongs to a dead socket.
      this.ws = null;
      try { ws.close(1000, 'leaving'); } catch { /* already closed */ }
    }
    this.connected = false;
    this.inputBatch.length = 0;
    this.clockReady = false;
  }

  _handle(msg) {
    switch (msg.o) {
      case K.S2C.WELCOME:
        this.myId = msg.id;
        // First clock anchor; refined by every pong.
        this.clockOffset = msg.serverTime - performance.now();
        this.clockReady = true;
        this.emit('welcome', msg);
        break;

      case K.S2C.PONG: {
        const rtt = (performance.now() - msg.t) / 1000;
        if (rtt >= 0 && rtt < 2) {
          this.rttSamples.push(rtt);
          if (this.rttSamples.length > 8) this.rttSamples.shift();
          // Median is far more stable than a mean under jitter.
          const sorted = [...this.rttSamples].sort((a, b) => a - b);
          this.rtt = sorted[Math.floor(sorted.length / 2)];
        }
        // Server time when the pong was sent, plus half the return trip.
        const estimate = msg.s + (this.rtt * 1000) / 2;
        const local = performance.now();
        const offset = estimate - local;
        this.clockOffset = this.clockReady ? this.clockOffset + (offset - this.clockOffset) * 0.12 : offset;
        this.clockReady = true;
        break;
      }

      case K.S2C.SNAPSHOT: this.emit('snapshot', msg); break;
      case K.S2C.JOIN: this.emit('join', msg.player); break;
      case K.S2C.LEAVE: this.emit('leave', msg.id); break;
      case K.S2C.HIT: this.emit('hit', msg); break;
      case K.S2C.DAMAGE: this.emit('damage', msg); break;
      case K.S2C.KILL: this.emit('kill', msg); break;
      case K.S2C.DEATH: this.emit('death', msg); break;
      case K.S2C.SPAWN: this.emit('spawn', msg); break;
      case K.S2C.SHOT: this.emit('shot', msg); break;
      case K.S2C.IMPACT: this.emit('impact', msg); break;
      case K.S2C.EXPLOSION: this.emit('explosion', msg); break;
      case K.S2C.CHAT: this.emit('chat', msg); break;
      case K.S2C.CHATSTATE: this.emit('chatstate', msg); break;
      case K.S2C.REPORT: this.emit('report', msg); break;
      case K.S2C.REPORTSTATE: this.emit('reportstate', msg); break;
      case K.S2C.NUKE: this.emit('nuke', msg); break;
      case K.S2C.GOD: this.emit('god', msg); break;
      case K.S2C.SCORE: this.emit('score', msg); break;
      case K.S2C.POINTS: this.emit('points', msg); break;
      case K.S2C.MATCH: this.emit('match', msg); break;
      case K.S2C.AMMO: this.emit('ammo', msg); break;
      case K.S2C.OBJECTIVE: this.emit('objective', msg); break;
      case K.S2C.VOTE: this.emit('vote', msg); break;
      case K.S2C.GUNGAME: this.emit('gungame', msg); break;
      case K.S2C.PROGRESS: this.emit('progress', msg); break;
      case K.S2C.ERROR: this.emit('serverError', msg); break;
      default: break;
    }
  }

  /** Current server clock in ms (same units as snapshot timestamps). */
  get serverTime() { return performance.now() + this.clockOffset; }

  send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const data = JSON.stringify(msg);
    this.bytesOut += data.length;
    this.ws.send(data);
  }

  ping() {
    this.send({ o: K.C2S.PING, t: performance.now(), rtt: Math.round(this.rtt * 1000) });
  }

  /** Queues one simulation tick's input; flushed on the next flushInputs(). */
  queueInput(seq, keys, yaw, pitch) {
    this.inputBatch.push([seq, keys, round4(yaw), round4(pitch)]);
    if (this.inputBatch.length > K.MAX_INPUTS_PER_PACKET) this.inputBatch.shift();
  }

  /** Sends queued inputs. Called at ~30 Hz so we send 2 ticks per packet. */
  flushInputs() {
    if (!this.inputBatch.length) return;
    this.send({ o: K.C2S.INPUT, i: this.inputBatch });
    this.inputBatch = [];
  }

  /**
   * `seq` seeds the deterministic spread — the server reuses the same value —
   * and `burst` is our own bloom counter, which the server accepts only while
   * it agrees with its own within a couple of rounds.
   */
  shoot(yaw, pitch, ads, seq, burst = 0) {
    this.flushInputs();                       // aim must land before the shot
    this.send({
      o: K.C2S.SHOOT, y: round4(yaw), p: round4(pitch),
      a: ads ? 1 : 0, n: seq, b: burst,
    });
  }

  melee() { this.send({ o: K.C2S.MELEE }); }
  reload() { this.send({ o: K.C2S.RELOAD }); }
  switchSlot(slot) { this.send({ o: K.C2S.SWITCH, s: slot }); }
  chat(text) { this.send({ o: K.C2S.CHAT, m: text }); }
  /**
   * A moderation action on another player — `mute` or `unmute`. The server
   * re-checks the rank; this is only ever the request.
   */
  mod(action, targetId, minutes = 0, reason = null) {
    this.send({ o: K.C2S.MOD, a: action, t: targetId, d: minutes, r: reason || undefined });
  }
  /**
   * Reports another player from the scoreboard. The room fills in who they
   * really are, which match it was and what had just been said in it — this
   * only carries the accusation.
   */
  report(targetId, reason, detail = '') {
    this.send({ o: K.C2S.REPORT, t: targetId, r: reason, d: detail || undefined });
  }
  respawn() { this.send({ o: K.C2S.RESPAWN }); }
  setClass(classId) { this.send({ o: K.C2S.CLASS, c: classId }); }
  /** A spectator asking for a seat in the match it is watching. */
  play() { this.send({ o: K.C2S.PLAY }); }
  /** Vote for the next map during the intermission. */
  vote(mapId) { this.send({ o: K.C2S.VOTE, m: mapId }); }
  /** Cycle the spectator camera to the next/previous live player. */
  spectate(dir = 1) { this.send({ o: K.C2S.SPECTATE, d: dir < 0 ? -1 : 1 }); }
  /**
   * Ask to watch rather than play, or to stop. The room decides when it lands:
   * on at the next death, off as soon as there is a seat.
   */
  spectateMode(on) { this.send({ o: K.C2S.SPECMODE, v: on ? 1 : 0 }); }
  /** Spend an earned killstreak. The room decides whether it was earned. */
  nuke() { this.send({ o: K.C2S.NUKE }); }
  /**
   * Ask for god mode. The server re-checks the rank, so this is a request and
   * never a permission — the client only ever draws what the server answered.
   */
  god(on) { this.send({ o: K.C2S.GOD, v: on ? 1 : 0 }); }
}

const round4 = (v) => Math.round(v * 10000) / 10000;

export default Net;
