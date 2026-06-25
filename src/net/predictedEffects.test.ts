/**
 * M2.10 — predicted weapon effects.
 *
 * Two concerns, both about a *local* shot's effects appearing instantly instead
 * of after a server round-trip:
 *
 *  1. **Bullet wall-bounce** (investigation/regression): a local bullet bounces
 *     forever (`bounces: Infinity`), so the question is whether the Predictor's
 *     replay reflects a bounce at the leading edge *before* the server confirms
 *     it. These tests reproduce the user-reported "bounce shows up late" against
 *     the real Predictor — if they pass, local bullet bounces are already
 *     predicted and the lag is elsewhere (remote bullets, M2.8 timeline).
 *
 *  2. **Bomb explosion** (the fix): the predicted world already detonates a local
 *     bomb on a wall, but `predict()` discards the events. `drainNewExplosions()`
 *     surfaces those one-shot effects with dedup, so the explosion is instant.
 */

import { describe, expect, it } from "vitest";
import { GameMap } from "../sim/gamemap";
import { TILE_SIZE } from "../config";
import type { InputCommand, Projectile, StepContext } from "../sim/types";
import { LOCAL_PLAYER_ID, World } from "../sim/world";
import { Predictor } from "./prediction";
import type { SequencedInput } from "./protocol";

// --- fixtures ----------------------------------------------------------------

/** Open arena except the out-of-bounds border, which is solid — so a shot fired
 *  toward an edge bounces (bullets) or detonates (bombs) off the boundary. */
function openMap(): GameMap {
  return new GameMap(64, 64, new Uint8Array(64 * 64));
}

const IDLE: InputCommand = {
  rotateLeft: false,
  rotateRight: false,
  thrust: false,
  reverse: false,
  afterburner: false,
  fire: false,
  bomb: false,
};
const cmd = (over: Partial<InputCommand>): InputCommand => ({ ...IDLE, ...over });
const seqInput = (seq: number, c: InputCommand): SequencedInput => ({ seq, clientTick: seq, cmd: c });
const ctx = (c: InputCommand): StepContext => ({ inputs: new Map([[LOCAL_PLAYER_ID, c]]) });

/** Build a one-player world with the ship parked near the top wall, pointing up
 *  (default rotation 0 fires in −y), so a shot reaches the boundary in a few
 *  ticks. Returns the world. */
function parkedShooter(): World {
  const w = new World(openMap(), 1);
  const k = w.localPlayer.kinematics;
  k.x = k.prevX = 10 * TILE_SIZE;
  k.y = k.prevY = 3 * TILE_SIZE; // ~48px from the top boundary
  k.vx = k.vy = 0;
  return w;
}

/** The local-owned projectiles of a world (what a snapshot carries for seeding). */
const localProj = (w: World): Projectile[] => w.projectiles.filter((p) => p.owner === LOCAL_PLAYER_ID);

describe("M2.10 bullet wall-bounce reproduction", () => {
  // The script: fire once on tick 1, then idle. The bullet flies up, bounces off
  // the top boundary, and comes back down — all deterministic projectile physics.
  const inputAt = (t: number): InputCommand => (t === 1 ? cmd({ fire: true }) : IDLE);

  it("a SEEDED (already-acked) bullet shows its bounce at the leading edge before the server snapshot does", () => {
    // Reference 'server': fire, fly, bounce. Find the tick the bullet's vy flips
    // (the bounce) so we can snapshot strictly BEFORE it.
    const ref = parkedShooter();
    const vyAt: number[] = [];
    for (let t = 1; t <= 30; t++) {
      ref.step(ctx(inputAt(t)));
      const b = localProj(ref)[0];
      vyAt[t] = b ? b.vy : NaN;
    }
    // vy starts negative (flying up); after the bounce it's positive (coming down).
    const bounceTick = vyAt.findIndex((vy, t) => t > 1 && vy > 0);
    expect(bounceTick).toBeGreaterThan(1); // the bullet really did bounce

    // Snapshot the authoritative state a couple ticks BEFORE the bounce: the
    // bullet is still heading up (vy < 0). The client has not been told it bounces.
    const ackTick = bounceTick - 2;
    const ref2 = parkedShooter();
    let auth!: ReturnType<typeof structuredClone<typeof ref2.localPlayer>>;
    let authProj!: Projectile[];
    const unacked: SequencedInput[] = [];
    for (let t = 1; t <= bounceTick + 2; t++) {
      ref2.step(ctx(inputAt(t)));
      if (t === ackTick) {
        auth = structuredClone(ref2.localPlayer);
        authProj = structuredClone(localProj(ref2));
        expect(authProj[0].vy).toBeLessThan(0); // snapshot is PRE-bounce
      } else if (t > ackTick) {
        unacked.push(seqInput(t, inputAt(t))); // ticks the client predicts past the ack
      }
    }

    // The predictor resets to the pre-bounce snapshot and replays the un-acked
    // idle ticks. If the bounce is predicted, the leading-edge bullet has vy > 0
    // and matches the reference's current pose — without ever being told.
    const predictor = new Predictor(openMap());
    predictor.setAuthoritative(auth, authProj, ackTick);
    predictor.predict(unacked, LOCAL_PLAYER_ID);

    const predicted = predictor.predictedProjectiles.find((p) => p.kind === "bullet");
    const refNow = localProj(ref2)[0];
    expect(predicted).toBeDefined();
    expect(predicted!.vy).toBeGreaterThan(0); // predicted the bounce locally
    expect(predicted!.x).toBeCloseTo(refNow.x, 6);
    expect(predicted!.y).toBeCloseTo(refNow.y, 6);
    expect(predicted!.vy).toBeCloseTo(refNow.vy, 6);
  });

  it("the bullet is present in the predicted set on every frame across the ack handoff (no disappear/reappear)", () => {
    // Walk the ack forward one broadcast at a time, as the client would, and assert
    // the bullet never vanishes from predictedProjectiles between fire and lifetime.
    const ref = parkedShooter();
    const stream: InputCommand[] = [];
    const TOTAL = 40; // < bullet lifetime (65t)
    for (let t = 1; t <= TOTAL; t++) {
      stream[t] = inputAt(t);
      ref.step(ctx(stream[t]));
    }

    const predictor = new Predictor(openMap());
    // For each ack point, rebuild the authoritative state from a fresh reference
    // run up to ackTick, then predict the tail — exactly the client's per-snapshot
    // cycle — and assert the bullet is present at the leading edge.
    for (let ackTick = 2; ackTick <= TOTAL; ackTick++) {
      const r = parkedShooter();
      for (let t = 1; t <= ackTick; t++) r.step(ctx(stream[t]));
      const auth = structuredClone(r.localPlayer);
      const authProj = structuredClone(localProj(r));
      const unacked: SequencedInput[] = [];
      for (let t = ackTick + 1; t <= TOTAL; t++) unacked.push(seqInput(t, stream[t]));

      predictor.setAuthoritative(auth, authProj, ackTick);
      predictor.predict(unacked, LOCAL_PLAYER_ID);
      const hasBullet = predictor.predictedProjectiles.some((p) => p.kind === "bullet");
      expect(hasBullet, `bullet missing at ackTick=${ackTick}`).toBe(true);
    }
  });
});

describe("M2.10 predicted bomb explosion", () => {
  const inputAt = (t: number): InputCommand => (t === 1 ? cmd({ bomb: true }) : IDLE);

  it("surfaces a local bomb's wall detonation once, at the predicted position", () => {
    // Reference: fire a bomb up into the top wall; bombs don't bounce, so it
    // detonates. Find the detonation tick + position.
    const ref = parkedShooter();
    let boomTick = -1;
    let boomX = 0;
    let boomY = 0;
    for (let t = 1; t <= 40; t++) {
      ref.step(ctx(inputAt(t)));
      const boom = ref.events.find((e) => e.type === "bombExploded");
      if (boom && boom.type === "bombExploded") {
        boomTick = t;
        boomX = boom.x;
        boomY = boom.y;
        break;
      }
    }
    expect(boomTick).toBeGreaterThan(1);

    // Client: ack BEFORE the detonation, predict the tail. The bomb detonates in
    // the predicted world; drainNewExplosions surfaces it once.
    const ackTick = boomTick - 3;
    const r = parkedShooter();
    for (let t = 1; t <= ackTick; t++) r.step(ctx(inputAt(t)));
    const auth = structuredClone(r.localPlayer);
    const authProj = structuredClone(localProj(r));
    const unacked: SequencedInput[] = [];
    for (let t = ackTick + 1; t <= boomTick + 3; t++) unacked.push(seqInput(t, inputAt(t)));

    const predictor = new Predictor(openMap());
    predictor.setAuthoritative(auth, authProj, ackTick);
    predictor.predict(unacked, LOCAL_PLAYER_ID);

    const booms = predictor.drainNewExplosions();
    expect(booms).toHaveLength(1);
    expect(booms[0].x).toBeCloseTo(boomX, 6);
    expect(booms[0].y).toBeCloseTo(boomY, 6);
  });

  it("does not re-emit the same explosion on subsequent predicts (dedup)", () => {
    const ackTick = 3;
    const r = parkedShooter();
    for (let t = 1; t <= ackTick; t++) r.step(ctx(inputAt(t)));
    const auth = structuredClone(r.localPlayer);
    const authProj = structuredClone(localProj(r));
    const unacked: SequencedInput[] = [];
    for (let t = ackTick + 1; t <= 30; t++) unacked.push(seqInput(t, inputAt(t)));

    const predictor = new Predictor(openMap());
    predictor.setAuthoritative(auth, authProj, ackTick);

    // Predict several times (as the client does per frame) from the same ack.
    predictor.predict(unacked, LOCAL_PLAYER_ID);
    const first = predictor.drainNewExplosions();
    predictor.predict(unacked, LOCAL_PLAYER_ID);
    const second = predictor.drainNewExplosions();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0); // already emitted — not shown twice
  });
});
