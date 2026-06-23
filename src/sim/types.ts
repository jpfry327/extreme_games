/**
 * Shared simulation types — Layer A (the nouns) of the architecture.
 *
 * Everything under src/sim/ is pure game logic with NO rendering imports; the
 * same code runs on the server. The litmus test for everything here: it must be
 * plain, JSON-serializable data with no methods and no Pixi/DOM — that's what
 * lets the whole world be sent over the wire as a snapshot (architecture §1).
 */

import type { ShipType } from "../config";

/** Stable identity for a player. A string so the network can use any scheme
 *  (uuid, connection id, …); M0 has a single local player. */
export type PlayerId = string;

/** Frequency / team number. Single-team in M0. */
export type TeamId = number;

/** One frame of player intent, sampled from the keyboard each render frame.
 *  The client sends *intent*, never state (architecture §5). This grows to
 *  carry use-item / change-ship / chat in later milestones. */
export interface InputCommand {
  rotateLeft: boolean;
  rotateRight: boolean;
  thrust: boolean; // forward
  reverse: boolean; // backward
  afterburner: boolean;
  fire: boolean; // gun
  bomb: boolean; // bomb
}

/** What `step()` receives each tick: every player's intent for this tick,
 *  keyed by player id. A player with no entry is treated as idle. */
export interface StepContext {
  inputs: Map<PlayerId, InputCommand>;
}

// --- Player, as grouped components (architecture §2.2) -----------------------
// A player accretes a lot of state, so it's grouped so each system can own a
// slice and the whole thing stays legible. M0 only exercises kinematics +
// resources + the weapon cooldowns; the rest are present (multiplayer-shaped)
// but inert until their milestone.

/** Position/velocity/facing. `prev*` is last tick's pose, kept so the renderer
 *  can interpolate between ticks (and, later, between server snapshots). */
export interface Kinematics {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number; // radians, continuous; 0 = pointing up
  prevX: number;
  prevY: number;
  prevRotation: number;
}

/** Energy pool + its recharge rate and cap (copied from the ship's tier so the
 *  recharge/firing systems don't re-read config — and so it snapshots). */
export interface Resources {
  energy: number;
  recharge: number; // energy/tick
  maxEnergy: number;
}

/** What a ship CAN do + its current consumable ammo (architecture §2.3). Mostly
 *  a copy of config; mutated by prizes later. All inert in M0. */
export interface Loadout {
  gunLevel: 1 | 2 | 3; // -> bullet color/damage
  bombLevel: 1 | 2 | 3;
  multifire: boolean; // capability (the toggle is in StatusEffects)
  bouncingBombs: boolean;
  // counts of consumables:
  mines: number;
  bursts: number;
  decoys: number;
  repels: number;
  rockets: number;
  portals: number;
  thors: number;
  bricks: number;
}

/** Active status: player-controlled toggles + timed effects (architecture
 *  §2.4). The toggles drain energy while on; the timed effects store the tick
 *  they expire. All off in M0; the `statusSystem` that drives them lands in M5. */
export interface StatusEffects {
  // Category 2 — player-controlled toggles. On/off; drain energy while on.
  stealth: boolean;
  cloak: boolean;
  xradar: boolean;
  antiwarp: boolean;
  multifire: boolean;

  // Category 3 — timed; the tick at which it expires (0/absent = off).
  superUntil?: number;
  shieldsUntil?: number;
  rocketUntil?: number;
}

/** Combat-runtime counters: scoring, the respawn timer, and the per-weapon
 *  cooldown timers. (Damage/death/respawn logic itself arrives in M1.) */
export interface Combat {
  bounty: number;
  deaths: number;
  respawnAt: number; // tick to respawn at; 0 = alive
  flagsHeld: number;
  carryingBall: boolean;
  bulletCooldown: number; // ticks until the gun may fire again
  bombCooldown: number; // ticks until a bomb may fire again
}

export interface Player {
  id: PlayerId;
  name: string;
  team: TeamId;
  shipType: ShipType;

  kinematics: Kinematics;
  resources: Resources;
  loadout: Loadout;
  status: StatusEffects;
  combat: Combat;
}

// --- Projectiles -------------------------------------------------------------

export type ProjectileKind = "bullet" | "bomb";

/** A bullet or a bomb — they share flight physics, differing only in their
 *  config (speed, lifetime, bounces) and how they're drawn. Each is tagged with
 *  the `owner` that fired it, so M1 can credit kills and ignore self-hits. */
export interface Projectile {
  kind: ProjectileKind;
  owner: PlayerId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number; // ticks remaining
  bounces: number; // bounces remaining
  radius: number; // collision half-extent, px (copied from weapon config)
  alive: boolean;

  prevX: number;
  prevY: number;
}

// --- Events (Layer C) --------------------------------------------------------

/**
 * Transient "something happened" records the sim produces for the client to
 * turn into visuals/sounds. The sim stays renderer-agnostic: it records *what*
 * happened and *where*, never how to draw it. Events are drained each frame and
 * are never sim state (architecture §4). This is a tagged union so it grows
 * cleanly (shipHit, shipDied, … land in M1).
 */
export interface BombExplodedEvent {
  type: "bombExploded";
  x: number;
  y: number;
}

export type GameEvent = BombExplodedEvent;
