/**
 * ============================================================================
 *  TUNING CONFIG  —  edit numbers here to change how the game feels.
 * ============================================================================
 *
 * Ship + weapon values are ported from the REAL Extreme Games config
 * (original_data/extreme_games_config.ini). That file stores values in classic
 * Subspace integer units; the conversions below turn them into the per-tick
 * units our 100Hz simulation uses. The conversions were validated against the
 * svs settings.json (e.g. its rotation 0.051836 back-solves to a raw rotation
 * of ~330, exactly between EG's Initial 300 and Maximum 360).
 *
 *   Subspace raw  ->  our per-tick unit
 *   ----------------------------------------------------------------
 *   Speed         ->  px/tick   = raw / 1000          (3200 -> 3.2)
 *   Thrust        ->  px/tick^2 = raw / 1000          (30   -> 0.030)
 *   Rotation      ->  rad/tick  = raw * PI / 20000    (300  -> 0.0471)
 *   Recharge      ->  energy/tick = raw / 1000        (3000 -> 3.0)
 *   Energy        ->  used directly                   (1650)
 *   AliveTime     ->  ticks, used directly  (value is in 1/100 s)
 *   FireDelay     ->  ticks, used directly  (value is in 1/100 s)
 *   FireEnergy    ->  used directly
 *
 * Per the architecture (§2.5), tunables live in tables keyed by ship type, with
 * an Initial AND a Maximum tier. A fresh Warbird flies at Initial; collecting
 * green prizes ramps it toward Maximum (the lobby default, wired in M4). M0
 * keeps spawning at Initial so gameplay is unchanged from the prototype.
 */

const DEG_TO_RAD_TICK = Math.PI / 20000; // raw rotation -> radians/tick

// --- Simulation clock --------------------------------------------------------
export const TICK_HZ = 100; // Subspace runs the sim at 100Hz
export const TICK_DT = 1 / TICK_HZ; // seconds per tick (0.01s)

// --- Map ---------------------------------------------------------------------
export const TILE_SIZE = 16; // each tile is 16x16 px (Subspace standard)
export const MAP_TILES = 1024; // svs map is 1024x1024 tiles
export const WORLD_SIZE = MAP_TILES * TILE_SIZE; // 16384 px square

// --- Ship type identity ------------------------------------------------------
// Subspace has 8 ships, indexed 0..7 (Warbird..Shark). "spectator" is a
// non-flying observer slot. M0 only fills in the Warbird.
export type ShipType = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const WARBIRD: ShipType = 0;

/** Per-tier movement + survivability stats. EG gives an Initial and a Maximum;
 *  green prizes interpolate between them. (See the file header for units.) */
export interface ShipTier {
  rotationPerTick: number; // rad/tick
  thrust: number; // px/tick^2
  maxSpeed: number; // px/tick
  maxEnergy: number;
  rechargeRate: number; // energy/tick
}

/** Settings for one weapon (gun or bomb) at fire time + in flight. */
export interface WeaponConfig {
  speed: number; // px/tick, added to the firer's velocity
  fireDelayTicks: number; // cooldown between shots
  lifetimeTicks: number; // ticks before it ages out
  fireEnergy: number; // energy debited per shot
  damage: number; // applied to a hit ship (unused until M1 combat)
  radius: number; // collision half-extent, px
  bounces: number; // wall bounces before it dies (Infinity = bounce forever)
}

/** Everything tunable about one ship, ported from its EG `.ini` section. */
export interface ShipConfig {
  name: string;
  directions: number; // discrete facing steps (and sprite frames)
  radius: number; // ship collision half-extent, px
  bounceFactor: number; // wall-bounce velocity retention
  drag: number; // velocity retained per tick (1.0 = frictionless space)

  // Afterburner (hold Shift) is a modern extra — classic Subspace has none.
  // Tuned by feel, not from the EG config.
  afterburner: { maxSpeed: number; thrust: number; energyPerTick: number };

  initial: ShipTier; // freshly-spawned, un-upgraded
  maximum: ShipTier; // fully prized-up (lobby default from M4 on)

  bullet: WeaponConfig;
  bomb: WeaponConfig;
}

// --- The ship table ----------------------------------------------------------
// Only the Warbird is authored in M0 (per the roadmap). The remaining 7 are
// added in M4 straight from the `.ini`. `Partial` keeps that honest: TypeScript
// forces callers through `shipConfig()`, which throws on an unauthored ship
// rather than silently flying a phantom.
export const SHIPS: Partial<Record<ShipType, ShipConfig>> = {
  [WARBIRD]: {
    name: "Warbird",
    directions: 40,
    radius: 14, // Radius=0 means "use default" = 14 px (matches svs xRadius/yRadius)
    bounceFactor: 16 / 26, // EG [Misc] BounceFactor=26 -> retention 16/N = 0.615
                           //   (N=16 is lossless; svs ran a bouncier 22 = 0.727)
    drag: 1.0, // classic Subspace is frictionless (space!)
    afterburner: { maxSpeed: 5.0, thrust: 0.06, energyPerTick: 5 },

    initial: {
      rotationPerTick: 300 * DEG_TO_RAD_TICK, // InitialRotation=300 -> 0.0471 rad/tick
      thrust: 30 / 1000, // InitialThrust=30   -> 0.030 px/tick^2
      maxSpeed: 3200 / 1000, // InitialSpeed=3200  -> 3.2 px/tick
      maxEnergy: 1650, // InitialEnergy=1650
      rechargeRate: 3000 / 1000, // InitialRecharge=3000 -> 3.0 energy/tick
    },
    maximum: {
      rotationPerTick: 360 * DEG_TO_RAD_TICK, // MaximumRotation=360
      thrust: 33 / 1000, // MaximumThrust=33
      maxSpeed: 3500 / 1000, // MaximumSpeed=3500
      maxEnergy: 2800, // MaximumEnergy=2800
      rechargeRate: 4200 / 1000, // MaximumRecharge=4200
    },

    bullet: {
      speed: 4100 / 1000, // BulletSpeed=4100 -> 4.1 px/tick
      fireDelayTicks: 6, // BulletFireDelay=6 (energy cost is what really gates it)
      lifetimeTicks: 65, // BulletAliveTime=65 ticks (~0.65s)
      fireEnergy: 22, // BulletFireEnergy=22
      damage: 210, // BulletDamageLevel=210 (unused until M1)
      radius: 2,
      bounces: Infinity, // EG bullets bounce until their lifetime runs out
    },
    bomb: {
      speed: 4300 / 1000, // BombSpeed=4300 -> 4.3 px/tick
      fireDelayTicks: 175, // BombFireDelay=175 (~1.75s between bombs)
      lifetimeTicks: 250, // BombAliveTime=250 ticks (~2.5s)
      fireEnergy: 325, // BombFireEnergy=325
      damage: 5600, // BombDamageLevel=5600 (unused until M1)
      radius: 4,
      bounces: 0, // BombBounceCount=0
    },
  },
};

/** Look up a ship's config, throwing if it isn't authored yet. Use this rather
 *  than indexing `SHIPS` directly so an unfinished ship fails loudly. */
export function shipConfig(type: ShipType): ShipConfig {
  const cfg = SHIPS[type];
  if (!cfg) throw new Error(`No ShipConfig authored for ship type ${type}`);
  return cfg;
}

// --- Combat & scoring (M1) ---------------------------------------------------
// Arena-wide combat rules, ported from the EG `.ini`. Unlike ship stats these
// aren't per-ship — they're properties of the game mode. (Per-weapon damage
// already lives on each ship's `bullet`/`bomb` WeaponConfig above.)
export const COMBAT = {
  /** [Bomb] BombExplodePixels — radius of a bomb's blast. A bomb deals its full
   *  damage at the center and falls off linearly to 0 at this distance. */
  bombExplodePixels: 18,

  /** [Kill] EnterDelay — ticks a killed player waits before respawning. 200
   *  ticks @100Hz = 2s, the EG lobby value. */
  enterDelayTicks: 200,

  /** [Kill] BountyIncreaseForKill — flat bounty the killer gains per kill. The
   *  victim's own bounty is also rolled into the killer's *score* (below). */
  bountyIncreaseForKill: 10,

  /** [Kill] RewardBase — flat points per kill, on top of the victim's bounty.
   *  EG runs this at 0 (score is purely the victim's bounty). */
  killPointsBase: 0,
} as const;

// --- Upstream input batching (M2.15) -----------------------------------------
// The client coalesces a render frame's per-tick commands into one datagram and
// re-sends the newest few un-acked inputs for redundancy, instead of one framed
// message per 10ms tick (~100 msg/s). The server consumes one command per tick
// and dedups the redundant overlap by `seq`, so the inputs themselves and the
// M2.4 replay are unchanged — only the wire packaging differs.
export const INPUT = {
  /** Upstream flush cadence (ms). ~16ms ≈ one per render frame ≈ 60Hz, which
   *  sends inputs at essentially the same instant they go out today → ~0 added
   *  uplink latency, just coalesced (~100 → ~60 msg/s). Raise toward ~33ms
   *  (~30Hz) to cut packets further at the cost of up to that much added
   *  input-uplink latency (NOT the downstream view of other players, which is
   *  untouched). */
  sendIntervalMs: 16,

  /** Redundancy: the newest N un-acked inputs are included in every datagram, so
   *  a single dropped datagram is covered by the next one without a round-trip.
   *  ~10 covers several lost datagrams at 60Hz; inputs are tiny so the byte cost
   *  is negligible, and the server dedups the overlap by `seq`. */
  redundantTicks: 10,

  /** Closed-loop input pacing (M2.17 Phase C). The server consumes exactly one
   *  input per tick, and nothing else drains a standing queue once one forms —
   *  client/server clock-rate drift or clumped delivery parks a 2–6 tick backlog
   *  that adds `depth × 10ms` to *every* subsequent input, or starves the queue
   *  so the server pads with repeat-last (mispredictions). The M2.11 stopgap
   *  (`MAX_BUFFERED` drop-oldest in serverInput.ts) bounds the damage lossily;
   *  this is the principled fix its comment promised: a slow feedback loop on
   *  the client's input-production clock, driven by the `inputBufferDepth` the
   *  server already stamps into every snapshot. Only how wall time maps to tick
   *  production changes — the 1:1 seq-per-tick model, the M2.4 replay, and the
   *  server's seq-ordered consumption are indifferent to it. */
  pacing: {
    enabled: true,
    /** Standing queue depth to hold (ticks). ~1.5 keeps one command always
     *  ready (no repeat-last starvation) plus half a tick of jitter slack,
     *  while adding only ~15ms of queue wait — the low end of the 1.5–2
     *  sweet spot since the redundant resends already cover loss. */
    targetDepthTicks: 1.5,
    /** EWMA weight per depth report (one per snapshot, ~50/s). The raw depth
     *  oscillates tick-to-tick with delivery clumping; 0.03/report halves the
     *  error in ~23 reports ≈ 0.5s, smoothing over ~1s without making the
     *  loop sluggish. */
    depthSmooth: 0.03,
    /** Proportional gain: pace change per tick of depth error. 0.01 → a 1-tick
     *  standing error retunes the clock by 1%, draining/filling ~1 tick/second
     *  — convergence time constant ≈ 1s, well inside stability for a loop
     *  whose feedback arrives within ~RTT + 20ms. */
    gainPerTick: 0.01,
    /** Bound on the pace scale (±fraction). ±2% mirrors the tick clock's slew
     *  bound reasoning: imperceptible as motion (the predicted ship's tick
     *  cadence shifts by ≤0.2ms/tick) yet ±2 ticks/second of authority — plenty
     *  to track real clock drift (crystal skew is ~±0.01%). */
    maxScale: 0.02,
  },
} as const;

// --- Networking (M2) ---------------------------------------------------------
// Client-side netcode tuning. The server's port + broadcast rate live in
// server/index.ts; these are values the browser client needs.
export const NET = {
  /** How far in the past (ms) remote entities are rendered, so the client always
   *  has two buffered snapshots straddling render time to interpolate between.
   *  ~2 snapshots at the ~33Hz broadcast rate (≈30ms gap). Bigger = smoother under
   *  jitter but more visible lag on other ships. (roadmap M2.2 / architecture §5.2)
   *
   *  Failure mode it guards: too small and a single late/jittered snapshot leaves
   *  the buffer empty at render time, forcing extrapolation (below).
   *
   *  M2.11: this is now the **initial / fallback** value. When `adaptiveInterp` is
   *  enabled the live delay is driven from measured snapshot spacing + jitter (see
   *  `AdaptiveInterpDelay`), starting here and clamped to `[minMs, maxMs]`; with it
   *  off, this fixed value is used as before. */
  interpDelayMs: 75,

  /** Adaptive interpolation delay (M2.11). Instead of a fixed `interpDelayMs`, the
   *  client raises/lowers the delay to track the link: enough buffer to always have
   *  a straddling snapshot pair (≈ spacing) plus a lateness cushion, so a jittery
   *  connection stops starving the buffer (the "remote ships jump" symptom) without
   *  permanently over-delaying a clean one.
   *
   *    target = clamp(meanIntervalMs * spacingFactor + latenessMs * latenessFactor,
   *                   minMs, maxMs)
   *
   *  The live value eases toward `target` with an asymmetric half-life — raise fast
   *  (avoid starvation now), lower slowly (don't add-then-remove lag on every
   *  jitter blip), so the delay itself never visibly time-warps the remote ships. */
  adaptiveInterp: {
    enabled: true,
    /** Absolute floor (ms). The *effective* floor is spacing-relative —
     *  `max(minMs, meanIntervalMs × spacingFactor)` inside `AdaptiveInterpDelay`
     *  — so it re-derives from the measured broadcast gap (≥1.5 × the 20ms gap
     *  at the 50Hz rate = 30ms) instead of hard-coding a rate. This value is
     *  only the safety net under a mismeasured/absurdly small interval. History:
     *  the old 50 was sized as "~2 gaps at 33Hz" and silently donated ~20ms of
     *  unnecessary remote-view delay after M2.16 moved broadcasts to 50Hz
     *  (M2.17 Phase B). */
    minMs: 30,
    /** Ceiling (ms). 120 ≈ 4 broadcast gaps + a 60ms cushion. The old 200
     *  existed to absorb burst-inflated "jitter" that the tick clock + p90
     *  lateness no longer misread; real sustained lateness past 120ms is a
     *  stall, which delay can't hide anyway (extrapolate/freeze handles it).
     *  Budget: shooter comp ≈ RTT + this, so 120 + ~100ms RTT stays inside
     *  `LAGCOMP.maxCompTicks` — and this ceiling directly bounds the victim's
     *  "dodged but still died" rewind window, the fairness cost the old cap
     *  amplified. */
    maxMs: 120,
    /** Multiple of the mean snapshot interval to buffer (≥1 → always a newer
     *  sample to interpolate toward; 1.5 leaves half a gap of slack). */
    spacingFactor: 1.5,
    /** Multiple of the p90 snapshot lateness (vs the tick timeline — see
     *  `NetHealth.latenessMs`) added as cushion above the spacing term. p90 is
     *  already near worst-case, so only a modest margin on top — ×2 of it
     *  chronically over-delayed. */
    latenessFactor: 1.25,
    /** Half-life (ms) for *raising* the delay — fast, to outrun a starving buffer. */
    raiseHalfLifeMs: 150,
    /** Half-life (ms) for *lowering* it. The p90-over-window lateness signal is
     *  already stable (the old 3000 was double-smoothing on top of a spiky
     *  EWMA), so recovery from a genuine spike can be twice as fast without the
     *  delay itself time-warping remote ships. */
    lowerHalfLifeMs: 1500,
  },

  /** Server-tick clock estimation (`net/tickClock.ts`) — the timebase that lets
   *  interpolation run on the server's tick timeline instead of packet arrival
   *  times (which TCP stalls turn into bursts). The windowed-min offset is
   *  burst-immune (packets can only be *late*, never early); the applied offset
   *  slews toward it at ≤`slewMaxMsPerSec` so the timeline never visibly steps,
   *  and snaps only past `snapThresholdMs` (reconnect / tab-return). */
  tickClock: {
    /** Windowed-min horizon (ms) — a few fast deliveries always land inside. */
    windowMs: 3000,
    /** Rotating min-bucket width (ms): windowMs/bucketMs buckets, O(1)/snapshot. */
    bucketMs: 500,
    /** Max applied-offset slew (ms/s) → ≤2% time dilation, imperceptible. */
    slewMaxMsPerSec: 20,
    /** Raw-vs-applied gap beyond this (ms) snaps instead of slewing. */
    snapThresholdMs: 250,
  },

  /** Present-time remote projectiles. Remote bullets/bombs are simulated forward
   *  from the newest snapshot to the *estimated server present* (they're pure
   *  deterministic flight — no input — so this is near-exact), instead of the
   *  ships' interpolated past. This is what lets the defender actually see the
   *  bullet that is about to hit them where it really is. */
  remotePresent: {
    /** Cap (ms) on how far past its snapshot a remote shot may be simulated.
     *  Covers interp-delay + RTT on a healthy link with margin; during a longer
     *  stall the shot freezes at the cap (the ships' extrapolation-freeze
     *  philosophy) instead of flying on unbounded stale state. */
    maxLeadMs: 250,
  },

  /** When the snapshot buffer starves (a lag spike or a run of dropped snapshots
   *  leaves no sample newer than render time), remote entities are dead-reckoned
   *  forward from their last known velocity for at most this long, then frozen in
   *  place. Caps how far a wrong guess can drift before the next snapshot snaps it
   *  back — a small visible glide instead of either a hard freeze or an unbounded
   *  fly-off. (roadmap M2.5: "extrapolation window + clamp") */
  extrapolateMaxMs: 100,

  /** Reconciliation correction smoothing (roadmap M2.5). When a snapshot corrects
   *  the predicted local ship, the residual error is absorbed into a render-offset
   *  that decays to zero with this half-life rather than snapping. Smaller =
   *  tighter/snappier correction; larger = floatier but gentler. 80ms ≈ the error
   *  is ~halved every 5 frames at 60fps, gone within ~a quarter second. */
  correctionHalfLifeMs: 80,

  /** A correction bigger than this (px) is treated as a teleport — a respawn or a
   *  genuine divergence — not a misprediction to smooth. Smoothing a map-spanning
   *  jump would slide the ship visibly across the screen, so beyond this we drop
   *  the offset and let it snap. ~9 ship-radii. */
  maxSmoothDistancePx: 128,

  /** Default in-transport network-simulator parameters (roadmap M2.5). Applied
   *  symmetrically to each direction (client→server inputs and server→client
   *  snapshots). Off by default; toggled and tuned live from the #netsim debug
   *  panel so bad conditions are reproducible on demand. These are the *defaults*
   *  the panel initializes to — the live values live on the SimulatedTransport. */
  netSim: {
    enabled: false,
    /** One-way base added latency, ms, each direction (so ~2× added RTT). */
    latencyMs: 80,
    /** Uniform ± jitter, ms, added to each packet's latency (reorders packets). */
    jitterMs: 30,
    /** Per-packet drop chance, percent, each direction. */
    lossPct: 3,
    /** TCP-stall simulation (hold everything `stallMs`, deliver as one burst,
     *  every `stallEveryMs`) — the WebSocket/TCP head-of-line-blocking signature
     *  of a retransmit or buffering proxy. 0 = off. Try 300 / 2000 to reproduce
     *  the "deployed on TCP feels desynced" conditions locally. */
    stallMs: 0,
    stallEveryMs: 0,
  },
} as const;

// --- Server-side lag compensation (M2.9) -------------------------------------
// "What you see is what you hit." The server adjudicates each projectile hit
// against where its targets were in the *firer's* view at the moment the shot
// was sampled — not the server's present — so a shot that visually connects on
// your screen registers despite the interpolation delay (~interpDelayMs) and the
// wire. The amount of rewind rides in each input (`InputCommand.renderTick`) and
// is stamped onto the spawned projectile (`Projectile.compTicks`), so the server
// stays a pure function of its inputs — the determinism contract still holds.
export const LAGCOMP = {
  /** Length of the server's per-tick pose-history ring (ticks). Must comfortably
   *  exceed the largest rewind we ever apply — interpDelay (~7.5t @75ms) + max
   *  RTT/2 + jitter — so a lookup `compTicks` ago is still in range. 120t = 1.2s
   *  @100Hz, matching the roadmap's sizing. Runtime-only; never serialized. */
  historyTicks: 120,

  /** Hard cap on a single projectile's `compTicks` (ticks). The dial on the
   *  favour-the-shooter trade: it bounds how far back a target can be rewound, so
   *  a very laggy — or spoofed — client can't reach arbitrarily far into the past,
   *  and — more importantly for *feel* — it bounds the "I dodged behind cover and
   *  still got hit" unfairness the rewind imposes on the *victim* (the cost lag
   *  comp pays to make the shooter feel instant).
   *
   *  18t = 180ms. The real *view* delay a shot must compensate is the interp
   *  delay **plus the full RTT**. With the tick-timeline clock the interp delay
   *  settles at ~50–70ms on a clean ~70ms-RTT link (needed comp ≈ 120–140ms),
   *  and its ceiling is now 120ms (`adaptiveInterp.maxMs`), so 18t covers a
   *  100ms-RTT + 80ms-interp link exactly and the common case with margin.
   *  History: M2.11 raised 15t→25t because the old arrival-time jitter estimate
   *  pushed interp to 200ms and shots clamped ("bombs hit but don't register");
   *  with that mismeasurement fixed, 250ms mostly bought a bigger victim-side
   *  dodge-then-die window, so this steps back down in the victim's favour.
   *  Guard rail: the overlay's `clamp N/s` line — if clamps show up at moderate
   *  RTT in live tests, step toward 20–22t. Also implicitly capped by
   *  `historyTicks-1` (you can't rewind past what's recorded). */
  maxCompTicks: 18,
} as const;

// --- Area-of-interest culling (M2.14) ----------------------------------------
// Each client is sent only the entities near it — the per-client snapshot filter
// (`net/aoi.ts`) mirrors Subspace's `max(WeaponRange, screen)` rule. M2.14 does
// distance culling only; stealth/cloak concealment plugs into the same filter in
// M5. Snapshot size then scales with local density, not arena population.

/** Longest distance (px) any weapon can travel = max over authored ships of
 *  `speed * lifetimeTicks` (a bullet bounces but still dies at its lifetime, so
 *  that product is its true reach). Recomputed from `SHIPS` so it tracks config
 *  as the remaining ships are authored in M4. Floored so a partial table still
 *  yields a sane AOI. */
function computeWeaponReach(): number {
  let reach = 512; // floor — covers an empty/partial ship table
  for (const ship of Object.values(SHIPS)) {
    if (!ship) continue;
    reach = Math.max(
      reach,
      ship.bullet.speed * ship.bullet.lifetimeTicks,
      ship.bomb.speed * ship.bomb.lifetimeTicks,
    );
  }
  return reach;
}

export const AOI = {
  /** Screen half-extents (px) a client can see around its ship. The include test
   *  is rectangular (a viewport, like Subspace) expanded by `weaponReach` on each
   *  axis — i.e. you receive anything on your screen OR close enough to shoot you,
   *  which is the `max(WeaponRange, screen)` rule in AABB form. ~1520×1200 view. */
  viewHalfWidth: 760,
  viewHalfHeight: 600,
  /** Longest weapon reach (px), derived from `SHIPS` (see above). Added to the
   *  view half-extents so a long-range bomb stream is received before it's drawn. */
  weaponReach: computeWeaponReach(),
  /** Hysteresis band (px) added to the include box for entities the viewer
   *  already received last broadcast, so an entity hovering at the boundary
   *  doesn't flicker in/out every frame. ~2 ship-radii of slack. */
  hysteresisPx: 96,
} as const;
