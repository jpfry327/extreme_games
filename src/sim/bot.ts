import { isAlive } from "./player";
import type { InputCommand, Player } from "./types";
import type { World } from "./world";

/**
 * A trivial combat bot — the M1 stand-in for a second player. It produces an
 * `InputCommand` each tick, exactly like the keyboard does for the human, so
 * the sim treats it as just another player (it has no idea the inputs are
 * AI-generated). That's the whole point of the roadmap's "validate against a
 * local bot": damage doesn't care where the second player's intent comes from.
 *
 * It is intentionally deterministic — it reads only world state and the tick
 * counter, never `Math.random()` and never `world.rng` (which belongs to the
 * sim systems). Two runs with the same inputs stay byte-identical, and this
 * code grows into the lobby's ChaosBot filler later.
 *
 * Behaviour: wander when alone; when an enemy is in range, turn to face it,
 * close the distance, and fire bullets once roughly on target.
 */

const FIRE_RANGE = 240; // px — inside a bullet's travel distance (4.1*65 ≈ 266)
const ENGAGE_RANGE = 520; // px — start turning toward / approaching a target
const STANDOFF = 170; // px — stop thrusting once this close, to circle not ram
const AIM_TOLERANCE = 0.25; // rad — fire when the heading is within this of target

const IDLE: InputCommand = {
  rotateLeft: false,
  rotateRight: false,
  thrust: false,
  reverse: false,
  afterburner: false,
  fire: false,
  bomb: false,
};

export function computeBotInput(world: World, botId: string): InputCommand {
  const bot = world.players.get(botId);
  if (!bot || !isAlive(bot)) return IDLE;

  const target = nearestEnemy(world, bot);
  if (!target) return wander(world.tick);

  const k = bot.kinematics;
  const dx = target.kinematics.x - k.x;
  const dy = target.kinematics.y - k.y;
  const dist = Math.hypot(dx, dy);

  if (dist > ENGAGE_RANGE) return wander(world.tick);

  // Desired heading in the sim's convention (rotation 0 = up, facing = (sin,-cos)).
  const desired = Math.atan2(dx, -dy);
  const diff = normalizeAngle(desired - k.rotation);

  const cmd: InputCommand = { ...IDLE };
  if (diff > 0.04) cmd.rotateRight = true;
  else if (diff < -0.04) cmd.rotateLeft = true;

  // Close the gap, but don't ram — back off to a standoff distance.
  if (dist > STANDOFF) cmd.thrust = true;

  // Fire when lined up and within a bullet's reach.
  if (Math.abs(diff) < AIM_TOLERANCE && dist < FIRE_RANGE) cmd.fire = true;

  return cmd;
}

/** The closest living player that isn't the bot itself. */
function nearestEnemy(world: World, bot: Player): Player | null {
  let best: Player | null = null;
  let bestDist = Infinity;
  for (const p of world.players.values()) {
    if (p.id === bot.id || !isAlive(p)) continue;
    const d = Math.hypot(p.kinematics.x - bot.kinematics.x, p.kinematics.y - bot.kinematics.y);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

/** Drift around when there's no one to fight: always thrust, and sweep the turn
 *  direction on a slow cycle so the bot wanders instead of flying straight. */
function wander(tick: number): InputCommand {
  const turnRight = Math.floor(tick / 140) % 2 === 0;
  return { ...IDLE, thrust: true, rotateRight: turnRight, rotateLeft: !turnRight };
}

/** Fold an angle into [-π, π]. */
function normalizeAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  if (r < -Math.PI) r += twoPi;
  return r;
}
