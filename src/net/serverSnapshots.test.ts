/**
 * SnapshotChannel — skipped-broadcast behavior (server backpressure guard).
 *
 * The server skips a client's broadcast when its TCP send buffer backs up
 * (server/index.ts MAX_BUFFERED_BYTES), which means encodeFor is simply not
 * called for some broadcasts. That must be safe for the acked-baseline delta
 * model: deltas ride only ticks the client actually decoded, an unsent frame
 * never becomes a baseline, and a lost/aged ack degrades to a keyframe.
 */

import { describe, expect, it } from "vitest";
import { WARBIRD } from "../config";
import { createPlayer } from "../sim/player";
import type { Snapshot } from "./snapshot";
import { SnapshotChannel } from "./serverSnapshots";
import { decodeSnapshot, quantizeSnapshot } from "./snapshotCodec";

const ME = "p1";

/** A quantized shared snapshot with the client's own ship at `x` — what the
 *  server hands encodeFor each broadcast. */
function makeSnap(tick: number, x: number): Snapshot {
  const p = createPlayer(ME, ME, 0, WARBIRD, x, 100);
  return quantizeSnapshot({
    tick,
    players: [p],
    projectiles: [],
    events: [],
    lastProcessedInputSeq: 0,
    inputBufferDepth: 0,
    pings: {},
  });
}

describe("SnapshotChannel — skipped broadcasts", () => {
  it("delta-encodes across skipped broadcasts against the older acked baseline", () => {
    const ch = new SnapshotChannel();
    // The client's baseline store, exactly like WebSocketTransport keeps one.
    const held = new Map<number, Snapshot>();
    const decodeAndHold = (bytes: Uint8Array): Snapshot => {
      const snap = decodeSnapshot(bytes, (tick) => held.get(tick));
      held.set(snap.tick, snap);
      return snap;
    };

    // Two broadcasts sent and decoded; the client acks the second.
    decodeAndHold(ch.encodeFor(ME, makeSnap(3, 100), 0, 0));
    const acked = decodeAndHold(ch.encodeFor(ME, makeSnap(6, 110), 0, 0));
    ch.onAck(ME, acked.tick);

    // Backpressure: broadcasts for ticks 9..18 are skipped — encodeFor is
    // simply never called for them (the guard runs before it).

    // The next sent broadcast deltas against the still-retained tick-6 baseline
    // and decodes cleanly on the client.
    const next = decodeAndHold(ch.encodeFor(ME, makeSnap(21, 160), 0, 0));
    expect(next.tick).toBe(21);
    expect(next.players[0].kinematics.x).toBeCloseTo(160, 3);
  });

  it("recovers with a keyframe when the acked tick isn't in the ring", () => {
    const ch = new SnapshotChannel();
    ch.onAck(ME, 999); // ack for a frame that was never retained (aged out)
    const bytes = ch.encodeFor(ME, makeSnap(3000, 100), 0, 0);
    // Decodes standalone — a keyframe needs no baseline lookup.
    const snap = decodeSnapshot(bytes, () => undefined);
    expect(snap.tick).toBe(3000);
    expect(snap.players[0].kinematics.x).toBeCloseTo(100, 3);
  });
});
