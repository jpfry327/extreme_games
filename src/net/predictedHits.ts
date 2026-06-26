/**
 * Client-side predicted hit *feedback* — M2.11 (responsiveness pass).
 *
 * The problem: hits/damage are 100% server-authoritative, so the visual confirmation
 * that your shot connected — the bomb burst, the bullet spark — only arrives with
 * the server snapshot, ~1 RTT after your (predicted) shot visually overlaps the
 * enemy on your screen. Until then the shot sails *through* the enemy and the
 * explosion lands a beat late. That delay is fundamental to authoritative damage
 * (no model, Subspace included, shows a *remote* reaction faster than ~1 RTT), but
 * the *feedback* can be faked instantly and cosmetically, which is what every
 * responsive shooter does (the "hit marker now, kill confirm later" trick).
 *
 * This detector finds the moment one of *your own* in-flight projectiles overlaps
 * an enemy **as drawn** (own shot at the present leading edge vs the enemy
 * interpolated in the past — exactly the two sprites the player sees), and reports
 * it so the caller can:
 *   1. draw the burst/spark immediately (a cosmetic `bombExploded` / `shipHit`),
 *   2. stop the projectile so it ends *there* instead of flying on, and
 *   3. (bombs) suppress the delayed server copy of that explosion.
 *
 * It is **cosmetic only** — it never touches damage, energy, kills, or the death
 * explosion (those stay authoritative; no predicted kills). The accepted trade,
 * shared with the Subspace model, is the occasional false positive: a shot that
 * looked like it connected but the server scored a miss draws a burst that did no
 * damage.
 *
 * Both **un-acked** (still-predicted, `spawnSeq` present) and **acked-but-in-flight**
 * own shots are tested — they are *all* drawn at the present leading edge from the
 * predictor, so they are all sprites on screen. This matters because at any real
 * latency a shot is acked ~1 RTT after firing (≈66ms ≈ tens of px of travel), so a
 * shot that reaches an enemy at combat range is almost always already acked; gating
 * on un-acked alone meant the feedback only ever fired point-blank. The caller
 * distinguishes the two by whether `spawnSeq` is present (see `CosmeticHit`): an
 * un-acked shot is retracted from the prediction replay (`Predictor.markHit`); an
 * acked shot is suppressed from the render view by id until the server removes it.
 */

import { shipConfig } from "../config";
import { isAlive } from "../sim/player";
import type { Player, PlayerId, Projectile } from "../sim/types";

/** One cosmetic hit to surface: where to draw it, who it struck, the projectile's
 *  stable view `id` (so the caller can suppress it from the render view), and — for
 *  an *un-acked* shot only — the spawning input `spawnSeq` (so the caller can retract
 *  it from the prediction replay instead). `spawnSeq` absent ⇒ the shot is already
 *  acked and lives in the snapshot stream; suppress it by id. */
export interface CosmeticHit {
  kind: Projectile["kind"];
  x: number;
  y: number;
  target: PlayerId;
  projectileId: number;
  spawnSeq?: number;
}

export class PredictedHitDetector {
  /** Projectile view-ids already detonated once, so a shot fires its cosmetic effect
   *  exactly once and is then skipped (and stopped by the caller). Keyed by id — not
   *  `spawnSeq` — so it covers acked shots too (which carry no `spawnSeq`, only a
   *  stable positive server id). Pruned each `detect()` to the ids still in flight. */
  private readonly hit = new Set<number>();

  /**
   * Find newly-overlapping own in-flight projectiles against the drawn enemies.
   * `projectiles` are the predictor's own shots (un-acked predicted *and* acked
   * seeded, both advanced to the present leading edge — what's drawn); `enemies`
   * are the interpolated remote players (the caller passes everyone but the local
   * player). Each projectile detonates at most once.
   */
  detect(projectiles: readonly Projectile[], enemies: readonly Player[]): CosmeticHit[] {
    // Prune ids no longer in flight (server removed them, or the predictor retracted
    // them): they can't re-detonate, so dropping them bounds the set.
    const live = new Set(projectiles.map((p) => p.id));
    for (const id of this.hit) if (!live.has(id)) this.hit.delete(id);

    const out: CosmeticHit[] = [];
    for (const p of projectiles) {
      if (this.hit.has(p.id)) continue; // already detonated once
      for (const e of enemies) {
        if (!isAlive(e)) continue; // a respawning ghost can't be hit
        const reach = p.radius + shipConfig(e.shipType).radius;
        const dx = p.x - e.kinematics.x;
        const dy = p.y - e.kinematics.y;
        if (dx * dx + dy * dy <= reach * reach) {
          this.hit.add(p.id);
          out.push({ kind: p.kind, x: p.x, y: p.y, target: e.id, projectileId: p.id, spawnSeq: p.spawnSeq });
          break; // one hit per projectile
        }
      }
    }
    return out;
  }

  /** Whether the projectile `id` has already cosmetically detonated this frame/earlier
   *  — used to skip rendering it the same frame it detonates (an un-acked shot is
   *  retracted from the *next* rebuild; an acked shot is suppressed by the caller). */
  isHit(id: number): boolean {
    return this.hit.has(id);
  }
}
