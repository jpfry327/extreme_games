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
}

export class SimulatedTransport implements Transport {
  /** Live parameters — mutate in place (e.g. from the debug panel) to change
   *  conditions without reconstructing anything. */
  readonly params: NetSimParams;

  private clientHandler: SnapshotHandler | null = null;

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

  sendInput(input: SequencedInput): void {
    this.schedule(() => this.inner.sendInput(input));
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
    setTimeout(deliver, delay);
  }
}
