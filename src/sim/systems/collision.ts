import { shipConfig } from "../../config";
import { isAlive } from "../player";
import type { Player, Projectile } from "../types";
import type { World } from "../world";

/**
 * Pipeline step 6 — collision (projectile↔ship). For each live projectile we
 * test it against every player, ignoring its own `owner` and any dead player.
 *
 * This system only *detects* and *flags*; it never changes energy — that's the
 * damage system's job (step 7). Keeping the two apart is the documented design
 * (architecture §3): collision answers "what touched what", damage answers "so
 * what happens". On a hit we kill the projectile here so it's compacted out and
 * can't hit twice; the resulting damage is resolved next.
 *
 *   - A **bullet** that overlaps a ship is recorded as a `Contact` (it deals a
 *     flat hit to exactly that ship).
 *   - A **bomb** that touches a ship is simply marked dead; the damage system
 *     detonates every bomb that died this tick into an area blast, so a bomb
 *     that hit a ship and one that hit a wall explode through the same path.
 *
 * **Lag compensation (M2.9):** a projectile carrying `compTicks > 0` is tested
 * not against each target's *present* pose but against where that target was
 * `compTicks` ago — the firer's view at the moment of the shot — looked up from
 * `world.history`. The projectile still flies in the present (so it looks right
 * to the firer who predicted it); only the *overlap test* reaches into the past.
 * This is what makes "what you see is what you hit" hold despite the interpolation
 * delay. The rewound `Contact` is flagged so the damage step can tell the client.
 *
 * (Ship↔ship and ship↔prize/flag/ball collisions are later milestones.)
 */
export function collisionSystem(world: World): void {
  world.contacts = [];

  for (const p of world.projectiles) {
    if (!p.alive) continue; // already died to a wall this tick (step 5)

    for (const target of world.players.values()) {
      if (target.id === p.owner) continue; // never hit the firer
      if (!isAlive(target)) continue; // ghosts waiting to respawn don't collide

      const hit = testOverlap(world, p, target);
      if (!hit) continue;

      if (p.kind === "bullet") {
        world.contacts.push({ projectile: p, target, rewound: hit.rewound });
      }
      // Both bullets and bombs die on contact; the bomb's blast is applied in
      // the damage step from its corpse.
      p.alive = false;
      break; // this projectile is spent; stop checking further ships
    }
  }
}

/** Test a projectile against one target, lag-compensating if the shot carries a
 *  rewind (M2.9). Returns `null` for no overlap, or `{ rewound }` on a hit —
 *  `rewound` true when the test used the target's historical pose.
 *
 *  With `compTicks > 0` we compare against the target's pose `compTicks` ago: if
 *  the target wasn't alive then (a ghost in the firer's view) it can't be hit; if
 *  the history slot has been evicted / not yet recorded we fall back to the
 *  present pose (degrades to no compensation rather than reading a wrong sample). */
function testOverlap(
  world: World,
  p: Projectile,
  target: Player,
): { rewound: boolean } | null {
  const comp = p.compTicks ?? 0;
  if (comp > 0) {
    const past = world.history.lookup(world.tick - comp, target.id);
    if (past) {
      if (!past.alive) return null; // wasn't a valid target in the firer's view
      return overlaps(p, past.x, past.y, past.radius) ? { rewound: true } : null;
    }
    // History miss — fall through to the present pose below (no compensation).
  }
  const k = target.kinematics;
  return overlaps(p, k.x, k.y, shipConfig(target.shipType).radius)
    ? { rewound: false }
    : null;
}

/** Circle overlap between a projectile and a target at `(tx, ty)` with collision
 *  radius `tr`, using the projectile's own radius. */
function overlaps(p: Projectile, tx: number, ty: number, tr: number): boolean {
  const reach = p.radius + tr;
  const dx = p.x - tx;
  const dy = p.y - ty;
  return dx * dx + dy * dy <= reach * reach;
}
