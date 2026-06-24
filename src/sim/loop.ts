import { TICK_DT } from "../config";
import type { StepContext } from "./types";
import type { World } from "./world";

/**
 * Fixed-timestep driver. The renderer can run at any frame rate (60, 120, 144Hz),
 * but the simulation always advances in fixed 10ms (100Hz) steps. This keeps the
 * physics deterministic and frame-rate independent — essential for a game whose
 * sim will later run authoritatively on a server.
 *
 * `advance()` returns an interpolation alpha in [0,1): how far we are between the
 * last completed tick and the next one, so the renderer can smoothly blend poses.
 *
 * The context is built **per tick** via `buildCtx`, not once per frame: under the
 * M2.3 fixed-tick input model the server consumes one buffered command per tick
 * per player, so each catch-up tick this frame needs its own fresh context (and
 * lets the bot re-read the world it just changed). A caller that has a single
 * intent for the whole frame simply returns the same context each call.
 */
export class FixedLoop {
  private accumulator = 0;
  private static readonly MAX_FRAME = 0.25; // clamp to avoid spiral-of-death

  constructor(private readonly world: World) {}

  advance(dtSeconds: number, buildCtx: () => StepContext): number {
    this.accumulator += Math.min(dtSeconds, FixedLoop.MAX_FRAME);

    while (this.accumulator >= TICK_DT) {
      this.world.step(buildCtx());
      this.accumulator -= TICK_DT;
    }

    return this.accumulator / TICK_DT;
  }
}
