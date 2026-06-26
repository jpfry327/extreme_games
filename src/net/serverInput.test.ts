import { describe, expect, it } from "vitest";
import type { InputCommand } from "../sim/types";
import type { SequencedInput } from "./protocol";
import { ServerInputBuffer } from "./serverInput";

// --- fixtures ----------------------------------------------------------------

const IDLE: InputCommand = {
  rotateLeft: false,
  rotateRight: false,
  thrust: false,
  reverse: false,
  afterburner: false,
  fire: false,
  bomb: false,
};

/** A command that's distinguishable by `seq` via the rotateLeft flag toggling,
 *  but mostly we assert on identity by tagging thrust to the seq's parity isn't
 *  needed — we compare the returned cmd object reference / fields per test. */
function input(seq: number, cmd: Partial<InputCommand> = {}): SequencedInput {
  return { seq, clientTick: seq, cmd: { ...IDLE, ...cmd } };
}

const P = "p1";

// --- tests -------------------------------------------------------------------

describe("ServerInputBuffer", () => {
  it("consumes one command per tick in seq order", () => {
    const buf = new ServerInputBuffer();
    buf.push(P, input(1, { thrust: true }));
    buf.push(P, input(2, { fire: true }));
    buf.push(P, input(3, { bomb: true }));

    expect(buf.next(P).thrust).toBe(true);
    expect(buf.next(P).fire).toBe(true);
    expect(buf.next(P).bomb).toBe(true);
  });

  it("bounds the standing depth, dropping oldest and keeping newest (M2.11)", () => {
    const buf = new ServerInputBuffer();
    // Push far more than the jitter-buffer cap (MAX_BUFFERED = 6) without consuming.
    for (let seq = 1; seq <= 20; seq++) buf.push(P, input(seq, { thrust: true }));

    // Depth is capped, not 20 — no unbounded standing backlog.
    expect(buf.depth(P)).toBeLessThanOrEqual(6);

    // The retained commands are the newest: the first consumed seq is well past 1.
    buf.next(P);
    expect(buf.ack(P)).toBe(20 - 6 + 1); // oldest kept = seq 15
  });

  it("acks only the highest *consumed* seq, advancing one per tick", () => {
    const buf = new ServerInputBuffer();
    buf.push(P, input(1));
    buf.push(P, input(2));

    expect(buf.ack(P)).toBe(0); // nothing consumed yet
    buf.next(P);
    expect(buf.ack(P)).toBe(1);
    buf.next(P);
    expect(buf.ack(P)).toBe(2);
  });

  it("repeats the last command when the queue is empty (no idle snap)", () => {
    const buf = new ServerInputBuffer();
    buf.push(P, input(5, { thrust: true }));

    expect(buf.next(P).thrust).toBe(true); // real command
    // Gap: no seq 6 yet — repeat the held thrust rather than idling.
    expect(buf.next(P).thrust).toBe(true);
    expect(buf.next(P).thrust).toBe(true);
    // The ack does NOT advance on a repeat — only seq 5 was genuinely processed.
    expect(buf.ack(P)).toBe(5);
  });

  it("idles a player who has never sent a command", () => {
    const buf = new ServerInputBuffer();
    expect(buf.next(P)).toEqual(IDLE);
    expect(buf.ack(P)).toBe(0);
  });

  it("drops stale / duplicate seqs at or below the last processed", () => {
    const buf = new ServerInputBuffer();
    buf.push(P, input(1, { thrust: true }));
    buf.next(P); // processes seq 1

    buf.push(P, input(1, { fire: true })); // duplicate of an already-processed seq
    buf.push(P, input(2, { bomb: true }));
    // seq 1 dup ignored; next real command is seq 2.
    expect(buf.next(P).bomb).toBe(true);
  });

  it("orders out-of-order arrivals by seq before consuming", () => {
    const buf = new ServerInputBuffer();
    buf.push(P, input(2, { fire: true }));
    buf.push(P, input(1, { thrust: true })); // arrived late

    expect(buf.next(P).thrust).toBe(true); // seq 1 first despite late arrival
    expect(buf.next(P).fire).toBe(true);
  });

  it("reports queue depth and keeps players independent", () => {
    const buf = new ServerInputBuffer();
    buf.push(P, input(1));
    buf.push(P, input(2));
    buf.push("p2", input(1));

    expect(buf.depth(P)).toBe(2);
    expect(buf.depth("p2")).toBe(1);

    buf.next(P);
    expect(buf.depth(P)).toBe(1);
    expect(buf.depth("p2")).toBe(1); // untouched
  });

  it("forgets a player's queue on remove", () => {
    const buf = new ServerInputBuffer();
    buf.push(P, input(9, { thrust: true }));
    buf.next(P);
    expect(buf.ack(P)).toBe(9);

    buf.remove(P);
    expect(buf.ack(P)).toBe(0); // fresh queue
    expect(buf.depth(P)).toBe(0);
  });
});
