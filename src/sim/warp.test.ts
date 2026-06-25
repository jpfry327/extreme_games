import { describe, expect, it } from "vitest";
import { WARBIRD } from "../config";
import { BOT_ID } from "./bot";
import { GameMap } from "./gamemap";
import type { InputCommand, StepContext } from "./types";
import { World } from "./world";

/** A small, completely open map so the warp destination is never blocked. */
function openMap(tiles = 128): GameMap {
  return new GameMap(tiles, tiles, new Uint8Array(tiles * tiles));
}

const NO_INPUT: InputCommand = {
  rotateLeft: false,
  rotateRight: false,
  thrust: false,
  reverse: false,
  afterburner: false,
  fire: false,
  bomb: false,
};

/** A world with the local human player plus a bot, both spawned. */
function worldWithBot(): World {
  const world = new World(openMap(), 1, true);
  world.addPlayer(BOT_ID, "ChaosBot", 1, WARBIRD);
  return world;
}

function step(world: World, cmd: Partial<InputCommand>): void {
  const ctx: StepContext = {
    inputs: new Map([[world.localPlayerId, { ...NO_INPUT, ...cmd }]]),
  };
  world.step(ctx);
}

describe("warpSystem", () => {
  it("warps the bot to a fixed distance from the issuing player", () => {
    const world = worldWithBot();
    const bot = world.players.get(BOT_ID)!;
    const me = world.localPlayer;
    // Park the bot far away so any movement toward the warp point is unambiguous.
    bot.kinematics.x = me.kinematics.x + 5000;
    bot.kinematics.y = me.kinematics.y + 5000;

    step(world, { warp: true });

    const dx = bot.kinematics.x - me.kinematics.x;
    const dy = bot.kinematics.y - me.kinematics.y;
    // Within ~one tile of the 200px offset (snapped to a tile center).
    expect(Math.hypot(dx, dy)).toBeLessThan(220);
    expect(bot.kinematics.vx).toBe(0);
    expect(bot.kinematics.vy).toBe(0);
  });

  it("is edge-triggered: holding the key warps only once", () => {
    const world = worldWithBot();
    const bot = world.players.get(BOT_ID)!;

    step(world, { warp: true }); // rising edge → warp
    const afterFirst = { x: bot.kinematics.x, y: bot.kinematics.y };

    // Let the bot's AI drift it away while the key is still held.
    bot.kinematics.x += 300;
    step(world, { warp: true }); // still held → must NOT re-warp

    expect(bot.kinematics.x).not.toBeCloseTo(afterFirst.x, 0);
  });

  it("re-arms after the key is released", () => {
    const world = worldWithBot();
    const bot = world.players.get(BOT_ID)!;
    const me = world.localPlayer;

    step(world, { warp: true }); // warp
    step(world, { warp: false }); // release → re-arm
    bot.kinematics.x = me.kinematics.x + 5000;
    bot.kinematics.y = me.kinematics.y + 5000;
    step(world, { warp: true }); // press again → warp again

    expect(Math.hypot(bot.kinematics.x - me.kinematics.x, bot.kinematics.y - me.kinematics.y)).toBeLessThan(220);
  });

  it("emits a playerSpawned effect at the warp destination", () => {
    const world = worldWithBot();
    step(world, { warp: true });
    const spawnEvents = world.events.filter(
      (e) => e.type === "playerSpawned" && e.player === BOT_ID,
    );
    expect(spawnEvents).toHaveLength(1);
  });
});
