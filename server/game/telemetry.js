/**
 * Open Grunker — telemetry sampler.
 *
 * One timer, one row set per interval. Everything a graph in the admin panel
 * draws over time comes from here; everything it draws as a total comes from
 * the tables that were already being written.
 *
 * The split is deliberate. Gameplay never touches the database on this path:
 * the rooms count what they do into plain integers, and this drains them on a
 * five-minute timer into a single transaction. A match that is going badly must
 * never also be the thing making SQLite slow.
 */
import config from '../config.js';
import log from '../util/log.js';

const logger = log.child('metrics');

/** Series that are gauges (averaged when a chart buckets them). */
export const GAUGES = [
  'players.online', 'players.watching', 'players.accounts', 'players.guests',
  'players.bots', 'rooms.open', 'rooms.live', 'rooms.dynamic', 'rooms.freeSeats',
  'server.tickMs', 'server.tickMaxMs', 'server.memMb', 'server.sockets',
];

/** Series that are counters (summed when a chart buckets them). */
export const COUNTERS = [
  'game.kills', 'game.headshots', 'game.deaths', 'game.shots', 'game.damage',
  'game.chat', 'game.joins', 'game.leaves', 'game.matches', 'server.overloadDrops',
];

/** Human labels and units, so the panel does not have to keep its own copy. */
export const SERIES_META = {
  'players.online': { label: 'Players online', unit: '', agg: 'avg' },
  'players.accounts': { label: 'Signed in', unit: '', agg: 'avg' },
  'players.guests': { label: 'Guests', unit: '', agg: 'avg' },
  'players.watching': { label: 'Spectators', unit: '', agg: 'avg' },
  'players.bots': { label: 'Bots', unit: '', agg: 'avg' },
  'rooms.open': { label: 'Rooms listed', unit: '', agg: 'avg' },
  'rooms.live': { label: 'Rooms with players', unit: '', agg: 'avg' },
  'rooms.dynamic': { label: 'Rooms opened by demand', unit: '', agg: 'avg' },
  'rooms.freeSeats': { label: 'Free seats', unit: '', agg: 'avg' },
  'server.tickMs': { label: 'Tick cost', unit: 'ms', agg: 'avg' },
  'server.tickMaxMs': { label: 'Worst tick', unit: 'ms', agg: 'max' },
  'server.memMb': { label: 'Memory', unit: 'MB', agg: 'avg' },
  'server.sockets': { label: 'Sockets', unit: '', agg: 'avg' },
  'game.kills': { label: 'Kills', unit: '', agg: 'sum' },
  'game.headshots': { label: 'Headshots', unit: '', agg: 'sum' },
  'game.deaths': { label: 'Deaths', unit: '', agg: 'sum' },
  'game.shots': { label: 'Shots fired', unit: '', agg: 'sum' },
  'game.damage': { label: 'Damage dealt', unit: '', agg: 'sum' },
  'game.chat': { label: 'Chat messages', unit: '', agg: 'sum' },
  'game.joins': { label: 'Joins', unit: '', agg: 'sum' },
  'game.leaves': { label: 'Leaves', unit: '', agg: 'sum' },
  'game.matches': { label: 'Matches finished', unit: '', agg: 'sum' },
  'server.overloadDrops': { label: 'Overload drops', unit: '', agg: 'sum' },
};

export class Telemetry {
  /**
   * @param {object} o
   * @param {import('./hub.js').Hub} o.hub
   * @param {object} o.db database module — nothing is sampled without one
   * @param {function():number} [o.socketCount] live socket count, for the gauge
   */
  constructor({ hub, db, socketCount = null }) {
    this.hub = hub;
    this.db = db;
    this.socketCount = socketCount;
    this.timer = null;
    this.lastDrops = 0;
    this.lastSampleAt = 0;
  }

  get enabled() { return !!(config.metrics.enabled && this.db?.metrics); }

  start() {
    if (!this.enabled || this.timer) return;
    const every = Math.max(30, config.metrics.intervalSec);
    // Sample once on the way up so a freshly restarted server has a point on
    // the graph rather than a five-minute hole at the right-hand edge.
    this.sample();
    this.timer = setInterval(() => this.sample(), every * 1000);
    this.timer.unref?.();
    logger.info(`sampling every ${every}s into metrics`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Collects one bucket.
   *
   * Counters are drained rather than read, so two samplers could never
   * double-count and a missed interval loses nothing — whatever the rooms
   * counted lands in the next bucket instead of vanishing.
   */
  collect() {
    const hub = this.hub;
    const totals = {
      kills: 0, headshots: 0, shots: 0, damage: 0, chat: 0,
      joins: 0, leaves: 0, matches: 0, deaths: 0,
    };
    let accounts = 0, guests = 0;
    for (const room of hub.rooms.values()) {
      const c = room.drainCounters();
      for (const k of Object.keys(totals)) totals[k] += c[k] ?? 0;
      for (const p of room.players.values()) {
        if (p.isBot || p.spectator) continue;
        if (p.userId) accounts++; else guests++;
      }
    }

    const health = hub.health();
    // The worst tick is a per-window figure: carrying the all-time peak forward
    // would make the graph a flat line at whatever happened during boot.
    const tickMax = hub.stats.maxTickMs;
    hub.stats.maxTickMs = 0;
    const drops = hub.stats.drops - this.lastDrops;
    this.lastDrops = hub.stats.drops;

    return {
      'players.online': health.players,
      'players.accounts': accounts,
      'players.guests': guests,
      'players.watching': health.watching,
      'players.bots': health.bots,
      'rooms.open': health.rooms,
      'rooms.live': health.liveRooms ?? 0,
      'rooms.dynamic': health.dynamicRooms,
      'rooms.freeSeats': health.freeSeats,
      'server.tickMs': Math.round(health.lastTickMs * 100) / 100,
      'server.tickMaxMs': Math.round(tickMax * 100) / 100,
      'server.memMb': Math.round(process.memoryUsage().rss / 1048576),
      'server.sockets': this.socketCount ? this.socketCount() : 0,
      'server.overloadDrops': Math.max(0, drops),
      'game.kills': totals.kills,
      'game.headshots': totals.headshots,
      'game.deaths': totals.deaths,
      'game.shots': totals.shots,
      'game.damage': Math.round(totals.damage),
      'game.chat': totals.chat,
      'game.joins': totals.joins,
      'game.leaves': totals.leaves,
      'game.matches': totals.matches,
    };
  }

  sample() {
    if (!this.enabled) return null;
    const every = Math.max(30, config.metrics.intervalSec);
    const at = Math.floor(Date.now() / 1000 / every) * every;
    const values = this.collect();
    try {
      this.db.metrics.write(at, values);
      this.lastSampleAt = at;
    } catch (err) {
      logger.warn('sample failed:', err.message);
    }
    return values;
  }
}

export default Telemetry;
