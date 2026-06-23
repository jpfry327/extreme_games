/**
 * Seeded, deterministic pseudo-random generator for the simulation.
 *
 * The sim must be **deterministic**: given the same starting state and the same
 * inputs, every machine — and the server — must produce byte-identical results.
 * That is what makes client-side prediction and unit tests possible (see
 * architecture §5.2). `Math.random()` is therefore banned inside `src/sim/`;
 * any randomness (bomb shrapnel spread, prize rolls, spawn jitter) draws from a
 * `SeededRng` that lives on the `World` and is itself part of the serializable
 * state.
 *
 * The algorithm is mulberry32: a tiny, fast 32-bit generator that's more than
 * good enough for game randomness. Its entire state is a single uint32, so it
 * snapshots trivially.
 */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    // Coerce to a uint32 so behavior is identical regardless of how the seed
    // was produced.
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). The drop-in replacement for `Math.random()`. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Next integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Next float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** The raw generator state — the whole thing snapshots as one number. */
  get seed(): number {
    return this.state;
  }
}
