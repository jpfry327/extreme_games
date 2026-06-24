/**
 * Browser-side WebSocket transport — the real-network counterpart to
 * LoopbackTransport. Implements the same Transport interface so swapping back
 * to loopback in main.ts is a one-line change.
 *
 * Lifecycle:
 *   1. start() opens the socket.
 *   2. On open: sends `hello` with the player name.
 *   3. Server replies with `welcome` (assigns PlayerId); onConnected fires.
 *   4. Each sendInput() sends an `input` message.
 *   5. Incoming `snapshot` messages are forwarded to the registered handler.
 */

import type { PlayerId } from "../sim/types";
import type { Transport, SnapshotHandler } from "./transport";
import type { ClientMsg, SequencedInput, ServerMsg } from "./protocol";

export class WebSocketTransport implements Transport {
  private socket: WebSocket | null = null;
  private snapshotHandler: SnapshotHandler | null = null;

  /** Called once when the server sends `welcome`. After it fires, localPlayerId
   *  is valid and the game loop can begin. */
  onConnected: ((playerId: PlayerId) => void) | null = null;

  /** Server-assigned identity for this client. Null until `welcome` arrives. */
  localPlayerId: PlayerId | null = null;

  constructor(
    private readonly url: string,
    private readonly playerName: string,
  ) {}

  start(): void {
    this.socket = new WebSocket(this.url);

    this.socket.addEventListener("open", () => {
      this.send({ type: "hello", name: this.playerName });
    });

    this.socket.addEventListener("message", (ev: MessageEvent<string>) => {
      const msg = JSON.parse(ev.data) as ServerMsg;
      if (msg.type === "welcome") {
        this.localPlayerId = msg.playerId;
        this.onConnected?.(msg.playerId);
      } else if (msg.type === "snapshot") {
        this.snapshotHandler?.(msg.snap);
      }
    });

    this.socket.addEventListener("close", () => {
      console.info("[transport] disconnected from server");
    });

    this.socket.addEventListener("error", () => {
      console.error("[transport] WebSocket error");
    });
  }

  sendInput(input: SequencedInput): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.send({ type: "input", input });
  }

  setSnapshotHandler(cb: SnapshotHandler): void {
    this.snapshotHandler = cb;
  }

  dispose(): void {
    this.socket?.close();
    this.socket = null;
  }

  private send(msg: ClientMsg): void {
    this.socket?.send(JSON.stringify(msg));
  }
}
