import { moveAndCollide } from "../collision";
import type { GameMap } from "../gamemap";
import type { Projectile } from "../types";
import type { World } from "../world";

/**
 * Pipeline step 5 — projectiles. Advance every projectile one tick: move,
 * bounce or die on walls, age out. A bomb that died this tick (wall impact or
 * aged out) detonates, emitting a `bombExploded` event for the renderer/audio.
 * Dead projectiles are compacted out at the end.
 *
 * (Projectile↔ship collision and the resulting damage are separate later
 * systems — collision (step 6) and damage (step 7) — built in M1.)
 */
export function projectileSystem(world: World): void {
  for (const p of world.projectiles) {
    stepProjectile(p, world.map);
    if (!p.alive && p.kind === "bomb") {
      world.events.push({ type: "bombExploded", x: p.x, y: p.y });
    }
  }
  // Drop dead projectiles (a filter is fine at prototype counts).
  if (world.projectiles.some((p) => !p.alive)) {
    world.projectiles = world.projectiles.filter((p) => p.alive);
  }
}

/** Advance one projectile by a tick: move, bounce or die on walls, age out. */
function stepProjectile(p: Projectile, map: GameMap): void {
  p.prevX = p.x;
  p.prevY = p.y;

  const r = moveAndCollide(map, p.x, p.y, p.vx, p.vy, p.radius, 1.0);
  p.x = r.x;
  p.y = r.y;

  if (r.hitX || r.hitY) {
    if (p.bounces > 0) {
      p.bounces--;
      p.vx = r.vx;
      p.vy = r.vy;
    } else {
      p.alive = false;
      return;
    }
  }

  if (--p.life <= 0) p.alive = false;
}
