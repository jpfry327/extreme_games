import { describe, expect, it } from "vitest";
import type { InputCommand } from "../sim/types";
import type { SequencedInput } from "./protocol";
import { InputSender } from "./inputSender";
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

const seqd = (seq: number): SequencedInput => ({ seq, clientTick: seq, cmd: { ...IDLE } });

/** Build an ascending un-acked list of seqs 1..n (what `ClientInputManager.unacked`
 *  holds when nothing has been acked yet). */
const unackedUpTo = (n: number): SequencedInput[] =>
  Array.from({ length: n }, (_, i) => seqd(i + 1));

const P = "p1";

// --- tests -------------------------------------------------------------------

describe("InputSender", () => {
  it("coalesces many ticks into far fewer datagrams (paces to the interval)", () => {
    // Interval 16ms; simulate 20 ticks at one 10ms frame each (200ms of play).
    const sender = new InputSender(16, 10);
    const unacked: SequencedInput[] = [];
    const batches: SequencedInput[][] = [];

    for (let tick = 1; tick <= 20; tick++) {
      unacked.push(seqd(tick));
      sender.update(0.01, unacked, tick * 10, (b) => batches.push(b));
    }

    // ~200ms / 16ms ≈ 12 datagrams — well under one-per-tick (20).
    expect(batches.length).toBeGreaterThan(8);
    expect(batches.length).toBeLessThan(20);

    // Coalescing loses nothing: every produced seq appears in some datagram.
    const seen = new Set(batches.flat().map((i) => i.seq));
    for (let tick = 1; tick <= 20; tick++) expect(seen.has(tick)).toBe(true);
  });

  it("includes only the newest `redundantTicks` un-acked inputs, ascending", () => {
    const sender = new InputSender(16, 10);
    let sent: SequencedInput[] | null = null;
    // One flush with a deep un-acked backlog (1..20) and plenty of elapsed time.
    sender.update(1.0, unackedUpTo(20), 0, (b) => (sent = b));

    expect(sent).not.toBeNull();
    expect(sent!.map((i) => i.seq)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it("sends all un-acked when fewer than the redundancy depth exist", () => {
    const sender = new InputSender(16, 10);
    let sent: SequencedInput[] | null = null;
    sender.update(1.0, unackedUpTo(3), 0, (b) => (sent = b));
    expect(sent!.map((i) => i.seq)).toEqual([1, 2, 3]);
  });

  it("does not re-send when no new input has been produced since the last flush", () => {
    const sender = new InputSender(16, 10);
    const unacked = unackedUpTo(5);
    let sends = 0;
    sender.update(1.0, unacked, 0, () => sends++); // flushes seqs up to 5
    sender.update(1.0, unacked, 100, () => sends++); // same unacked, lots of time → no send
    expect(sends).toBe(1);
  });

  it("recovers a dropped datagram via redundancy — no server-side gap, same final ack", () => {
    // Drive producer + sender + server together; the redundant overlap in each
    // datagram must cover a wholly dropped one without a retransmit/round-trip.
    function simulate(dropBatchIndex: number | null): number {
      const sender = new InputSender(16, 10);
      const buf = new ServerInputBuffer();
      const unacked: SequencedInput[] = [];
      let seq = 0;
      let batchIdx = 0;

      const FRAMES = 14;
      for (let f = 0; f < FRAMES; f++) {
        unacked.push(seqd(++seq)); // one tick produced this 10ms frame
        sender.update(0.01, unacked, f * 10, (batch) => {
          const drop = dropBatchIndex !== null && batchIdx === dropBatchIndex;
          batchIdx++;
          if (!drop) for (const i of batch) buf.push(P, i);
        });
        buf.next(P); // the server consumes one command per tick
      }
      // Subsequent server ticks drain what's still queued.
      while (buf.depth(P) > 0) buf.next(P);
      return buf.ack(P);
    }

    const clean = simulate(null);
    expect(clean).toBeGreaterThanOrEqual(12); // most of the 14 produced got sent

    // Dropping an early datagram entirely must reach the *same* final processed
    // seq: the next datagram's redundancy carried the lost commands forward.
    expect(simulate(2)).toBe(clean);
  });
});
