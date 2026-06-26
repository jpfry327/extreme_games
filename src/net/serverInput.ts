/**
 * Server-side per-player input buffer — M2.3.
 *
 * The client produces one `SequencedInput` per 10ms sim tick and sends every
 * one (protocol.ts). The server consumes them **one per tick, in `seq` order** —
 * NOT last-write-wins. This 1:1 input↔tick discipline is what lets the client
 * deterministically replay its un-acked inputs in M2.4: the server processed the
 * exact same sequence of commands, so re-running them reproduces the same poses.
 *
 * When the next command hasn't arrived yet (a gap from jitter or loss), the
 * server **repeats the player's last command** rather than idling — a held
 * thrust keeps thrusting through a hiccup instead of stuttering to a stop. The
 * repeat is flagged so diagnostics can tell a real command from a filler one.
 *
 * `lastProcessedSeq` is the **ack** stamped into each per-client snapshot; it
 * only advances on a *real* consumed command, never on a repeat, so it always
 * names the highest input the server genuinely acted on.
 *
 * This buffering is deliberately mechanism-only: M2.3 changes no gameplay. M2.11
 * adds a small **standing-depth cap** (`MAX_BUFFERED`) so the queue stays a jitter
 * buffer rather than a latency-adding backlog — see the constant for the why.
 */

import type { InputCommand, PlayerId } from "../sim/types";
import type { SequencedInput } from "./protocol";

const IDLE: InputCommand = {
  rotateLeft: false,
  rotateRight: false,
  thrust: false,
  reverse: false,
  afterburner: false,
  fire: false,
  bomb: false,
};

/** Target standing depth of a player's input queue, in ticks (M2.11).
 *
 *  The queue is meant to be a tiny **jitter buffer**, not a backlog. The client
 *  sends ~1 command per 10ms tick and the server consumes ~1 per tick, so the two
 *  rates match — which means there is *no* mechanism that drains a standing queue
 *  once one forms. A one-time burst (a tab-switch rAF catch-up sends up to 25
 *  commands at once) or slow client/server clock drift therefore builds a queue
 *  that simply *stays*, and every later command then waits `depth` ticks before it
 *  is processed: `depth × 10ms` of pure added latency. That was the "rtt 355ms
 *  while the network ping is ~95ms" bug — ~26 ticks of standing backlog.
 *
 *  Capping the depth bounds that added latency to ~`MAX_BUFFERED × 10ms`. Excess
 *  *oldest* commands are dropped; the client re-predicts and reconciles the few
 *  lost ticks (M2.4/M2.6), so the cost is an occasional small correction, not lag.
 *  6t ≈ 60ms — loose enough to absorb a normal clump of inputs that TCP delivered
 *  together, tight enough that a backlog can't add more than ~60ms. The live depth
 *  is on the debug overlay (`in-buf`), so this can be tuned down with real data.
 *
 *  NOTE: dropping is mildly lossy. The principled, non-lossy fix is client-side
 *  send pacing against the server-reported depth (a later milestone); this is the
 *  cheap, predictable version that kills the pathological standing backlog now. */
const MAX_BUFFERED = 6;

/** One player's ordered command queue. */
class PlayerQueue {
  /** Pending commands, ascending by `seq`, all with `seq > lastProcessedSeq`. */
  private pending: SequencedInput[] = [];
  /** Highest `seq` actually consumed — the value acked to the client. */
  lastProcessedSeq = 0;
  /** Last *real* command, repeated to fill gaps so a held key isn't dropped. */
  private lastCmd: InputCommand = IDLE;
  /** True when the most recent `next()` repeated `lastCmd` (no command queued).
   *  The roadmap's "flagged" repeat — an M2.5 hook (network-condition diagnostics:
   *  surfacing how often a player's stream starves). Maintained now, unread until
   *  then, so the consume path doesn't change when M2.5 wires it up. */
  lastWasRepeat = false;

  /** Enqueue a freshly received command. Stale/duplicate seqs (already consumed)
   *  are dropped. Inserts keeping ascending order so out-of-order arrivals (a
   *  reordering transport, e.g. the M2.5 network simulator) still consume in
   *  seq order. Over plain TCP/WebSocket inputs already arrive in order, so this
   *  is almost always an O(1) append. */
  push(input: SequencedInput): void {
    if (input.seq <= this.lastProcessedSeq) return;

    let i = this.pending.length;
    while (i > 0 && this.pending[i - 1].seq > input.seq) i--;
    if (i > 0 && this.pending[i - 1].seq === input.seq) return; // duplicate
    this.pending.splice(i, 0, input);

    // Bound the standing depth to a small jitter buffer: drop the oldest beyond
    // MAX_BUFFERED so a burst or clock drift can't build a backlog that adds
    // depth×10ms of latency to every later command (M2.11). Keeps the newest.
    while (this.pending.length > MAX_BUFFERED) this.pending.shift();
  }

  /** Consume the command for one tick: the lowest pending `seq`, or — if none has
   *  arrived — a repeat of the last real command (flagged via `lastWasRepeat`). */
  next(): InputCommand {
    const head = this.pending.shift();
    if (head) {
      this.lastProcessedSeq = head.seq;
      this.lastCmd = head.cmd;
      this.lastWasRepeat = false;
      return head.cmd;
    }
    this.lastWasRepeat = true;
    return this.lastCmd;
  }

  get depth(): number {
    return this.pending.length;
  }
}

/** Owns one `PlayerQueue` per player. Both the headless server (server/index.ts)
 *  and the in-process loopback (server.ts) drive their tick loops through this. */
export class ServerInputBuffer {
  private queues = new Map<PlayerId, PlayerQueue>();

  private queueFor(playerId: PlayerId): PlayerQueue {
    let q = this.queues.get(playerId);
    if (!q) {
      q = new PlayerQueue();
      this.queues.set(playerId, q);
    }
    return q;
  }

  /** Buffer a received command for a player. */
  push(playerId: PlayerId, input: SequencedInput): void {
    this.queueFor(playerId).push(input);
  }

  /** The command to apply for `playerId` on the tick being stepped. A player who
   *  has never sent input (or whose queue is empty before their first command)
   *  resolves to idle. */
  next(playerId: PlayerId): InputCommand {
    return this.queueFor(playerId).next();
  }

  /** The ack to stamp into `playerId`'s snapshot (their last processed seq). */
  ack(playerId: PlayerId): number {
    return this.queues.get(playerId)?.lastProcessedSeq ?? 0;
  }

  /** Pending (un-consumed) command count for `playerId` — a debug-HUD signal. */
  depth(playerId: PlayerId): number {
    return this.queues.get(playerId)?.depth ?? 0;
  }

  /** Drop a player's queue on disconnect. */
  remove(playerId: PlayerId): void {
    this.queues.delete(playerId);
  }
}
