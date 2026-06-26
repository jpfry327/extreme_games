/**
 * Server-side delta channel — M2.13, per-client AOI as of M2.14.
 *
 * Owns the per-client baseline bookkeeping that turns one authoritative world
 * into a delta-compressed binary frame for each client, using the acked-baseline
 * model described in `snapshotCodec.ts`:
 *
 *   - `encodeFor(clientId, quantized, ack…)` — filter the *quantized* shared
 *     snapshot to this client's area of interest (`net/aoi.ts`), pick that
 *     client's acked baseline from its own ring, and delta-encode against it;
 *     send a keyframe when there's no usable baseline (fresh join, ack not yet
 *     arrived, baseline aged out) or when the periodic keyframe interval elapses.
 *   - `onAck(clientId, tick)` — the client told us (piggybacked on its input
 *     stream) the newest snapshot tick it has decoded; future deltas ride on it.
 *
 * The shared world is still quantized **once** per broadcast (O(players), not the
 * old O(players × clients) clone); each client's cheap AOI subset of that shared
 * quantized snapshot is then retained as *that client's* baseline. The baseline
 * must be the filtered subset, not the full world: the codec computes removals as
 * `baseline ids − current ids`, so diffing a filtered snapshot against a full-world
 * baseline would silently diverge. With per-client rings, an entity leaving AOI is
 * an ordinary removal (clean despawn) and one re-entering is a full-entity add.
 */

import type { PlayerId } from "../sim/types";
import type { Snapshot } from "./snapshot";
import { encodeSnapshot } from "./snapshotCodec";
import { defaultAoiConfig, filterSnapshotFor, type AoiConfig } from "./aoi";

/** Quantized snapshots retained as potential baselines. Must exceed
 *  `KEYFRAME_INTERVAL` plus a comfortable RTT of broadcasts so an acked tick is
 *  always still present. ~96 @ 33Hz ≈ 2.9s. */
const RING_SIZE = 96;

/** Force a keyframe at least this often (broadcasts) per client, even on a clean
 *  link. Bounds delta-chain length and gives a periodic recovery point for a
 *  lossy transport. ~60 @ 33Hz ≈ 1.8s. */
const KEYFRAME_INTERVAL = 60;

/** Per-client baseline bookkeeping. Each client retains its own ring because, post
 *  AOI, the content it was sent differs from every other client's. */
interface ClientBaselines {
  /** This client's recent *filtered* quantized snapshots, ascending by tick. */
  ring: Snapshot[];
  /** Newest tick this client has confirmed decoding (-1 = none yet). */
  acked: number;
  /** Broadcasts since this client's last keyframe (drives the periodic keyframe). */
  sinceKeyframe: number;
  /** Player ids in this client's last-sent snapshot — for AOI-edge hysteresis. */
  prevVisible: Set<PlayerId>;
}

export class SnapshotChannel {
  private clients = new Map<PlayerId, ClientBaselines>();
  private readonly cfg: AoiConfig;

  constructor(cfg: AoiConfig = defaultAoiConfig()) {
    this.cfg = cfg;
  }

  /**
   * Encode the shared quantized snapshot for one client: AOI-filter it, then delta
   * against this client's acked (filtered) baseline, or a keyframe when none is
   * usable / the interval elapsed. The per-client input ack fields are written in
   * full (they're tiny and differ per client, so they're not part of the delta).
   */
  encodeFor(
    clientId: PlayerId,
    quantized: Snapshot,
    lastProcessedInputSeq: number,
    inputBufferDepth: number,
  ): Uint8Array {
    const cb = this.get(clientId);

    // Filter to this client's view; hysteresis uses what we sent it last broadcast.
    const filtered = filterSnapshotFor(quantized, clientId, this.cfg, cb.prevVisible);

    let baseline: Snapshot | null = null;
    if (cb.acked >= 0 && cb.sinceKeyframe < KEYFRAME_INTERVAL) {
      baseline = cb.ring.find((s) => s.tick === cb.acked) ?? null;
    }
    // Keyframe whenever no baseline was found (new client, lost ack, aged-out, or
    // the periodic interval); otherwise it's a delta and the chain grows by one.
    cb.sinceKeyframe = baseline === null ? 0 : cb.sinceKeyframe + 1;

    // Retain the filtered subset as a future baseline (NOT the ack-overlaid frame —
    // the client's retained baseline holds only entity content). Track what's now
    // visible so next frame's hysteresis can widen the box for these ids.
    cb.ring.push(filtered);
    if (cb.ring.length > RING_SIZE) cb.ring.shift();
    cb.prevVisible = new Set(filtered.players.map((p) => p.id));

    const perClient: Snapshot = { ...filtered, lastProcessedInputSeq, inputBufferDepth };
    return encodeSnapshot(perClient, baseline);
  }

  /** Record a client's snapshot ack (monotonic — a reordered older ack is
   *  ignored). The acked tick becomes the baseline for that client's next delta. */
  onAck(clientId: PlayerId, tick: number): void {
    const cb = this.get(clientId);
    if (tick > cb.acked) cb.acked = tick;
  }

  /** Forget a disconnected client. */
  remove(clientId: PlayerId): void {
    this.clients.delete(clientId);
  }

  private get(clientId: PlayerId): ClientBaselines {
    let cb = this.clients.get(clientId);
    if (!cb) {
      cb = { ring: [], acked: -1, sinceKeyframe: Number.MAX_SAFE_INTEGER, prevVisible: new Set() };
      this.clients.set(clientId, cb);
    }
    return cb;
  }
}
