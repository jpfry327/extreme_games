import { TILE_SIZE } from "../../config";
import { BOT_ID } from "../bot";
import { isAlive } from "../player";
import type { GameMap } from "../gamemap";
import type { Player, StepContext } from "../types";
import type { World } from "../world";

/** How far from the issuing player the bot is dropped — close enough to fight
 *  immediately, far enough not to spawn on top of you. ~12 tiles. */
const WARP_OFFSET_PX = 200;

/**
 * Debug/admin step — warp the bot (ChaosBot) to a fixed distance from whichever
 * player issued an `InputCommand.warp`. Runs before movement so the bot's new
 * pose is what everything else this tick sees.
 *
 * **Edge-triggered.** The keyboard reports `warp: true` for the whole key-hold,
 * but we only fire on the rising edge (`!held → held`), so one press = one warp
 * instead of pinning the bot in place 100×/second and spamming warp-in effects.
 * The "was held last tick" state lives in `world.warpHeld`, a runtime-only Set
 * (never serialized — like `events`/`contacts`/`history`). Only the
 * authoritative server steps the bot, so that's the only place this matters.
 *
 * Deterministic: position is the issuer's pose plus a fixed offset, snapped to
 * the nearest open tile by a fixed spiral. No `Math.random()`, no `world.rng`
 * (keeping the rng sequence — and thus prediction — untouched).
 */
export function warpSystem(world: World, ctx: StepContext): void {
  const bot = world.players.get(BOT_ID);
  if (!bot) return; // no bot in this world (e.g. a server with only humans)

  for (const [id, cmd] of ctx.inputs) {
    if (id === BOT_ID) continue; // the bot never warps itself
    const wantsWarp = cmd.warp === true;
    const wasHeld = world.warpHeld.has(id);

    if (wantsWarp && !wasHeld) warpBotNear(world, bot, world.players.get(id));

    if (wantsWarp) world.warpHeld.add(id);
    else world.warpHeld.delete(id);
  }
}

/** Place `bot` a fixed distance ahead of `issuer` (along the issuer's heading),
 *  snapped to open space, with velocity zeroed. */
function warpBotNear(world: World, bot: Player, issuer: Player | undefined): void {
  if (!issuer) return;

  const ik = issuer.kinematics;
  // rotation 0 points UP, so the facing vector is (sin, -cos) — same convention
  // as the movement system. Drop the bot in front of where the player is aiming.
  const targetX = ik.x + Math.sin(ik.rotation) * WARP_OFFSET_PX;
  const targetY = ik.y - Math.cos(ik.rotation) * WARP_OFFSET_PX;
  const dest = nearestOpen(world.map, targetX, targetY);

  const k = bot.kinematics;
  k.x = k.prevX = dest.x;
  k.y = k.prevY = dest.y;
  k.vx = 0;
  k.vy = 0;

  // Reuse the spawn-in effect so the warp is visible where the bot lands. Only
  // emitted on the rising edge, so it fires once per press. Skip it for a dead
  // bot (it's mid-respawn and will get its own spawn effect).
  if (isAlive(bot)) {
    world.events.push({ type: "playerSpawned", player: bot.id, x: dest.x, y: dest.y });
  }
}

/** Nearest open tile center to a pixel point, via a fixed outward spiral. Falls
 *  back to the point itself if the whole map is solid (can't happen in practice). */
function nearestOpen(map: GameMap, px: number, py: number): { x: number; y: number } {
  const cx = Math.floor(px / TILE_SIZE);
  const cy = Math.floor(py / TILE_SIZE);
  const center = (tx: number, ty: number) => ({
    x: tx * TILE_SIZE + TILE_SIZE / 2,
    y: ty * TILE_SIZE + TILE_SIZE / 2,
  });

  if (!map.isSolidTile(cx, cy)) return center(cx, cy);
  for (let radius = 1; radius < map.width; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue; // ring only
        if (!map.isSolidTile(cx + dx, cy + dy)) return center(cx + dx, cy + dy);
      }
    }
  }
  return { x: px, y: py };
}
