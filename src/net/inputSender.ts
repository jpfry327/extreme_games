/**
 * Upstream input batching & loss tolerance — M2.15.
 *
 * The client produces exactly one `SequencedInput` per 10ms sim tick (M2.3,
 * `ClientInputManager`). Sending each as its own framed message is ~100 msg/s of
 * tiny datagrams, and a single dropped one leaves a server-side gap that the
 * server fills with repeat-last until the next input lands.
 *
 * This sender sits between `ClientInputManager` and the `Transport`: it paces the
 * send to ~`sendIntervalMs` (≈ one datagram per render frame at the default
 * ~16ms) and includes the newest few **un-acked** inputs in each datagram for
 * redundancy. A dropped datagram is then covered by the next without a
 * round-trip, and the server dedups the overlap by `seq` (so re-sends are free).
 *
 * Why a separate object (not folded into the transport): the loopback transport
 * must stay zero-latency/immediate, and keeping the pacing+redundancy policy here
 * makes it unit-testable in isolation. The redundancy window falls straight out
 * of `ClientInputManager.unacked` — newly produced inputs are pushed there before
 * the flush and acked ones are dropped, so the newest N un-acked are exactly
 * "this frame's new commands plus a few recent ones." No extra buffer.
 *
 * Determinism is untouched: production still happens every tick, the same seqs in
 * the same order; only the wire packaging changes.
 */

import { INPUT } from "../config";
import type { SequencedInput } from "./protocol";

/** EMA weight for the send-rate readout — smooth enough to read on the overlay. */
const RATE_SMOOTH = 0.1;

export class InputSender {
  private accumulator = 0;
  /** Highest `seq` already flushed, so a flush only fires when there's a genuinely
   *  new tick-command since the last datagram (an idle/backgrounded tab produces
   *  nothing, so nothing is sent). */
  private lastSentSeq = 0;

  /** Size of the last datagram sent (inputs). 0 until the first flush. */
  lastBatchSize = 0;
  /** Smoothed datagrams-per-second, for the overlay. */
  sendRateHz = 0;
  private lastSentAtMs = -1;

  constructor(
    private readonly sendIntervalMs = INPUT.sendIntervalMs,
    private readonly redundantTicks = INPUT.redundantTicks,
  ) {}

  /** Configured redundancy depth (overlay readout). */
  get redundancyDepth(): number {
    return this.redundantTicks;
  }

  /**
   * Advance the send clock by real `dtSeconds`. When at least `sendIntervalMs`
   * has elapsed and `unacked` holds a `seq` newer than the last flush, assemble a
   * datagram of the newest `redundantTicks` un-acked commands and hand it to
   * `send`. `unacked` is the client's ascending-by-seq un-acked ring
   * (`ClientInputManager.unacked`).
   */
  update(
    dtSeconds: number,
    unacked: readonly SequencedInput[],
    nowMs: number,
    send: (batch: SequencedInput[]) => void,
  ): void {
    this.accumulator += dtSeconds * 1000;
    if (this.accumulator < this.sendIntervalMs) return;

    const newest = unacked.length > 0 ? unacked[unacked.length - 1].seq : 0;
    if (newest <= this.lastSentSeq) {
      // Nothing new to send. Don't let the accumulator grow unbounded while idle;
      // pin it just below the interval so the next new input flushes promptly.
      this.accumulator = this.sendIntervalMs;
      return;
    }

    // Subtract whole intervals so a long frame doesn't burst multiple sends, but
    // the cadence stays anchored to real time.
    this.accumulator -= this.sendIntervalMs;
    if (this.accumulator >= this.sendIntervalMs) this.accumulator = this.sendIntervalMs;

    const batch =
      unacked.length > this.redundantTicks
        ? unacked.slice(unacked.length - this.redundantTicks)
        : unacked.slice();

    this.lastSentSeq = newest;
    this.lastBatchSize = batch.length;
    if (this.lastSentAtMs >= 0) {
      const gapMs = nowMs - this.lastSentAtMs;
      if (gapMs > 0) {
        const instHz = 1000 / gapMs;
        this.sendRateHz =
          this.sendRateHz === 0 ? instHz : this.sendRateHz + (instHz - this.sendRateHz) * RATE_SMOOTH;
      }
    }
    this.lastSentAtMs = nowMs;

    send(batch);
  }
}
