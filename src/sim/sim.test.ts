import { describe, expect, it } from "vitest";
import { shipConfig, WARBIRD } from "../config";
import { GameMap } from "./gamemap";
import { SeededRng } from "./rng";
import type { InputCommand, StepContext } from "./types";
import { World } from "./world";

// --- Test fixtures -----------------------------------------------------------

/** A small, completely open map. The spawn lands at its center; out-of-bounds
 *  counts as solid, so projectiles bounce/expire against the edges. */
function openMap(tiles = 64): GameMap {
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

function input(partial: Partial<InputCommand>): InputCommand {
  return { ...NO_INPUT, ...partial };
}

/** Address an input to the world's local player for one tick. */
function ctx(world: World, cmd: InputCommand): StepContext {
  return { inputs: new Map([[world.localPlayerId, cmd]]) };
}

// --- Seeded RNG --------------------------------------------------------------

describe("SeededRng", () => {
  it("is deterministic: same seed yields the same sequence", () => {
    const a = new SeededRng(42);
    const b = new SeededRng(42);
    const seqA = Array.from({ length: 5 }, () => a.next());
    const seqB = Array.from({ length: 5 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("differs across seeds and stays within [0, 1)", () => {
    const a = new SeededRng(1);
    const b = new SeededRng(2);
    expect(a.next()).not.toBe(b.next());
    for (const v of Array.from({ length: 100 }, () => new SeededRng(7).range(0, 1))) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

// --- Movement system ---------------------------------------------------------

describe("movementSystem", () => {
  it("thrust accelerates the ship along its heading (up = -y)", () => {
    const world = new World(openMap());
    const { x: startX, y: startY } = world.localPlayer.kinematics;

    world.step(ctx(world, input({ thrust: true })));

    const k = world.localPlayer.kinematics;
    expect(k.vy).toBeLessThan(0); // facing up at rotation 0
    expect(k.y).toBeLessThan(startY);
    expect(k.x).toBeCloseTo(startX); // no sideways drift
  });

  it("records the previous pose for interpolation", () => {
    const world = new World(openMap());
    const before = { ...world.localPlayer.kinematics };
    world.step(ctx(world, input({ thrust: true })));
    const k = world.localPlayer.kinematics;
    expect(k.prevX).toBe(before.x);
    expect(k.prevY).toBe(before.y);
  });
});

// --- Firing system -----------------------------------------------------------

describe("firingSystem", () => {
  it("spawns one owner-tagged bullet and debits its energy", () => {
    const world = new World(openMap());
    const warbird = shipConfig(WARBIRD);
    const fullEnergy = world.localPlayer.resources.energy;

    world.step(ctx(world, input({ fire: true })));

    expect(world.projectiles).toHaveLength(1);
    const bullet = world.projectiles[0];
    expect(bullet.kind).toBe("bullet");
    expect(bullet.owner).toBe(world.localPlayerId);
    expect(world.localPlayer.resources.energy).toBe(fullEnergy - warbird.bullet.fireEnergy);
  });

  it("respects the gun cooldown (no double-fire on the next tick)", () => {
    const world = new World(openMap());
    world.step(ctx(world, input({ fire: true })));
    world.step(ctx(world, input({ fire: true }))); // cooldown still active
    expect(world.projectiles).toHaveLength(1);
  });

  it("won't fire without enough energy", () => {
    const world = new World(openMap());
    world.localPlayer.resources.energy = 0;
    world.step(ctx(world, input({ fire: true })));
    expect(world.projectiles).toHaveLength(0);
  });
});

// --- Projectile system -------------------------------------------------------

describe("projectileSystem", () => {
  it("detonates a bomb, emitting a bombExploded event", () => {
    const world = new World(openMap());
    world.step(ctx(world, input({ bomb: true })));
    expect(world.projectiles).toHaveLength(1);

    // Fly it until it dies (hits the map edge or ages out).
    for (let i = 0; i < shipConfig(WARBIRD).bomb.lifetimeTicks + 5; i++) {
      world.step(ctx(world, NO_INPUT));
      if (world.events.some((e) => e.type === "bombExploded")) break;
    }
    expect(world.events.some((e) => e.type === "bombExploded")).toBe(true);
    expect(world.projectiles).toHaveLength(0); // dead projectile compacted out
  });
});

// --- Determinism (the whole point of the seeded sim) -------------------------

describe("determinism", () => {
  it("two worlds with the same seed and inputs stay byte-identical", () => {
    const seed = 123;
    const a = new World(openMap(), seed);
    const b = new World(openMap(), seed);

    // A fixed, varied input script driven only by the tick index.
    for (let t = 0; t < 300; t++) {
      const cmd = input({
        thrust: t % 3 === 0,
        rotateRight: t % 5 === 0,
        fire: t % 7 === 0,
        bomb: t % 50 === 0,
      });
      a.step(ctx(a, cmd));
      b.step(ctx(b, cmd));
    }

    expect(snapshot(a)).toEqual(snapshot(b));
  });
});

/** A plain-data view of the sim state — exactly the kind of thing the network
 *  snapshot will serialize. Used to assert two runs are identical. */
function snapshot(world: World) {
  return {
    tick: world.tick,
    rng: world.rng.seed,
    players: [...world.players.values()],
    projectiles: world.projectiles,
  };
}
