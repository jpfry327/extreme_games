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
 * This buffering is deliberately mechanism-only: M2.3 changes no gameplay. The
 * abuse guards (max queue depth, rate clamps) are M2.7 — the soft cap here just
 * bounds memory.
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

/** Soft cap on a single player's pending queue. At 100Hz this is ~10s of
 *  backlog — far beyond any healthy buffer; hitting it means the client is
 *  flooding or wildly clock-skewed, so we drop the oldest. Real abuse guards
 *  (rate clamps, kicks) land in M2.7. */
const MAX_PENDING = 1000;

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

    if (this.pending.length > MAX_PENDING) this.pending.shift();
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
