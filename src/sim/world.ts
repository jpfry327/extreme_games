import { TILE_SIZE, WARBIRD } from "../config";
import { GameMap } from "./gamemap";
import { createPlayer } from "./player";
import { SeededRng } from "./rng";
import { firingSystem } from "./systems/firing";
import { movementSystem } from "./systems/movement";
import { projectileSystem } from "./systems/projectiles";
import type { Player, PlayerId, Projectile, GameEvent, StepContext } from "./types";

/** The single local player's id. With no network yet, there's exactly one
 *  player and the client owns it. (Networking assigns real ids in M2.) */
export const LOCAL_PLAYER_ID: PlayerId = "local";

/**
 * The whole game state for one tick — Layer A, the serializable nouns. The
 * world is keyed collections, not singletons: single-player is just "one player
 * among N", so nothing in the sim assumes a player count (architecture §2.1).
 *
 * `step(ctx)` advances everything by exactly one fixed tick. This is the piece
 * that would run, unchanged, on the server.
 */
export class World {
  tick = 0;
  players = new Map<PlayerId, Player>();
  projectiles: Projectile[] = [];

  /** Deterministic RNG — the sim never calls Math.random() (architecture §5.2). */
  rng: SeededRng;

  /** Events produced this tick (Layer C). Appended to during step(); the
   *  renderer drains this once per drawn frame. */
  events: GameEvent[] = [];

  /** Which player this client controls / the camera follows. Server-side this
   *  has no meaning; it's a client convenience that rides along on the world. */
  readonly localPlayerId: PlayerId = LOCAL_PLAYER_ID;

  constructor(
    public readonly map: GameMap,
    seed = 1,
  ) {
    this.rng = new SeededRng(seed);
    const spawn = findSpawn(map);
    const player = createPlayer(LOCAL_PLAYER_ID, "Player", 0, WARBIRD, spawn.x, spawn.y);
    this.players.set(player.id, player);
  }

  /** Convenience accessor for the client's own player. */
  get localPlayer(): Player {
    return this.players.get(this.localPlayerId)!;
  }

  /**
   * Advance the simulation one fixed tick by running each system in order.
   * The order is itself a design decision (architecture §3): a system reads the
   * world as left by the systems before it. Steps not yet built are listed so
   * the intended shape is visible — they're filled in over M1–M5.
   *
   *   1. intent       — (folded into movement/firing for now)
   *   2. movement     — rotate, thrust, drag, wall-bounce        ✅
   *   3. firing       — spawn projectiles; debit energy/cooldown ✅
   *   4. items        — repel/burst/decoy/…                       (M5)
   *   5. projectiles  — move, bounce, lifetime, detonation       ✅
   *   6. collision    — projectile↔ship, ship↔ship                (M1)
   *   7. damage       — apply hits → energy; queue deaths         (M1)
   *   8. death/respawn— kill credit, bounty, respawn timers       (M1)
   *   9. status       — toggle energy drain; expire timed effects (M5)
   *  10. resources    — energy recharge (in movement for now)     (M1+)
   *  11. prizes / 12. objectives / 13. regions                    (later)
   */
  step(ctx: StepContext): void {
    this.tick++;
    movementSystem(this, ctx);
    firingSystem(this, ctx);
    projectileSystem(this);
  }
}

/** Find an open spawn point: start at map center, spiral out to the nearest
 *  empty tile so we never spawn embedded in a wall. */
function findSpawn(map: GameMap): { x: number; y: number } {
  const cx = Math.floor(map.width / 2);
  const cy = Math.floor(map.height / 2);
  const toPixel = (tx: number, ty: number) => ({
    x: tx * TILE_SIZE + TILE_SIZE / 2,
    y: ty * TILE_SIZE + TILE_SIZE / 2,
  });

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
