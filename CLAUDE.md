# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Vite dev server at http://localhost:5173
npm run server       # Node headless game server (tsx --watch server/index.ts)
npm run build        # TypeScript typecheck + production build
npm run preview      # Serve the production build
npm test             # Run tests once (vitest run)
npm run test:watch   # Run tests in watch mode
```

Run a single test file: `npx vitest run src/sim/sim.test.ts`

## Architecture

Read `docs/architecture.md` for the full contract. Every feature must fit the four-layer model before being written.

### The golden rule

**`src/sim/` is pure game logic — no Pixi, no DOM, no `Math.random()`.**  
The same sim code runs on the browser client and the Node headless server. Any import of `pixi.js` or DOM APIs in `sim/` breaks this.

### The four layers

| Layer | Where | Rule |
|---|---|---|
| **A — Sim state** (`sim/types.ts`) | Server-authoritative | Plain, JSON-serializable data. No methods. |
| **B — Sim systems** (`sim/systems/`, `sim/world.ts`) | Server | Pure `(world, ctx) → void` functions. No I/O. No randomness outside `world.rng`. |
| **C — Events** (`world.events`) | Server → client | Transient, fire-and-forget, drained each frame. Never stored in snapshots. |
| **D — Client** (`render/`, `input/`, future `ui/`, `audio/`) | Client only | Reads Layer A + drains Layer C. Never mutates sim state directly; sends `InputCommand`s instead. |

### Tick pipeline

`World.step()` runs at a fixed **100Hz**. It is an explicitly ordered list of systems — the order is a design decision, not an implementation detail:

```
1. intent       2. movement     3. firing       4. items
5. projectiles  6. collision    7. damage       8. death/respawn
9. status       10. resources   11. prizes      12. objectives
13. regions     14. (events accumulated → client drains)
```

Steps 7–8 (damage / death / respawn) are the keystone for all competitive features.

### Data model highlights

- `World.players: Map<PlayerId, Player>` — never a singleton `ship`.
- `Player` is grouped components: `kinematics`, `resources`, `loadout`, `status`, `combat`.
- `Projectile` carries a stable server-assigned `id` for snapshot diffing.
- `world.events: GameEvent[]` — produced by systems, drained by the renderer and audio each frame.
- `world.rng` — seeded deterministic RNG; never `Math.random()` in sim. Determinism is a hard requirement for client-side prediction.

### Config

`src/config.ts` is the source of truth for every tunable gameplay number, ported from `original_data/extreme_games_config.ini`. The file documents unit conversions. Config grows into `SHIPS: Record<ShipType, ShipConfig>` tables as the 8 ships are added (M4).

### Networking shape (`src/net/`)

Three wire message types (JSON for now):
1. **`InputCommand`** (client → server) — player intent; never state.
2. **`Snapshot`** (server → client) — serialized Layer A state. Because Layer A is plain data, the snapshot essentially *is* the world.
3. **`GameEvent[]`** (server → client) — Layer C, for effects/audio/kill-feed.

`Transport` is an interface (`src/net/transport.ts`); `LoopbackTransport` and `WebSocketTransport` are interchangeable implementations. Swapping them is a one-line change in `main.ts`.

Snapshots are **per-client** (`serializeSnapshotFor(world, playerId)`), which is where stealth/AOI culling will live. Build this seam per-client even when first version sends everyone everything.

### Render / interpolation

- `FixedLoop` in `sim/loop.ts` accumulates real elapsed time and drives exact 10ms sim steps.
- The renderer runs per `requestAnimationFrame`, interpolating between `prevX/prevY/prevRotation` (previous tick) and current state using the leftover `alpha`.
- For remote players under the multiplayer transport, this same mechanism extends to interpolating between buffered server snapshots with `interpDelay` (~100ms).

## Current milestone status

Per `docs/roadmap.md`, M2.5 (correction smoothing & network-condition hardening) is complete. The sequence is:
```
M0 ✓ → M1 ✓ → M2.0 ✓ → M2.1 ✓ → M2.2 ✓ → M2.3 ✓ → M2.4 ✓ → M2.5 ✓ → M2.6 (projectile/weapon prediction) → ...
```

M2.5 added four things on top of M2.4's rewind-and-replay:
- **`net/networkSimulator.ts`** (`SimulatedTransport`): wraps any `Transport` and injects added
  latency, jitter, and packet loss in both directions. Toggled and tuned live from the `#netsim`
  DOM panel (top-right, below the netcode overlay). Off by default; the handshake is on the inner
  transport so joins never block under simulated loss.
- **`net/reconciliationSmoother.ts`** (`ReconciliationSmoother`): absorbs the pose discontinuity
  produced by each reconciliation into a decaying render-offset, so corrections ease in rather than
  snap. Zero offset in steady state → no added latency; blips only on a real misprediction.
- **Bounded extrapolation** in `net/interpolation.ts`: when the snapshot buffer starves (lag spike
  / dropped packets), remote entities dead-reckon from their last velocity for up to
  `NET.extrapolateMaxMs` (100ms) then freeze, rather than hard-holding the stale pose.
- **`net/determinism.test.ts`**: two independent `World`s driven through the same input stream stay
  byte-identical every tick (via `serializeSnapshotFor`); rewind-and-replay reproduces a
  continuously-stepped world exactly. Guards the prediction contract the whole milestone rests on.

The netcode debug overlay was updated to M2.5 and shows `smooth off Npx` (decaying correction
offset) and `netsim Xms ±Yms Z% loss` or `netsim off`.

## Key constraints

- **No ECS library.** Plain arrays of structs + ordered system functions. ECS indirection fights snapshotting and determinism.
- **Entities stay plain data; behavior lives in systems.** Methods on entities make snapshotting harder.
- **UI is bitmap-font-in-Pixi, not DOM.** The original font PNGs are rendered via Pixi `BitmapText` to stay pixel-identical with the game art at any scale. A hidden DOM `<input>` handles text entry only.
- **Per-client snapshots from day one.** Even if first version sends everyone everything, the `serializeSnapshotFor(world, playerId)` seam must exist.
