import { describe, expect, it } from "vitest";
import { TICK_DT } from "../config";
import type { InputCommand } from "../sim/types";
import { ClientInputManager } from "./clientInput";

const IDLE: InputCommand = {
  rotateLeft: false,
  rotateRight: false,
  thrust: false,
  reverse: false,
  afterburner: false,
  fire: false,
  bomb: false,
};

describe("ClientInputManager", () => {
  it("produces one command per elapsed sim tick, stamped with monotonic seq", () => {
    const mgr = new ClientInputManager();
    // A render frame covering ~3.x ticks emits exactly 3 commands.
    const out = mgr.produce(TICK_DT * 3.5, IDLE, 0);
    expect(out.map((i) => i.seq)).toEqual([1, 2, 3]);
    expect(out.every((i) => i.clientTick === i.seq)).toBe(true);
    expect(mgr.clientTickCount).toBe(3);
  });

  it("carries the sub-tick remainder into the next frame (no lost time)", () => {
    const mgr = new ClientInputManager();
    expect(mgr.produce(TICK_DT * 0.6, IDLE, 0)).toHaveLength(0); // 0.6 tick — nothing yet
    expect(mgr.produce(TICK_DT * 0.6, IDLE, 0)).toHaveLength(1); // 1.2 total — one fires
  });

  it("clamps a huge frame to avoid a spiral of death", () => {
    const mgr = new ClientInputManager();
    // 10s elapsed would be 1000 ticks; clamp at 0.25s ≈ 25 (exact count varies
    // by a float tick at the boundary, like FixedLoop — so assert the clamp,
    // not an exact integer).
    const out = mgr.produce(10, IDLE, 0);
    expect(out.length).toBeGreaterThan(20);
    expect(out.length).toBeLessThanOrEqual(25);
  });

  it("holds produced commands as un-acked until the server acks them", () => {
    const mgr = new ClientInputManager();
    // 3.5 ticks → 3 commands (0.5-tick margin keeps this off the float boundary).
    mgr.produce(TICK_DT * 3.5, IDLE, 0);
    expect(mgr.pendingCount).toBe(3);

    mgr.ack(2, 0); // server processed up to seq 2
    expect(mgr.lastAckedSeq).toBe(2);
    expect(mgr.pendingCount).toBe(1); // only seq 3 remains (the M2.4 replay set)
  });

  it("ignores a stale (out-of-order) ack", () => {
    const mgr = new ClientInputManager();
    mgr.produce(TICK_DT * 3.5, IDLE, 0);
    mgr.ack(2, 0);
    mgr.ack(1, 0); // older snapshot arriving late
    expect(mgr.lastAckedSeq).toBe(2);
    expect(mgr.pendingCount).toBe(1);
  });

  it("exposes the sub-tick remainder as the render alpha, always in [0,1)", () => {
    const mgr = new ClientInputManager();
    expect(mgr.alpha).toBe(0);
    mgr.produce(TICK_DT * 0.6, IDLE, 0); // no tick fires — 0.6 of one remains
    expect(mgr.alpha).toBeCloseTo(0.6);
    mgr.produce(TICK_DT * 1.7, IDLE, 0); // 2.3 total → 2 fire, 0.3 remains
    expect(mgr.alpha).toBeCloseTo(0.3);
    expect(mgr.alpha).toBeGreaterThanOrEqual(0);
    expect(mgr.alpha).toBeLessThan(1);
  });

  it("estimates RTT from the acked command's send time", () => {
    const mgr = new ClientInputManager();
    mgr.produce(TICK_DT, IDLE, 1000); // seq 1 sent at t=1000
    mgr.ack(1, 1080); // acked at t=1080
    expect(mgr.rttMs).toBeCloseTo(80);
  });
});
