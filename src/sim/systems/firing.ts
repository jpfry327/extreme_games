import { LAGCOMP, shipConfig, type WeaponConfig } from "../../config";
import { isAlive, snapDirection } from "../player";
import type { Player, Projectile, ProjectileKind, StepContext } from "../types";
import type { World } from "../world";

/**
 * Pipeline step 3 — firing. Each player whose input requests it spawns a bullet
 * and/or bomb, gated by that weapon's cooldown and energy. New projectiles are
 * tagged with the firer as `owner` (so M1 can credit kills and skip self-hits)
 * and with the firer's lag-compensation rewind (`compTicks`, M2.9 — derived from
 * the input's `renderTick`).
 */
export function firingSystem(world: World, ctx: StepContext): void {
  for (const player of world.players.values()) {
    if (!isAlive(player)) continue; // dead ships can't fire
    const input = ctx.inputs.get(player.id);
    if (!input) continue;

    const comp = compTicksFor(world, input.renderTick);
    if (input.fire) {
      const p = tryFire(world, player, "bullet");
      if (p) {
        if (comp > 0) p.compTicks = comp;
        world.projectiles.push(p);
      }
    }
    if (input.bomb) {
      const p = tryFire(world, player, "bomb");
      if (p) {
        if (comp > 0) p.compTicks = comp;
        world.projectiles.push(p);
      }
    }
  }
}

/**
 * How many ticks back to rewind targets for a shot fired this tick from a view at
 * `renderTick` (M2.9). `world.tick − renderTick` is the gap between where the
 * server is now and the (past) view the firer was aiming through. Clamped:
 *   - `≥ 0`  — a future/absent renderTick means no compensation (test present).
 *   - `≤ maxCompTicks` — bounds the favour-the-shooter unfairness so a laggy or
 *     spoofed client can't rewind targets arbitrarily far.
 *   - `< historyTicks` — can't reach further back than the ring records.
 */
function compTicksFor(world: World, renderTick: number | undefined): number {
  if (renderTick === undefined) return 0;
  const raw = world.tick - renderTick;
  if (raw <= 0) return 0;
  return Math.min(raw, LAGCOMP.maxCompTicks, LAGCOMP.historyTicks - 1);
}

/** Fire one weapon if its cooldown is clear and there's energy for it. Returns
 *  the spawned projectile, or null if it couldn't fire. Mutates the player
 *  (debits energy, sets the cooldown). Assigns a stable `id` from the world
 *  counter so snapshots can track this projectile across ticks. */
function tryFire(world: World, player: Player, kind: ProjectileKind): Projectile | null {
  const config = shipConfig(player.shipType);
  const weapon: WeaponConfig = kind === "bullet" ? config.bullet : config.bomb;
  const combat = player.combat;
  const cooldown = kind === "bullet" ? combat.bulletCooldown : combat.bombCooldown;

  if (cooldown > 0) return null;
  if (player.resources.energy < weapon.fireEnergy) return null;

  player.resources.energy -= weapon.fireEnergy;
  if (kind === "bullet") combat.bulletCooldown = weapon.fireDelayTicks;
  else combat.bombCooldown = weapon.fireDelayTicks;

  const k = player.kinematics;
  const heading = snapDirection(k.rotation, config.directions);
  const fx = Math.sin(heading);
  const fy = -Math.cos(heading);

  // Spawn just past the nose so the shot doesn't collide with its own ship.
  const muzzle = config.radius + 2;
  const x = k.x + fx * muzzle;
  const y = k.y + fy * muzzle;

  return {
    id: world.nextProjectileId++,
    kind,
    owner: player.id,
    x,
    y,
    vx: k.vx + fx * weapon.speed,
    vy: k.vy + fy * weapon.speed,
    life: weapon.lifetimeTicks,
    bounces: weapon.bounces,
    radius: weapon.radius,
    alive: true,
    prevX: x,
    prevY: y,
  };
}
