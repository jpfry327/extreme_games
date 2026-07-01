/**
 * Client-side incoming-hit *feedback* — the defender-side mirror of
 * `PredictedHitDetector` (M2.11).
 *
 * With remote projectiles rendered at the estimated server present and the
 * local ship predicted at present, the two sprites the defender watches — the
 * enemy bullet and their own ship — finally live on one timeline. The moment
 * they overlap is (to within prediction error) the moment the server's
 * authoritative overlap test fires, so the "you've been hit" flash can be drawn
 * *now* instead of ~interpDelay + RTT/2 later. This restores the original
 * Subspace feel the server-authoritative model gave up: when a bullet reaches
 * you, you know immediately.
 *
 * Cosmetic only, exactly like the own-shot detector: damage, energy, and death
 * stay 100% server-authoritative. The false-positive trade is the same too — a
 * bullet the server scores as a miss (we dodged inside the lag-comp window)
 * draws a flash that did no damage; energy/HUD come from the snapshot, so
 * nothing desyncs. The caller dedups the authoritative `shipHit` twin (and
 * never suppresses a fatal one — the killing blow always draws
 * authoritatively).
 */

import { shipConfig } from "../config";
import { isAlive } from "../sim/player";
import type { Player, PlayerId, Projectile } from "../sim/types";

/** One cosmetic incoming hit: where to draw it, who fired, and the projectile's
 *  stable server id (so the caller can stop drawing the bullet — it ends here). */
export interface IncomingHit {
  kind: Projectile["kind"];
  x: number;
  y: number;
  by: PlayerId;
  projectileId: number;
}

export class IncomingHitDetector {
  /** Projectile ids already flashed once, so each incoming shot fires its effect
   *  exactly once. Pruned each `detect()` to the ids still in flight. */
  private readonly hit = new Set<number>();

  /**
   * Find remote shots newly overlapping the local ship as drawn. `remoteShots`
   * are the present-timeline remote projectiles (`RemoteProjectileSimulator`);
   * `me` is the local *predicted* player (present). Each projectile flashes at
   * most once.
   */
  detect(remoteShots: readonly Projectile[], me: Player | null): IncomingHit[] {
    // Prune ids no longer in flight (server removed them): bounds the set.
    const live = new Set(remoteShots.map((p) => p.id));
    for (const id of this.hit) if (!live.has(id)) this.hit.delete(id);

    if (!me || !isAlive(me)) return [];
    const myRadius = shipConfig(me.shipType).radius;

    const out: IncomingHit[] = [];
    for (const p of remoteShots) {
      if (this.hit.has(p.id)) continue; // already flashed once
      const reach = p.radius + myRadius;
      const dx = p.x - me.kinematics.x;
      const dy = p.y - me.kinematics.y;
      if (dx * dx + dy * dy <= reach * reach) {
        this.hit.add(p.id);
        out.push({ kind: p.kind, x: p.x, y: p.y, by: p.owner, projectileId: p.id });
      }
    }
    return out;
  }

  /** Whether projectile `id` already cosmetically hit — used to hide it the same
   *  frame it flashes, so the bullet stops at the ship instead of passing through. */
  isHit(id: number): boolean {
    return this.hit.has(id);
  }
}
