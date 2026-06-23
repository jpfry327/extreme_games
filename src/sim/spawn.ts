import { TILE_SIZE } from "../config";
import type { GameMap } from "./gamemap";
import type { SeededRng } from "./rng";

/**
 * Pick an open spawn point near the map center. Used both for the initial spawn
 * and for respawns (architecture §3, step 8). EG drives this from a `[Spawn]`
 * table, but the svs map's entries are degenerate (all teams share one point),
 * so we spawn near center and use the seeded RNG to scatter ships so they don't
 * stack on top of each other. Staying inside `sim/` and drawing only from
 * `world.rng` keeps it deterministic.
 */
export function findSpawn(map: GameMap, rng: SeededRng): { x: number; y: number } {
  const cx = Math.floor(map.width / 2);
  const cy = Math.floor(map.height / 2);
  const toPixel = (tx: number, ty: number) => ({
    x: tx * TILE_SIZE + TILE_SIZE / 2,
    y: ty * TILE_SIZE + TILE_SIZE / 2,
  });

  // Try a handful of random tiles in a window around center first, so two ships
  // spawning the same tick land apart.
  const JITTER = 6; // tiles
  for (let attempt = 0; attempt < 16; attempt++) {
    const tx = cx + rng.int(-JITTER, JITTER);
    const ty = cy + rng.int(-JITTER, JITTER);
    if (!map.isSolidTile(tx, ty)) return toPixel(tx, ty);
  }

  // Fallback: spiral out from center to the nearest empty tile.
  if (!map.isSolidTile(cx, cy)) return toPixel(cx, cy);
  for (let radius = 1; radius < map.width; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue; // ring only
        if (!map.isSolidTile(cx + dx, cy + dy)) return toPixel(cx + dx, cy + dy);
      }
    }
  }
  return toPixel(cx, cy); // give up; shouldn't happen
}
