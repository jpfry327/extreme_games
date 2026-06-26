/**
 * Client-side transport abstraction — the boundary between the client and the
 * authoritative server (architecture §5).
 *
 * `Transport` is the interface every client uses: send your `InputCommand`,
 * register a handler for incoming snapshots. M2.0 ships a `LoopbackTransport`
 * (in-process, zero latency); M2.1 will add `WebSocketTransport` that swaps in
 * over the same interface with a one-line change in main.ts.
 *
 * `LoopbackTransport` also implements `ClientConnection` (server.ts) so the
 * server can call `deliverSnapshot` on it directly.
 */

import type { PlayerId } from "../sim/types";
import type { SequencedInput } from "./protocol";
import { type ClientConnection, type GameServer } from "./server";
import type { Snapshot } from "./snapshot";

export type SnapshotHandler = (snap: Snapshot) => void;

/** The client-side view of the transport. One instance per client session. */
export interface Transport {
  /** Send one datagram of sequenced commands to the server (M2.15). The batch is
   *  a frame's coalesced tick-commands plus redundant recent un-acked ones,
   *  ascending by `seq`; the server consumes new ones and dedups the overlap. */
  sendInput(inputs: readonly SequencedInput[]): void;
  /** Register the callback that receives each incoming snapshot. */
  setSnapshotHandler(cb: SnapshotHandler): void;
  start(): void;
  dispose(): void;
}

/**
 * In-process transport with zero latency. Used in M2.0 to test the snapshot
 * model before any sockets exist. The `GameServer.advance()` call delivers the
 * snapshot synchronously by calling `deliverSnapshot` on this object.
 *
 * The bot is computed server-side inside `GameServer` (it always was just
 * another player feeding the sim), so the loopback only ever sends the local
 * player's own sequenced input — same contract as the real socket.
 */
export class LoopbackTransport implements Transport, ClientConnection {
  private snapshotHandler: SnapshotHandler | null = null;

  constructor(
    private readonly server: GameServer,
    /** The player id this client controls (used as the per-client snapshot key). */
    readonly localPlayerId: PlayerId,
  ) {
    server.connectClient(this);
  }

  /** Enqueue the batch's commands to the server, immediately (zero latency). The
   *  server buffer dedups any redundant re-send by `seq`, so the overlap is a
   *  cheap no-op — same contract as the real socket. */
  sendInput(inputs: readonly SequencedInput[]): void {
    for (const input of inputs) this.server.enqueueInput(this.localPlayerId, input);
  }

  setSnapshotHandler(cb: SnapshotHandler): void {
    this.snapshotHandler = cb;
  }

  /** Called by `GameServer.advance()` to deliver a snapshot synchronously. */
  deliverSnapshot(snap: Snapshot): void {
    this.snapshotHandler?.(snap);
  }

  start(): void {}

  dispose(): void {
    this.server.disconnectClient(this);
  }
}
