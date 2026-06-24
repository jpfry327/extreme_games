/**
 * Wire protocol v0 — M2.1 message shapes for client↔server communication.
 *
 * JSON framing for now; binary is a later optimization. Three message types
 * cover the full M2.1 lifecycle: handshake (hello/welcome), input streaming,
 * and state delivery (snapshot). Chat, items, and ship-change will extend
 * ClientMsg in later milestones.
 */

import type { InputCommand, PlayerId } from "../sim/types";
import type { Snapshot } from "./snapshot";

// --- Client → Server ---

/** First message from a new connection. Server responds with `welcome`. */
export interface HelloMsg {
  type: "hello";
  name: string;
}

/** One input sample per render frame, sent immediately after keyboard sampling.
 *  The server applies the latest buffered input on the next sim step. */
export interface InputMsg {
  type: "input";
  cmd: InputCommand;
}

export type ClientMsg = HelloMsg | InputMsg;

// --- Server → Client ---

/** Server's reply to `hello` — assigns the player's canonical id for this
 *  session. The client must wait for this before starting the game loop. */
export interface WelcomeMsg {
  type: "welcome";
  playerId: PlayerId;
}

/** Full-state snapshot pushed at ~20Hz. The client applies it directly to the
 *  client world; prediction and interpolation are added in M2.4 / M2.2. */
export interface SnapshotMsg {
  type: "snapshot";
  snap: Snapshot;
}

export type ServerMsg = WelcomeMsg | SnapshotMsg;
