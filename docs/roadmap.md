# Roadmap

The build order. Each milestone is sequenced by **dependency** and ends in a
**playable build** — never a half-wired refactor you can't run. Features are
sequenced so the **shared systems** (damage, status, items, UI toolkit) land
before the many features that ride on them (see the reuse map in
[feature-catalog.md](feature-catalog.md)).

This doc is written so a **cold future session** can pick up any milestone from
here alone: each has a goal, what it unlocks, a concrete scope checklist, what's
explicitly *out* of scope (to keep it tight), and the playable end state. Always
read [architecture.md](architecture.md) first — it's the contract.

## Principles for every milestone

- **End playable.** Every milestone produces a build you can run and feel.
- **Stay net-ready.** Build against the multiplayer-shaped state from M0 even
  before the network exists. Never assume one player.
- **Config-driven.** New numbers go in `config.ts` / the ship tables, never
  inline. Source of truth is the EG `.ini`.
- **Sim stays pure & deterministic.** No Pixi/DOM/`Math.random()` in `sim/`.
  This is what makes the sim **unit-testable** — write tests for damage,
  collision, and physics; determinism means they're stable.
- **Sequence shared systems before their riders.** Don't build mines before the
  damage path; don't build chat before the UI toolkit.

---

## Sequencing at a glance

```
M0  Foundational refactor ........ multiplayer-shaped sim (no new gameplay)
M1  Combat core .................. damage/death/respawn/bounty (vs local bot)   ← keystone
M2  Multiplayer transport ........ server + snapshots + prediction              ← de-risks the core bet
M3  Client surfaces / UI ......... bitmap-font toolkit, chat, statbox, minimap
M4  All 8 ships .................. from config + sheets + ship select
M5  Special items & status ....... repel, burst, mines, toggles, super/shields
M6  Lobby polish ................. full statbox, menu, kill feed, sound, "max ship" mode
─── Phase 1 complete: a joinable, persistent EG-style lobby ───
P2  Competitive ................. flags/baseduel, powerball, bricks/doors, matchmaking, accounts
```

**Why this order:** combat (M1) is the keystone everything competitive needs, and
it can be validated cheaply against a local bot *before* netcode. Networking (M2)
is the project's biggest unknown — "does server-authoritative + prediction feel
good?" — so it comes early, while scope is still just Warbird + bullets/bombs.
Everything after rides on systems already proven.

---

## M0 — Foundational refactor

**Goal:** move the prototype onto the multiplayer-shaped architecture with **zero
gameplay change** — it still plays exactly like today, one local Warbird.

**Unlocks:** literally everything else. Every later feature assumes this shape.

**Scope:**
- [ ] `World.ship` → `players: Map<PlayerId, Player>`; grouped components
      (`kinematics/resources/loadout/status/combat`) per [arch §2](architecture.md).
- [ ] `step(input)` → `step(ctx)` where `ctx` carries per-player `InputCommand`s.
- [ ] Split the inlined `step()` into an **ordered system pipeline** under
      `sim/systems/` (start with `movement`, `firing`, `projectiles`). Document
      the order at the call site.
- [ ] Tag each `Projectile` with an owner `PlayerId`.
- [ ] Add `sim/rng.ts` (seeded) — no `Math.random()` in sim.
- [ ] Generalize `SHIP`/`BULLET`/`BOMB` consts → `SHIPS: Record<ShipType, ShipConfig>`
      tables in `config.ts` (only Warbird filled in for now, with Initial+Maximum).
- [ ] Renderer iterates `players`/`projectiles` collections instead of singletons.

**Out of scope:** any new feature, any second player, any new ship.

**Playable end state:** indistinguishable from today's prototype — but the
codebase is now ready for everything. (Good place for first sim unit tests.)

**Refs:** architecture §2, §3, §7.

---

## M1 — Combat core (the keystone)

**Goal:** make ships killable. Hit registration → damage → death → respawn →
bounty/points. Validate it **single-process against a local dev bot**.

**Unlocks:** kills, bounty, scoreboard, kill feed, flags, KotH — the entire
competitive half of the catalog. The prototype currently can't register a hit.

**Why a bot, not netcode yet:** damage is a pure sim system; it doesn't care
whether the second player's `InputCommand`s come from the network or a local AI.
A dummy/bot target validates combat feel cheaply, and — per your Chaos Zone
screenshot (ChaosBot0–8) — **lobby bots are a real feature**, so this code isn't
throwaway; it grows into lobby AI filler.

**Scope:**
- [ ] `systems/collision.ts`: projectile↔ship (use ship `Radius`).
- [ ] `systems/damage.ts`: apply bullet/bomb damage to `energy`; bomb radius
      (`BombExplodePixels`), proximity trigger. Emit `shipHit`.
- [ ] `systems/death.ts`: energy ≤ 0 → death; kill credit, bounty transfer
      (`BountyIncreaseForKill`), points (`killPoints`). Emit `shipDied`.
- [ ] `systems/respawn.ts`: respawn timer (`EnterDelay`), spawn points (`[Spawn]`).
- [ ] A trivial `Bot` that emits `InputCommand`s as a second player.
- [ ] Minimal on-screen kill feed + death explosion (reuse explode0–2/empburst).

**Out of scope:** networking, other ships, items, polished statbox, real AI.

**Playable end state:** you fight a bot — bullets/bombs hurt, you die, explode,
respawn; bounty and points tick; a kill line appears.

**Refs:** catalog §5; architecture §3 (pipeline steps 6–8), §4.

---

## M2 — Multiplayer transport

**Goal:** the authoritative server runs the sim headless; browsers connect and
fight on it with prediction-smooth movement and instant-feeling weapons. This is
the architecture's payoff and the project's biggest bet.

**Unlocks:** real multiplayer; replaces the bot with real players (the bot stays
as AI filler, now server-side). Proves the snapshot + prediction model against
real gameplay.

### Why M2 is split into M2.0–M2.7

A naive single-pass M2 produced **laggy weapons** (every shot waited a server
round-trip) and **jittery ships** (the client snapped to each snapshot instead of
deterministically replaying). Both regressions come from collapsing four
*independent* concerns — **transport**, **interpolation**, **prediction**, and
**reconciliation** — into one step, and from sharing a single `World` between the
sim and the renderer. So we build them as separate, individually playable slices.

The ordering rule: **get an honest, ugly, laggy build working first**
(M2.0–M2.2), *then* make it feel good one mechanism at a time (M2.3–M2.6). Never
add prediction before the authoritative path is provably correct — that's exactly
the mistake that caused the snapping last time.

**The mental model we're implementing** (architecture §5.2):

- The **server** is the single source of truth; it runs the existing
  `World.step()` at 100Hz, unchanged.
- The **client holds two worlds**: a *received* world (the last authoritative
  snapshot, used to interpolate everyone else) and a *predicted* world (the local
  player simulated ahead of the server).
- The **local player** is **predicted** (instant) then **reconciled** (rewind to
  the last ack, replay un-acked inputs). **Remote players** are **interpolated**
  (rendered slightly in the past). **Local projectiles** are **predicted** then
  reconciled to their server-spawned twin.

Each sub-step below ends in a build you can run and feel, and names exactly what
should *still* look wrong so the next step's improvement is visible.

**Refs (whole milestone):** catalog §10; architecture §5, §5.1, §5.2.

---

### M2.0 — Split the world across a loopback seam (no network yet)

**Goal:** introduce the client↔server boundary *in-process*, before any socket
exists, so we debug the snapshot model without network noise. **This is the
keystone of M2** — the naive attempt failed in large part because the sim and the
renderer shared one `World`.

**Scope:**
- [ ] `net/transport.ts`: a `Transport` interface (`sendInput(cmd)`,
      `onSnapshot(cb)`, lifecycle hooks) + a `LoopbackTransport` that passes calls
      straight through with zero delay.
- [ ] `net/server.ts` (in-process): a `GameServer` that owns the **authoritative**
      `World` + `FixedLoop`, ingests `InputCommand`s, and steps at 100Hz.
- [ ] `net/snapshot.ts`: `serializeSnapshotFor(world, playerId): Snapshot` and
      `applySnapshot(world, snap)`. `Snapshot` is the Layer-A subset (players +
      projectiles + `tick`). Build the **per-client signature now** even though it
      returns everyone (the filtering seam for stealth/AOI lands in M5).
- [ ] Stable entity ids: give `Projectile` a server-assigned `id` so snapshots can
      be diffed and tracked across ticks (players already have `id`).
- [ ] Client side: a separate **client `World`** that is *never stepped* — it is
      overwritten by `applySnapshot`. The renderer reads this client world.
- [ ] Rewire `main.ts`: keyboard → `transport.sendInput` → server; server snapshot
      → `applySnapshot` → renderer. The local player is in the snapshot like
      everyone else (no special-casing yet).

**Out of scope:** sockets, a second process, prediction, interpolation (the
snapshot is applied immediately, full-state, every tick), delta/AOI compression.

**Playable end state:** identical to M1 — you fight the bot — but every pixel on
screen now comes from a `serialize → deserialize` round-trip through the loopback.
It looks normal because loopback has zero latency. **If it plays exactly like M1,
the seam is correct.**

---

### M2.1 — WebSocket transport & a headless server process

**Goal:** replace the loopback with a real socket and a real second process. The
server runs on Node, headless, with **no rendering imports** — the proof that
`sim/` is pure.

**Scope:**
- [ ] `server/` entry: a Node process that constructs the sim `World` + `FixedLoop`
      and steps at 100Hz on a precise timer, importing only `sim/` + `config`.
- [ ] `WebSocketTransport` (client) implementing the same `Transport` interface as
      the loopback — swapping it should be a one-line change in `main.ts`.
- [ ] Wire protocol v0 in `net/protocol.ts`: `hello`/`welcome` handshake (server
      assigns the real `PlayerId`), `input` (client→server), `snapshot`
      (server→client). JSON to start; binary is a later optimization.
- [ ] Snapshot **send rate decoupled from tick rate** (step at 100Hz, broadcast at
      ~20–30Hz). The client still applies the latest snapshot directly — so the
      **local ship visibly lags by RTT and snaps**. This is expected; the wire is
      being honest.
- [ ] Connection lifecycle: a join adds a player at a server spawn; a disconnect
      removes them. Document the Vite dev-proxy / port wiring.

**Out of scope:** prediction, interpolation, input acks, reconnection, auth,
encryption (the VIE/Continuum protocol is explicitly out — see README/catalog
§10), delta/AOI culling.

**Playable end state:** open two browser tabs (or two machines) → both connect to
the one server → each sees the other move. It's laggy and rubber-bandy for your
*own* ship; that is correct for this step. The architecture's central claim — *the
same `sim/` runs headless on a server* — is now proven true.

---

### M2.2 — Entity interpolation for remote players

**Goal:** make *other* players smooth by rendering them ~100ms in the past,
interpolating between two buffered snapshots. Generalizes the existing
`prevX/prevY` tick-interp into snapshot-interp.

**Scope:**
- [ ] Client snapshot buffer: keep the last N snapshots with their server tick /
      receive timestamp.
- [ ] Render-time interpolation: for every **remote** entity, find the two
      snapshots straddling `renderTime = now − interpDelay` and lerp pose between
      them (reuse the renderer's blend, generalized to an arbitrary snapshot pair).
- [ ] `interpDelay` constant in config (start ~100ms ≈ 2–3 snapshots); tune to the
      snapshot rate.
- [ ] Entity add/remove across snapshots: spawns and leaves don't pop or smear
      (uses the stable ids from M2.0).
- [ ] Buffer-starvation fallback: when no future snapshot exists (lag spike),
      briefly hold/extrapolate instead of snapping.
- [ ] The **local player is still rendered from the latest authoritative snapshot**
      (still laggy) — we deliberately do *not* predict yet, to keep this step
      isolated.

**Out of scope:** local prediction, projectile prediction, server-side lag
compensation / rewind.

**Playable end state:** remote ships **glide smoothly** even at a low snapshot
rate and moderate latency. Your own ship still rubber-bands — the next steps fix
that, and the contrast makes the interpolation visibly working.

---

### M2.3 — Input sequencing, server buffering & acks

**Goal:** build the protocol scaffolding that reconciliation needs, with **no
behavioral change yet**. Deliberately a "plumbing only" step so the prediction
step that follows is small and focused.

**Scope:**
- [ ] Client stamps each `InputCommand` with a monotonic `seq` and the client tick
      it was sampled for; keeps a ring buffer of un-acked inputs.
- [ ] Send *every* input (don't drop on coalesced render frames) so the server has
      a continuous command stream; document the fixed-tick input model (one command
      per sim tick).
- [ ] Server per-player input buffer: apply the command whose `seq` matches the
      tick being stepped; if it's missing, repeat the last command (flagged) rather
      than idling.
- [ ] Server stamps each snapshot with `lastProcessedInputSeq` for the recipient
      (the **ack**).
- [ ] **Netcode debug overlay**: RTT, last-acked seq, server-tick vs client-tick,
      input-buffer depth. This HUD is the verification tool for M2.4–M2.6.

**Out of scope:** actually *using* the acks to correct anything (that's M2.4),
clock-sync sophistication, lag compensation.

**Playable end state:** plays exactly like M2.2 (own ship still laggy), but the
debug overlay now shows the server acking your inputs by sequence number. The data
plane for prediction is in place and inspectable.

---

### M2.4 — Client-side prediction + reconciliation for the local ship

**Goal:** make the local ship respond **instantly** and stop rubber-banding, via
**rewind-and-replay**. This is the direct fix for the *"jittery ship movement —
snapping instead of deterministic replaying"* regression.

**Scope:**
- [ ] A **predicted world** containing the local player, stepped locally every
      render frame through the *exact same* `sim/systems` (determinism is what
      makes this legal — architecture §5.2).
- [ ] On each authoritative snapshot: **reset** the local player to the acked
      server state, then **replay** every un-acked input (`seq >
      lastProcessedInputSeq`) through `World.step()` to re-derive "now." Drop acked
      inputs from the ring buffer.
- [ ] Render the local ship from the **predicted** world; render everyone else from
      the **interpolated received** world (M2.2). One renderer, two clearly
      separated sources.
- [ ] **Prediction-error metric** on the debug HUD: distance between predicted and
      authoritative local pose after replay. In clean conditions it must be ≈0 —
      this proves client/server determinism parity.
- [ ] Correct, **hard** reconciliation first: a visible snap on mismatch is
      acceptable *here*. Smoothing is the next step — we separate "the replay is
      correct" from "the correction is pretty."

**Out of scope:** correction smoothing, projectile prediction,
network-condition simulation (next two steps), predicting remote players.

**Playable end state:** your ship reacts the **instant** you press a key; under
good conditions there is no rubber-band and the prediction-error meter sits at ~0.
Any residual correction may still snap — fixed in M2.5.

---

### M2.5 — Correction smoothing & network-condition hardening

**Goal:** remove the last visible snap and prove the model holds under real-world
latency, jitter, and loss. Turns "works on localhost" into "works on the
internet."

**Scope:**
- [x] In-transport **network simulator** (toggleable): added latency, jitter, and
      packet loss in both directions, controllable from the debug HUD — so bad
      conditions are reproducible on demand.
- [x] **Smooth** the residual reconciliation error: instead of snapping the local
      ship to the replayed pose, decay the position/rotation error to zero over a
      few frames (a shrinking render-offset), so a correction is felt as a gentle
      pull, never a jump.
- [x] Tune `interpDelay` and the snapshot buffer against the simulator; define
      graceful behavior on dropped snapshots (extrapolation window + clamp).
- [x] **Determinism audit:** an integration test that runs the same input stream
      through two independent `World`s and asserts bit-for-bit equality — guards the
      prediction contract the whole milestone rests on.
- [x] Document the failure modes and the constant behind each fix, so a cold
      session understands *why* each number exists.

**Out of scope:** projectile prediction (next), server-side lag
compensation / hit rewind (Phase-2 polish — catalog §10), adaptive interpolation.

**Playable end state:** with ~100ms latency + jitter + a few % loss simulated,
your ship still feels instant and **never visibly snaps**; remote ships stay
smooth; the error meter stays bounded and self-corrects. **Movement netcode is
done.**

---

### M2.6 — Projectile / weapon prediction & reconciliation

**Goal:** weapons fire **instantly** instead of waiting for a server round-trip.
This is the direct fix for the *"laggy weapons"* regression.

**Scope:**
- [x] On local fire, immediately spawn a **predicted projectile** in the predicted
      world (reusing `firingSystem`), tagged `predicted` with `owner = localId` and
      the input `seq` that produced it. Debit predicted energy/cooldown locally so
      the HUD and fire-rate feel right.
- [x] **Reconciliation / matching:** when a snapshot arrives, match each predicted
      projectile to its server-spawned twin (by owner + spawn seq/id) and **hand
      off** to the authoritative entity, removing the predicted stand-in with no
      visible pop. If the server never spawned it (rejected — e.g. it saw no
      energy), **retract** the prediction.
- [x] Predicted projectiles are **replayed** in the prediction step alongside the
      ship, so reconciliation never double-spawns them.
- [x] Only the **local** player's own shots are predicted; all other projectiles
      come from snapshots and are interpolated (M2.2). **Hits and damage stay 100%
      server-authoritative** — prediction is cosmetic-until-confirmed (no predicted
      kills).
- [x] Debug HUD: live predicted-vs-reconciled projectile counts; flag
      mispredictions.

**Out of scope:** predicting damage/deaths, predicting items (repel/burst/mines —
those predict, if ever, in M5), server-side lag-comp hit rewind.

**Playable end state:** your bullets and bombs appear the **instant** you fire — no
round-trip delay — and reconcile seamlessly to the server's authoritative shots
with no visible duplication or pop. **Both named M2 regressions (laggy weapons,
jittery ships) are now gone.**

---

### M2.7 — Identity, the server-side bot & join/leave polish → M2 complete

**Goal:** tidy the multiplayer build into something two people can actually sit
in, and move the M1 bot to where it belongs.

**Scope:**
- [x] Move the combat bot **server-side**: it's just another player feeding
      `InputCommand`s into the authoritative sim (it was always written
      transport-agnostic — `sim/bot.ts`). Restores it as AI filler, now over the
      net.
- [x] Player identity: name chosen client-side, sent in `hello`, shown on
      debug-quality nametags with bounty + ping.
- [x] Robust join/leave: clean add/remove, the snapshot reflects the live roster,
      no ghost ships; reconnect = a fresh join for now.
- [x] **Server owns spawn assignment** (`findSpawn` runs on the server); the client
      never picks position.
- [x] Sanity caps: max players, input-rate clamp, snapshot-size sanity — minimal
      abuse guards, not full anti-cheat.

**Out of scope:** chat, polished UI/nametags (M3), accounts/persistence (Phase 2),
AOI culling & stealth filtering (M5 fills the per-client seam built in M2.0),
matchmaking.

**Playable end state:** open two tabs (plus the server-side bot) → everyone joins
one authoritative server → fight with **instant weapons**, **prediction-smooth**
own-ship movement, and **smoothly interpolated** opponents, holding up under
simulated latency/jitter/loss. **The project's biggest bet is de-risked; M3 can
now build real UI on a proven transport.**

---

### M2.8 — Deterministic client-side simulation of remote projectiles

**Goal:** kill the two remaining "it's-being-inferred" artifacts on *other
players'* shots — bullets that **jump/teleport when they bounce off a wall**, and
enemy fire that visibly trails by the interpolation delay — by simulating remote
projectiles **locally and deterministically** instead of interpolating their
streamed positions. This is what the original Subspace did (every client ran every
bullet's physics locally from a fire event); it is **not** server-side hit rewind,
which is a different feature for hit *fairness* (Phase 2).

**Why this is the right fix (and rewind is not):** a projectile's entire future is
fixed at spawn — `stepProjectile` (`sim/systems/projectiles.ts`) advances it from
*only* position, velocity, bounce count, and the map; **no player input drives
it**. So any client with the spawn parameters can reproduce its path bit-for-bit,
bounces included (the sim is pure/deterministic — the same property M2.4/M2.6
already exploit for the local player and its own shots). Today remote bullets are
instead **lerped** between snapshot positions (`net/interpolation.ts`, the
`view.projectiles` block), so a bounce that happens between two snapshots is drawn
as a straight line through the corner until the post-bounce snapshot arrives —
the "jump." Your **own** shots are already locally simulated (M2.6); this extends
that to everyone's.

**Unlocks:** Subspace-grade weapon feel under latency; the local-projectile-sim
seam that M5 items (repel/burst/mines altering trajectories) will reconcile
against.

**Scope:**
- [x] `net/remoteProjectiles.ts`: a `RemoteProjectileSimulator` holding a tiny
      never-networked `World` (map only). Each frame: clone the latest
      authoritative remote projectiles and step `projectileSystem` forward by the
      elapsed ticks to the chosen render time (mirrors the predictor's
      rebuild-and-replay; input-free so no ring buffer needed).
- [x] Route remote projectiles through it: `interpolation.ts` now **skips all
      projectiles** (the projectile block is empty), and `main.ts` pushes
      `remoteProjectiles.simulate(...)` into `view.projectiles` alongside the
      predictor's own shots. The simulator reads the interpolator's own snapshot
      buffer (`interp.snapshots`) via a shared `pickStraddlingPair`, so ships and
      bullets resolve against the exact same render window.
- [x] **Render-time decision (resolve first, it sets the scope):** render remote
      bullets at the **same render time as remote ships** (`now − interpDelayMs`),
      *not* present. This fixes the bounce-jump without detaching bullets from the
      ships that fired them. Rendering them at true present requires also
      extrapolating remote *ships* to present, which reintroduces the
      turn→overshoot→snap the roadmap rejected in M2.2 — explicitly out of scope
      here. (Documented in `remoteProjectiles.ts`; it's the crux.)
- [x] **Death-during-window reconciliation:** a bullet the server killed (wall/
      ship/age) between snapshots must retract, not keep flying — cross-check each
      simulated id against the straddling newer snapshot and drop the ones gone.
- [x] Hits/damage stay **100% server-authoritative** — the local sim is
      cosmetic-until-confirmed, exactly like predicted own-shots (M2.6). No
      predicted enemy kills (the simulator runs only `projectileSystem`; it has no
      players, so no collision/damage path exists).
- [x] Determinism test (`net/remoteProjectiles.test.ts`, mirroring
      `net/determinism.test.ts`): a remote bullet simulated locally through a wall
      bounce matches the server's `projectileSystem` path bit-for-bit; a
      server-killed bullet retracts via the newer-snapshot cross-check.

**Out of scope:** server-side lag compensation / hit rewind (**M2.9** — fixes hit
*fairness*, not visuals); extrapolating remote *ships* to present; predicting
item effects on trajectories (M5 reconciles those against this seam).

**Playable end state:** enemy bullets bounce cleanly off walls in real time with
no teleport, and weapon fire reads as instant/contiguous like the original — while
remote ships stay smoothly interpolated and all damage stays authoritative. **The
last "inferred-looking" weapon artifact is gone.**

**Refs:** architecture §5.2; this milestone is the projectile counterpart to the
ship prediction in M2.4 and own-weapon prediction in M2.6.

---

### M2.9 — Server-side lag compensation ("what you see is what you hit")

**Goal:** make a shot that *visually connects* on the firer's screen actually
register, by having the server adjudicate each hit against where the targets were
**in the firer's view at the moment they fired** — not against the server's
present. This is the third and final leg of the standard netcode model:

```
  client prediction  (own ship / shots at present)   ✓ M2.4 / M2.6
  entity interpolation (remotes smoothed in the past) ✓ M2.2 / M2.8
  lag compensation    (server rewinds targets to the firer's view)  ← this
```

**The artifact it fixes ("eaten bombs"):** remote ships are rendered at
`now − interpDelayMs` (~75ms) plus up to a 20Hz broadcast gap, so the firer is
always aiming at a *stale ghost* of a moving ship — yet collision
([systems/collision.ts]) tests the present, true position. The bomb sails through
where the enemy *was drawn* but no longer *is*, and the server correctly scores a
miss. This happens **even at 0 network latency** (it's the interp delay, not the
wire) and gets worse with real latency — at a 40ms sim it eats ~half of all
bombs. It is the single biggest felt problem and the reason the M2.9-cosmetic
draft (below, cancelled) would have made things *worse*: faking the impact effect
off the rendered overlap would draw a "hit" that reliably does no damage.

**The principle — favour the shooter:** rewinding targets to the firer's view
means a target who has *already dodged on their own screen* can still be hit
("I got shot behind cover"). That asymmetry is the accepted, universal lag-comp
trade: it is far better than the alternative (aim dead-on and miss). We bound the
rewind so the unfairness stays small.

**Why this fits *our* architecture unusually well:**
- Layer A is **plain, cloneable data**, so a short ring of past world poses is
  cheap to keep and read — lag comp here is *"test against a past sample"*, not the
  classic mutate-rewind-test-restore dance.
- The sim is **deterministic and input-driven**. To keep it so, the compensation
  amount must be *input-derived*, not read from a wall clock: the firer's input
  carries the render-time it was looking at, and the server derives the rewind
  from that. Two worlds fed the same inputs still step identically — the
  `determinism.test.ts` contract holds.

**Projectiles, not hitscan — the subtlety to get right:** Subspace weapons
*travel*; the hit happens many ticks after the shot, by which point the target has
moved again. So compensation can't be a one-shot test at fire time. Instead the
**projectile carries the firer's compensation** (`compTicks`) for its whole life,
and every flight-tick collision test for that projectile is evaluated against each
candidate target's **historical** pose `compTicks` ago. The projectile still flies
in the present (so it looks right to the firer who predicted it); only the
*overlap test* reaches into the past.

**Scope:**
- [ ] **World pose history (server runtime).** Add a `world.history` ring — a
      runtime-only field like `events`/`contacts`, **not** serialized into
      snapshots — holding the last ~120 ticks (~1.2s) of each player's
      `{x, y, radius, alive}`. Populate it each `step()`. Sized to cover
      `interpDelay + max RTT/2 + jitter` with margin. (The client never accrues it:
      its view world isn't stepped and its predicted world has no remote targets.)
- [ ] **Carry the firer's render-time in the input (keeps determinism).** Extend
      `InputCommand`/`SequencedInput` (M2.3) with the **server tick the client's
      render view corresponded to** when it sampled that input — the client knows
      this exactly: the straddling snapshot ticks and blend `t` it interpolated
      through (`pickStraddlingPair`). Because the rewind amount now rides in the
      input, the server stays a pure function of its inputs.
- [ ] **Stamp `compTicks` onto spawned projectiles.** In `firingSystem`, when an
      input spawns a shot, set `projectile.compTicks = spawnTick − input.renderTick`
      (clamped ≥ 0 and to the history length). Pure data on the projectile; absent /
      0 means "no compensation" (e.g. the bot, or a client that didn't report).
- [ ] **Lag-compensated overlap in `collisionSystem`.** When testing a projectile
      with `compTicks > 0` against a target, compare against that target's pose at
      `world.tick − compTicks` looked up from `world.history` (fall back to present
      if out of range). Everything else — bullet→`Contact`, bomb dies-on-contact —
      is unchanged. Deterministic given the same history + projectiles.
- [ ] **Decide the bomb *splash* timeline.** The direct-hit detection is
      lag-compensated (that's the eaten-bomb fix); keep the area blast
      (`detonateBomb`) evaluated against **present** positions for a first cut
      (area effect is forgiving), and document the choice. Revisit only if splash
      feels off.
- [ ] **Bound the compensation.** Cap `compTicks` at a config max (~150–250ms) so a
      very laggy or spoofed client can't rewind targets arbitrarily far. The cap is
      the dial on the favour-the-shooter trade.
- [ ] **Tests.** A unit/determinism test in the sim spirit: a target strafing
      laterally, a bomb fired at its *rendered* (delayed) position — **hit** with
      compensation on, **miss** with it off; two worlds driven by the same inputs
      (now including `renderTick`) stay byte-identical (extend
      `determinism.test.ts`). A server test that `world.history` lookups are bounded
      and never read un-stepped ticks.
- [ ] **Debug HUD / overlay.** Surface per-shot `compTicks` (or the firer's
      effective rewind ms) so the compensation is observable, and an indicator when
      a hit was awarded via rewind vs present.

**Out of scope:** **client-authoritative weapons** (the original Subspace model —
hit detection on the victim's machine; lower latency on offence but cheatable and
inconsistent — a deliberately *different* design we are not adopting); lag-comping
**ship↔ship** or movement (only projectile hit detection here); any **rollback of
consequences** (we still never un-kill or refund — the server simply decides the
hit once, correctly); reducing `interpDelayMs` or extrapolating remote ships to
present (rejected in M2.2). The cancelled cosmetic-effects draft's one keeper —
instant own-bomb **wall/age** explosions — can return later as a small client-only
polish item once hits feel right; it is explicitly *not* part of this milestone.

**Playable end state:** at 40–150ms (sim or real), a bomb or bullet aimed at where
an enemy *appears on your screen* lands as a hit, because the server adjudicates it
against that same view. Bombs stop being "eaten." The favour-the-shooter trade is
present but bounded. Offence finally feels as responsive as the prediction work
made your own ship feel — and unlike the original, it's server-authoritative and
hard to cheat.

**Refs:** architecture §5 (server authority) / §5.2; the Valve/Source "lag
compensation" model (the third leg alongside the prediction of M2.4/M2.6 and the
interpolation of M2.2/M2.8). **Supersedes** the earlier M2.9 cosmetic-effects
draft (cancelled — it papered over this problem instead of solving it).

---

## M3 — Client surfaces / UI foundation

**Goal:** build the bitmap-font UI toolkit and the lobby's core surfaces so it
**looks and reads like Subspace** (per your screenshots).

**Unlocks:** chat, statbox, minimap, nametags, menus — and the toolkit every
later UI rides on.

**Scope:**
- [ ] One-time tool: slice the original font PNGs (`hugefont`/`largefont`/
      `shrtfont`/`tallfont`/`specfont`/`energy_font`/`led_font`) into a glyph
      atlas for Pixi `BitmapText`.
- [ ] `ui/widgets/`: `Label`, `Panel`, `ScrollList`, `InputLine` (bitmap-font).
- [ ] Hidden DOM `<input>` for chat typing; render visible text in Pixi.
- [ ] `ui/models/`: `ChatModel`, `StatboxModel`, `HudModel` (data, derived from sim).
- [ ] **Chat** (public + team), color by type via tint.
- [ ] **Statbox** (name, bounty, points; W/L/R stub).
- [ ] **Minimap/radar** (`MapZoomFactor`, player dots, viewport box).
- [ ] HUD on real fonts: energy bar/number, nametags + bounty.

**Out of scope:** full menu/hotkeys, squads, ticker, kill-feed polish (→ M6).

**Playable end state:** the multiplayer build now has authentic chat, a player
list, a working minimap, and pixel-perfect original-font text.

**Refs:** catalog §8, §9; architecture §6.

---

## M4 — All 8 ships

**Goal:** every ship flyable with correct per-ship physics, weapons, and visuals,
at **Maximum** tier (lobby default).

**Unlocks:** ship variety; the data-driven payoff of M0's config tables.

**Scope:**
- [ ] Author `SHIPS[0..7]` from the `.ini` (Warbird…Shark), Initial+Maximum.
- [ ] Wire ship sheets `ship0..7` (+ `_red`/`_junk` variants).
- [ ] Per-ship/per-level **bullet & bomb colors** (sheet rows).
- [ ] Ship-select (menu or `=`), spawn at chosen ship.
- [ ] Per-ship weapon params (multifire angle, bomb thrust, burst speed, etc.).

**Out of scope:** items/toggles (M5), turret/attach (defer to M5/M6).

**Playable end state:** pick any of the 8 ships; each flies and fires per its EG
config with the right colors.

**Refs:** catalog §1, §2; architecture §2.5.

---

## M5 — Special items & status effects

**Goal:** the full combat toolkit. Build the **status system** and **items
system** once; the individual items/toggles are then thin.

**Unlocks:** repel/burst (named in Phase 1 scope), mines, the stealth/cloak/etc
toggles, super/shields.

**Scope (in dependency order):**
- [ ] `systems/status.ts`: toggle energy-drain + force-off + timed-expiry
      (per [arch §2.4](architecture.md)).
- [ ] `systems/items.ts`: the use-item dispatch.
- [ ] **Repel** (radial impulse on projectiles+ships; `RepelDistance/Speed/Time`).
- [ ] **Burst** (radial bullets).
- [ ] **Mines** (stationary armed bomb; reuse bomb damage path; `TeamMaxMines`).
- [ ] **Shrapnel** on bomb death.
- [ ] Toggles: **cloak, stealth, xradar, antiwarp, multifire** — and wire
      stealth/cloak into `serializeSnapshotFor` (the M2 per-client seam).
- [ ] Timed: **super, shields**; **rocket**, **decoy**, **portal**, **brick**.

**Out of scope:** prizes/greens (lobby is max-ship-no-greens; greens are a later
mode), flags/ball (Phase 2).

**Playable end state:** the lobby has the full EG combat toolkit; stealth/cloak
actually hide you server-side.

**Refs:** catalog §2, §3; architecture §2.4, §5.1.

---

## M6 — Lobby polish → Phase 1 complete

**Goal:** turn "it works" into "people want to hang out here." The persistent
EG-style lobby ships.

**Scope:**
- [ ] Full **statbox**: W/L/R, squads, freq coloring, sorting (your menu screenshot).
- [ ] **Menu**: F1 help, hotkeys overlay, ship select, settings, set banner.
- [ ] **Kill feed / notifications**, **ticker** (`TickerDelay`), streaks.
- [ ] **Frequencies/teams** assignment + limits (`[Team]`), basic `?`commands.
- [ ] **Sound manager** — wire all original `.wav`s to events.
- [ ] Animation polish: warp-in, cloak/stealth shimmer, thrust, super.
- [ ] **Attach/turret** (ride a captain) — EG lobby staple.
- [ ] Arena mode flag: **Maximum loadout, greens off** (lock in the lobby ruleset).
- [ ] Remappable controls (addresses the `Ctrl` limitation in the README).

**Playable end state:** a joinable, persistent, good-looking EG-style lobby with
8 ships, full combat toolkit, chat, radar, sound, and stats. **Phase 1 done.**

**Refs:** catalog §6 (teams), §7, §8, §9.

---

## Phase 2 — Competitive (only if Phase 1 shows promise)

Sketched, not detailed — these get their own planning pass when Phase 1 is proven.

- **Flags / base duel:** flag entities, carry/claim/turf, flagger modifiers,
  flag-duel scoring, base maps. (catalog §6)
- **Powerball / soccer:** ball carry/pass/goal, soccer modes. (catalog §6)
- **World objects:** bricks, doors, wormholes (gravity + teleport). (catalog §6)
- **Greens mode:** the full prize system as an alternate arena ruleset. (catalog §4)
- **Matchmaking:** TagPro-style queue → short 5-min matches.
- **Accounts, persistence, leaderboards.**

---

## A note on milestone size

M0–M1 are each likely a few focused sessions; **M2 is now explicitly split into
eight sub-steps (M2.0–M2.7), one buildable slice per session**, because netcode is
where collapsing concerns bites hardest. M3–M6 are larger and will split into
sub-sessions naturally (e.g. M5 is "status system" then one session per item
cluster). When you start a milestone, the first session's job is often to scaffold
the system(s) and one vertical slice; later sessions fill in the riders. Keep each
session ending on a runnable build.
