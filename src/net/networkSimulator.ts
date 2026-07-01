/**
 * In-transport network simulator — M2.5.
 *
 * Localhost (and the in-process loopback) has zero latency, zero jitter, and
 * zero loss, so prediction/interpolation can look perfect while still being
 * subtly wrong — the bugs only show up on a real link. This wraps any
 * `Transport` and injects added latency, jitter, and packet loss in **both**
 * directions (client→server inputs and server→client snapshots), so those
 * conditions are reproducible on demand from the debug panel.
 *
 * It is a decorator: it implements `Transport` and forwards to an inner
 * transport, scheduling each call through `setTimeout`. Because it only sits on
 * the wire, the rest of the client is identical whether or not it's present —
 * swapping it in is a one-line change in main.ts, exactly like swapping
 * loopback↔WebSocket.
 *
 * `Math.random()` here is fine — the golden rule (no `Math.random()`) is about
 * `sim/` determinism; this is the transport, deliberately non-deterministic.
 *
 * Note: the inner transport's `onConnected` handshake is intentionally *not*
 * simulated (it's set directly on the inner WebSocketTransport in main.ts), so a
 * join always completes promptly even with heavy simulated loss.
 */

import type { SequencedInput } from "./protocol";
import type { Snapshot } from "./snapshot";
import type { SnapshotHandler, Transport } from "./transport";

/** Live-mutable simulator parameters. The debug panel writes straight to the
 *  instance held on `SimulatedTransport.params`. */
export interface NetSimParams {
  enabled: boolean;
  /** One-way base added latency, ms, applied to each direction independently. */
  latencyMs: number;
  /** Uniform ± jitter, ms, added to each packet's latency. Large enough jitter
   *  reorders packets — the seq-ordered server buffer and the client's stale-tick
   *  drop both tolerate that. */
  jitterMs: number;
  /** Per-packet drop chance, percent (0–100), applied to each direction. */
  lossPct: number;
  /** TCP-stall simulation: every `stallEveryMs`, hold *all* frames for `stallMs`
   *  and then deliver them together in order — the head-of-line-blocking
   *  signature of a WebSocket riding a TCP retransmit or a buffering proxy
   *  (the Railway failure mode). 0 for either = off. Unlike `lossPct`, nothing
   *  is dropped and nothing is reordered: TCP delivers everything, just late
   *  and in a burst. */
  stallMs: number;
  /** Stall period, ms (a `stallMs` hold begins at each multiple). 0 = off. */
  stallEveryMs: number;
}

export class SimulatedTransport implements Transport {
  /** Live parameters — mutate in place (e.g. from the debug panel) to change
   *  conditions without reconstructing anything. */
  readonly params: NetSimParams;

  private clientHandler: SnapshotHandler | null = null;

  /** Phase anchor for the stall windows, so "every N ms" is stable regardless of
   *  when packets happen to be scheduled. */
  private readonly stallAnchorMs = Date.now();
  /** Absolute delivery time of the last packet scheduled while stall mode is
   *  active — enforces FIFO with whole-ms spacing. Browsers coerce a setTimeout
   *  delay to an integer (long), so sub-ms sequencing is truncated away and a
   *  burst's delivery order would inherit each packet's fractional schedule
   *  time, i.e. scramble — and TCP never reorders. */
  private lastStallTargetMs = 0;

  constructor(
    private readonly inner: Transport,
    params: NetSimParams,
  ) {
    // Copy so the shared NET.netSim default object is never mutated by the panel.
    this.params = { ...params };
  }

  start(): void {
    // Intercept the inner transport's snapshots so we can delay/drop them on the
    // way up to our client handler.
    this.inner.setSnapshotHandler((snap) => this.deliverDown(snap));
    this.inner.start();
  }

  sendInput(inputs: readonly SequencedInput[]): void {
    // Schedule the whole batch as a unit: a simulated drop/jitter hits the
    // datagram as a whole, which is exactly the loss the M2.15 redundancy is
    // designed to survive.
    this.schedule(() => this.inner.sendInput(inputs));
  }

  setSnapshotHandler(cb: SnapshotHandler): void {
    this.clientHandler = cb;
  }

  dispose(): void {
    this.inner.dispose();
  }

  /** Server→client: a snapshot arrived from the inner transport. */
  private deliverDown(snap: Snapshot): void {
    this.schedule(() => this.clientHandler?.(snap));
  }

  /** Drop / delay one packet according to the live params, in either direction.
   *  When disabled, deliver synchronously so behavior is byte-identical to using
   *  the inner transport directly. */
  private schedule(deliver: () => void): void {
    if (!this.params.enabled) {
      deliver();
      return;
    }
    if (Math.random() * 100 < this.params.lossPct) return; // dropped on the wire
    const jitter = (Math.random() * 2 - 1) * this.params.jitterMs;
    const delay = Math.max(0, this.params.latencyMs + jitter);
    setTimeout(deliver, this.stalledDelay(delay));
  }

  /** If the packet's normal delivery time lands inside a stall window, push it
   *  to the window's end; otherwise leave it untouched. Either way, never let
   *  it deliver before an earlier-scheduled packet (whole-ms FIFO clamp — see
   *  `lastStallTargetMs`), so a released burst drains in order. */
  private stalledDelay(delayMs: number): number {
    const { stallMs, stallEveryMs } = this.params;
    if (stallMs <= 0 || stallEveryMs <= 0) return delayMs;
    const now = Date.now();
    const arrival = now + delayMs;
    const sinceAnchor = arrival - this.stallAnchorMs;
    const windowStart = this.stallAnchorMs + Math.floor(sinceAnchor / stallEveryMs) * stallEveryMs;
    let target = arrival < windowStart + stallMs ? windowStart + stallMs : arrival;
    target = Math.max(target, this.lastStallTargetMs + 1);
    this.lastStallTargetMs = target;
    return target - now;
  }
}
