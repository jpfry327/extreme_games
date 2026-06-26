/**
 * Snapshot serialization — the Layer A "wire format" between server and client.
 *
 * A Snapshot is the serializable subset of World: players, projectiles, and the
 * tick counter. The architecture (§5) keeps this separate from GameEvent[]
 * (transient "what happened" records); for the in-process loopback of M2.0 we
 * include events in the snapshot as a convenience — a real WebSocket protocol
 * would send them as a separate channel (M2.1).
 *
 * `serializeSnapshotFor(world, playerId)` builds a deep copy of the world for
 * one client, filtered to that client's area of interest (M2.14, `net/aoi.ts`).
 *
 * `applySnapshot(clientWorld, snap)` overwrites the client world entirely. The
 * client world is NEVER stepped — it is purely driven by these snapshots.
 */

import type { GameEvent, Player, PlayerId, Projectile } from "../sim/types";
import type { World } from "../sim/world";
import { defaultAoiConfig, filterSnapshotFor } from "./aoi";

/** The per-recipient input ack the server stamps onto each snapshot (M2.3).
 *  Kept as a small struct so `serializeSnapshotFor` callers pass it explicitly
 *  rather than reaching into server-only state. */
export interface InputAck {
  /** The highest input `seq` from the recipient the server has processed. The
   *  client drops acked inputs and (M2.4) replays the rest from here. */
  lastProcessedInputSeq: number;
  /** Un-consumed commands queued server-side for the recipient. A debug-HUD
   *  health signal: a deep buffer = added latency, an empty one = starvation
   *  (the server is repeating their last command). */
  inputBufferDepth: number;
}

export interface Snapshot {
  tick: number;
  players: Player[];
  projectiles: Projectile[];
  /** Events from the ticked step, piggybacked on the snapshot for the loopback
   *  case. A real network protocol separates these (architecture §5). */
  events: GameEvent[];
  /** M2.3 ack — see InputAck. The data plane for prediction (M2.4); the client
   *  only inspects it (debug overlay) for now, it corrects nothing yet. */
  lastProcessedInputSeq: number;
  inputBufferDepth: number;
  /** M2.7 — server-measured round-trip time (ms) for every player, keyed by id.
   *  Net metadata, not sim state, so it rides on the snapshot alongside the ack
   *  fields rather than polluting the pure `Player` entity. The client shows it
   *  on debug-quality nametags. A player with no measurement yet (e.g. the bot,
   *  or a just-joined socket before its first pong) is simply absent. */
  pings: Record<PlayerId, number>;
}

/**
 * Produce a deep-copied snapshot for the given player. `structuredClone`
 * simulates the serialize→deserialize round-trip that a real wire would do,
 * ensuring neither side can alias into the other's state.
 *
 * `ack` is the recipient's input-processing state (M2.3); it's per-client, like
 * the snapshot itself, so it's passed in rather than read from the shared world.
 * `pings` is the server's RTT-by-player map (M2.7) — global, not per-recipient,
 * so the same object is fine for every client; defaults to empty for transports
 * with no measurement (the in-process loopback).
 */
export function serializeSnapshotFor(
  world: World,
  playerId: PlayerId,
  ack: InputAck,
  pings: Record<PlayerId, number> = {},
): Snapshot {
  const full: Snapshot = {
    tick: world.tick,
    players: [...world.players.values()],
    projectiles: world.projectiles,
    events: world.events,
    lastProcessedInputSeq: ack.lastProcessedInputSeq,
    inputBufferDepth: ack.inputBufferDepth,
    pings,
  };
  // AOI cull (M2.14), then deep-copy only what's actually sent. No hysteresis
  // state on the loopback (it has no per-client baseline ring), so a boundary
  // entity could flicker — but loopback is zero-latency and the interpolator's
  // join/respawn pin absorbs a clean re-entry, so it's cosmetic. The WebSocket
  // path (SnapshotChannel) threads hysteresis where it actually matters.
  const filtered = filterSnapshotFor(full, playerId, defaultAoiConfig());
  return structuredClone(filtered);
}

/**
 * Overwrite the client world with the snapshot's data. Clears all prior state
 * (players, projectiles) and replaces it wholesale — no diffing, no merging.
 * Events are pushed onto the client world so the renderer and kill-feed can
 * drain them just as they did before the network seam existed.
 */
export function applySnapshot(clientWorld: World, snap: Snapshot): void {
  clientWorld.tick = snap.tick;

  clientWorld.players.clear();
  for (const p of snap.players) {
    clientWorld.players.set(p.id, p);
  }

  clientWorld.projectiles.length = 0;
  for (const proj of snap.projectiles) {
    clientWorld.projectiles.push(proj);
  }

  clientWorld.events.length = 0;
  for (const e of snap.events) {
    clientWorld.events.push(e);
  }
}
