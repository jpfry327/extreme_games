import { shipConfig, type ShipTier, type ShipType } from "../config";
import type { Player, PlayerId, TeamId } from "./types";

/**
 * Which stat tier a player currently flies at. M0 always flies Initial — a
 * freshly-spawned, un-upgraded ship, matching the prototype. Green prizes ramp
 * this toward Maximum (M4's lobby default); when that lands, this is the one
 * place that decision is made.
 */
export function tierFor(player: Player): ShipTier {
  return shipConfig(player.shipType).initial;
}

/** Build a fresh player at the given spawn, flying the given ship at Initial. */
export function createPlayer(
  id: PlayerId,
  name: string,
  team: TeamId,
  shipType: ShipType,
  x: number,
  y: number,
): Player {
  const tier = shipConfig(shipType).initial;
  return {
    id,
    name,
    team,
    shipType,

    kinematics: {
      x,
      y,
      vx: 0,
      vy: 0,
      rotation: 0,
      prevX: x,
      prevY: y,
      prevRotation: 0,
    },
    resources: {
      energy: tier.maxEnergy,
      recharge: tier.rechargeRate,
      maxEnergy: tier.maxEnergy,
    },
    loadout: {
      gunLevel: 1,
      bombLevel: 1,
      multifire: false,
      bouncingBombs: false,
      mines: 0,
      bursts: 0,
      decoys: 0,
      repels: 0,
      rockets: 0,
      portals: 0,
      thors: 0,
      bricks: 0,
    },
    status: {
      stealth: false,
      cloak: false,
      xradar: false,
      antiwarp: false,
      multifire: false,
    },
    combat: {
      bounty: 0,
      score: 0,
      kills: 0,
      deaths: 0,
      respawnAt: 0,
      lastHitBy: null,
      flagsHeld: 0,
      carryingBall: false,
      bulletCooldown: 0,
      bombCooldown: 0,
    },
  };
}

/** A player is alive (steppable, hittable, drawable) unless it's waiting out a
 *  respawn timer. `respawnAt === 0` is the canonical "alive" marker — set when
 *  a ship spawns and restored by the respawn system (architecture §3 step 8). */
export function isAlive(player: Player): boolean {
  return player.combat.respawnAt === 0;
}

/**
 * Snap a continuous angle to the nearest of the ship's N facing directions.
 * Subspace ships turn in discrete steps (40 for the Warbird); thrust is applied
 * along the snapped heading, which is part of what makes movement feel the way
 * it does. Shared by the movement system (thrust) and firing (muzzle heading).
 */
export function snapDirection(rotation: number, directions: number): number {
  const step = (Math.PI * 2) / directions;
  return Math.round(rotation / step) * step;
}
