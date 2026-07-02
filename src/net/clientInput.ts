/**
 * Client-side input sequencing — M2.3.
 *
 * The renderer runs at the display's frame rate (~60fps) but the sim advances in
 * fixed 10ms ticks (100Hz). M2.3 decouples input from the render frame: this
 * manager runs the *same* fixed-timestep accumulator as `FixedLoop`, emitting
 * exactly **one command per sim tick** — sometimes 0, 1, or 2 per render frame —
 * so the server receives a continuous, gap-free command stream.
 *
 * Each command is stamped with a monotonic `seq` and kept in an **un-acked ring
 * buffer**. When a snapshot acks a `seq`, every command up to it is dropped. The
 * surviving (un-acked) commands are exactly what M2.4 will replay on top of the
 * authoritative state to re-derive the local player's predicted "now" — so this
 * buffer is the load-bearing piece of the whole prediction story, built here
 * with no behavioral change yet.
 *
 * Like `FixedLoop`, all catch-up ticks within one render frame share that
 * frame's single keyboard sample: the human pressed keys once, and every tick
 * the frame covers inherits that intent.
 */

import { INPUT, TICK_DT } from "../config";
import type { InputCommand } from "../sim/types";
import type { SequencedInput } from "./protocol";

/** An un-acked command plus the local time it was sent, for RTT estimation. */
interface PendingInput extends SequencedInput {
  /** `performance.now()` when produced/sent. */
  sentAt: number;
}

/** Same spiral-of-death clamp as FixedLoop: never produce more than 0.25s
 *  (25 ticks) of input in one frame after a stall / backgrounded tab. */
const MAX_FRAME = 0.25;

/** EMA weight for the RTT readout — smooth enough to read, responsive enough to
 *  track a changing link. */
const RTT_SMOOTH = 0.2;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class ClientInputManager {
  private accumulator = 0;
  /** The client's sim-tick counter; also the source of `seq` (1:1 in M2.3). */
  private clientTick = 0;
  /** Un-acked commands, ascending by `seq` — the M2.4 replay buffer. */
  private pending: PendingInput[] = [];
  /** Smoothed server-reported input-queue depth (ticks), fed one report per
   *  snapshot by `observeServerDepth`. `null` until the first report — pacing
   *  stays neutral until the server has told us anything (M2.17 Phase C). */
  private depthEwma: number | null = null;

  /** Highest `seq` the server has acked. */
  lastAckedSeq = 0;
  /** Smoothed round-trip estimate (ms). NOTE: this is *ack* RTT — it includes
   *  the time the command waited in the server's input queue and the ~50ms
   *  snapshot batching interval, so it reads higher than a raw network ping.
   *  Good enough for the debug overlay (its job is to show acks flowing); a
   *  dedicated ping/pong can refine it later. */
  rttMs = 0;

  /**
   * Advance the input clock by real `dtSeconds` and produce one sequenced
   * command per elapsed tick, all stamped with this frame's `sample`. Returns
   * the new commands (already buffered) for the caller to send.
   */
  produce(dtSeconds: number, sample: InputCommand, nowMs: number): SequencedInput[] {
    // Closed-loop pacing (M2.17 Phase C): scale how fast wall time turns into
    // ticks so the server-side queue holds ~targetDepthTicks instead of a
    // standing backlog (each tick of which is 10ms of added input latency) or
    // starvation (repeat-last padding → mispredictions). Bounded to ±2%, so
    // the production model — one seq per tick — is untouched; only the clock
    // mapping breathes. `MAX_BUFFERED` in serverInput.ts stays as the safety net.
    this.accumulator += Math.min(dtSeconds, MAX_FRAME) * (1 + this.paceScale);

    const out: SequencedInput[] = [];
    while (this.accumulator >= TICK_DT) {
      this.clientTick++;
      // seq === clientTick in M2.3 (one command per tick); see SequencedInput.
      const input: SequencedInput = {
        seq: this.clientTick,
        clientTick: this.clientTick,
        cmd: sample,
      };
      this.pending.push({ ...input, sentAt: nowMs });
      out.push(input);
      this.accumulator -= TICK_DT;
    }
    return out;
  }

  /** Apply a server ack: update RTT from the matching command's send time, then
   *  drop every command at or below `seq` (they're now authoritative). */
  ack(seq: number, nowMs: number): void {
    if (seq <= this.lastAckedSeq) return; // stale / out-of-order snapshot

    const matched = this.pending.find((p) => p.seq === seq);
    if (matched) {
      const sample = nowMs - matched.sentAt;
      this.rttMs = this.rttMs === 0 ? sample : lerp(this.rttMs, sample, RTT_SMOOTH);
    }
    this.lastAckedSeq = seq;
    this.pending = this.pending.filter((p) => p.seq > seq);
  }

  /** Feed one server-reported input-queue depth (from a snapshot's
   *  `inputBufferDepth`) into the pacing loop's EWMA. The raw value oscillates
   *  tick-to-tick with delivery clumping; smoothing (~1s at the ~50Hz snapshot
   *  rate) keeps the controller acting on the *standing* depth, not the noise. */
  observeServerDepth(depth: number): void {
    if (!INPUT.pacing.enabled) return;
    this.depthEwma =
      this.depthEwma === null ? depth : lerp(this.depthEwma, depth, INPUT.pacing.depthSmooth);
  }

  /** The live pacing adjustment, as a signed fraction of real time (+ = produce
   *  faster). Proportional on the smoothed depth error, bounded to ±maxScale.
   *  0 while pacing is disabled or before the first depth report. */
  get paceScale(): number {
    if (!INPUT.pacing.enabled || this.depthEwma === null) return 0;
    const error = INPUT.pacing.targetDepthTicks - this.depthEwma;
    return clamp(error * INPUT.pacing.gainPerTick, -INPUT.pacing.maxScale, INPUT.pacing.maxScale);
  }

  /** Sub-tick render fraction — how far real time has advanced past the last
   *  produced tick, in [0,1) after `produce()`. Passing this to the renderer as
   *  the lerp `alpha` (M2.17 Phase A) is what makes the *predicted* local ship —
   *  which only advances in whole 10ms steps — move smoothly at any frame rate:
   *  at 60fps a frame covers alternately 1 or 2 ticks, so with a hard-coded
   *  alpha the camera advanced +10ms, +20ms, +10ms… on a uniform ~16.7ms frame
   *  cadence and the whole scene juddered whenever the player moved. The trade:
   *  the own ship renders up to 10ms in the past (standard fixed-timestep
   *  interpolation — the same model M0's FixedLoop used). Baked view entities
   *  (interpolated remotes, remote projectiles) set `prev* === current`, so a
   *  non-1 alpha is a no-op for them by construction. */
  get alpha(): number {
    return this.accumulator / TICK_DT;
  }

  /** The client's current sim-tick count (debug overlay: client vs server tick). */
  get clientTickCount(): number {
    return this.clientTick;
  }

  /** Un-acked command count held client-side (debug overlay). */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Un-acked commands, ascending by `seq` — the M2.4 replay buffer. */
  get unacked(): readonly SequencedInput[] {
    return this.pending;
  }
}
