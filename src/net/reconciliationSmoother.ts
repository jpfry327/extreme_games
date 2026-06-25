/**
 * Correction smoothing for the predicted local ship — M2.5.
 *
 * M2.4 reconciles by rewind-and-replay: each snapshot resets the local ship to
 * the acked authoritative pose and replays the un-acked inputs. Under clean
 * conditions the replay reproduces the server exactly (`predictionErrorPx ≈ 0`)
 * so there's nothing to see. But under latency/jitter/loss the replayed "now"
 * can differ from the previous frame's predicted "now" — and rendering that
 * difference directly is a visible **snap**.
 *
 * This smooths it. At each reconciliation we measure the discontinuity — the
 * predicted pose *before* applying the new snapshot minus the predicted pose
 * *after* — and fold it into a persistent render-offset. The local ship is drawn
 * at `predicted + offset`, and the offset decays exponentially to zero. So at
 * the instant of a correction the ship is still drawn where it was (no jump),
 * then eased onto the corrected path over a few frames. In steady state the
 * offset is zero, so smoothing adds **no latency** — it only acts on a mismatch.
 *
 * Both poses are sampled at the same wall-clock instant (the snapshot handler),
 * so their difference is pure misprediction, not real motion. A correction
 * larger than `maxSmoothDistancePx` is a teleport (respawn / hard divergence),
 * not something to slide across the screen — there we drop the offset and let it
 * snap.
 */

import { NET } from "../config";
import type { Kinematics } from "../sim/types";

/** Shortest signed angular difference `a → b`, in (−π, π]. Keeps a correction
 *  across the 0/2π seam a small arc instead of a near-full spin. */
function angleDelta(a: number, b: number): number {
  const twoPi = Math.PI * 2;
  let d = (a - b) % twoPi;
  if (d > Math.PI) d -= twoPi;
  if (d < -Math.PI) d += twoPi;
  return d;
}

export class ReconciliationSmoother {
  private offsetX = 0;
  private offsetY = 0;
  private offsetRot = 0;

  /** Current positional offset magnitude (px) — surfaced on the debug overlay so
   *  a correction is visible as a brief blip that decays to 0. */
  get offsetPx(): number {
    return Math.hypot(this.offsetX, this.offsetY);
  }

  /**
   * Absorb a reconciliation discontinuity: `before` is the predicted local
   * kinematics with the *old* authoritative state, `after` is the predicted
   * kinematics with the *new* snapshot applied. Adding `(before − after)` to the
   * offset means the ship keeps being drawn at `before` this frame, then decays
   * onto `after`. A jump past the teleport threshold is snapped (offset cleared).
   */
  absorb(before: Kinematics, after: Kinematics): void {
    const dx = before.x - after.x;
    const dy = before.y - after.y;
    if (Math.hypot(dx, dy) > NET.maxSmoothDistancePx) {
      // Teleport (respawn / warp / hard divergence) — don't slide across the map.
      this.offsetX = this.offsetY = this.offsetRot = 0;
      return;
    }
    this.offsetX += dx;
    this.offsetY += dy;
    this.offsetRot += angleDelta(before.rotation, after.rotation);
  }

  /**
   * Decay the offset by `dtSeconds` and apply what remains to `k` in place, so
   * the renderer draws the eased pose. `prev*` are shifted by the same amount,
   * keeping the renderer's `prev→current` lerp a no-op regardless of `alpha`.
   */
  apply(k: Kinematics, dtSeconds: number): void {
    const decay = Math.pow(0.5, (dtSeconds * 1000) / NET.correctionHalfLifeMs);
    this.offsetX *= decay;
    this.offsetY *= decay;
    this.offsetRot *= decay;

    k.x += this.offsetX;
    k.y += this.offsetY;
    k.rotation += this.offsetRot;
    k.prevX += this.offsetX;
    k.prevY += this.offsetY;
    k.prevRotation += this.offsetRot;
  }
}
