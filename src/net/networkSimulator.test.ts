/**
 * SimulatedTransport TCP-stall mode.
 *
 * The stall knob emulates WebSocket-over-TCP head-of-line blocking (a retransmit
 * or a buffering proxy): every `stallEveryMs`, everything scheduled to arrive
 * during the next `stallMs` is held and delivered together at the window's end,
 * in order — nothing dropped, nothing reordered. These tests pin that shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SimulatedTransport, type NetSimParams } from "./networkSimulator";
import type { SequencedInput } from "./protocol";
import type { SnapshotHandler, Transport } from "./transport";

class StubTransport implements Transport {
  sent: { seqs: number[]; at: number }[] = [];
  snapshotHandler: SnapshotHandler | null = null;
  start(): void {}
  sendInput(inputs: readonly SequencedInput[]): void {
    this.sent.push({ seqs: inputs.map((i) => i.seq), at: Date.now() });
  }
  setSnapshotHandler(cb: SnapshotHandler): void {
    this.snapshotHandler = cb;
  }
  dispose(): void {}
}

function input(seq: number): SequencedInput {
  return { seq, clientTick: seq, cmd: {} as SequencedInput["cmd"] };
}

function params(overrides: Partial<NetSimParams>): NetSimParams {
  return {
    enabled: true,
    latencyMs: 0,
    jitterMs: 0,
    lossPct: 0,
    stallMs: 0,
    stallEveryMs: 0,
    ...overrides,
  };
}

describe("SimulatedTransport stall mode", () => {
  let inner: StubTransport;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(0);
    inner = new StubTransport();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stallEveryMs 0 leaves timing untouched", () => {
    const t = new SimulatedTransport(inner, params({ latencyMs: 50, stallMs: 300 }));
    t.sendInput([input(1)]);
    vi.advanceTimersByTime(49);
    expect(inner.sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(inner.sent).toEqual([{ seqs: [1], at: 50 }]);
  });

  it("holds frames scheduled inside a stall window and delivers them at its end, in order", () => {
    // Anchor = 0, so windows are [0,300), [1000,1300), ...
    const t = new SimulatedTransport(inner, params({ stallMs: 300, stallEveryMs: 1000 }));

    vi.advanceTimersByTime(50);
    t.sendInput([input(1)]);
    vi.advanceTimersByTime(50);
    t.sendInput([input(2)]);
    vi.advanceTimersByTime(50);
    t.sendInput([input(3)]);

    // Nothing arrives while the window is open.
    vi.advanceTimersByTime(149); // now = 299
    expect(inner.sent).toHaveLength(0);

    // All three arrive together at the window end, FIFO (spread by the 1ms
    // whole-millisecond ordering clamp — browsers truncate sub-ms delays).
    vi.advanceTimersByTime(5); // past 300 + the per-frame FIFO spacing
    expect(inner.sent.map((s) => s.seqs[0])).toEqual([1, 2, 3]);
    for (const s of inner.sent) expect(s.at).toBeGreaterThanOrEqual(300);
  });

  it("leaves frames outside the stall window untouched", () => {
    const t = new SimulatedTransport(inner, params({ stallMs: 300, stallEveryMs: 1000 }));
    vi.advanceTimersByTime(500); // between windows
    t.sendInput([input(1)]);
    vi.advanceTimersByTime(0);
    expect(inner.sent).toEqual([{ seqs: [1], at: 500 }]);
  });

  it("stalls the downstream (snapshot) direction too", () => {
    const t = new SimulatedTransport(inner, params({ stallMs: 300, stallEveryMs: 1000 }));
    const arrived: number[] = [];
    t.setSnapshotHandler((snap) => arrived.push(snap.tick));
    t.start();

    vi.advanceTimersByTime(100); // inside [0,300)
    inner.snapshotHandler?.({ tick: 7 } as Parameters<SnapshotHandler>[0]);
    vi.advanceTimersByTime(150);
    expect(arrived).toEqual([]);
    vi.advanceTimersByTime(60);
    expect(arrived).toEqual([7]);
  });
});
