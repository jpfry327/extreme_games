# Session prompt: netcode responsiveness fixes (M2.17)

*Copy everything below the line into a fresh Claude Code session on this repo
(or just tell the session: "Read docs/netcode-fix-session-prompt.md and
execute it"). It is self-contained: findings, file/line evidence, fix designs,
acceptance criteria, and verification steps all included. Phase D (transport)
is deliberately a separate follow-up session and gated on a hosting move.*

---

You are working on `extreme_games`, a browser rebuild of the Subspace/Extreme
Games lobby: TypeScript, Pixi client, authoritative Node headless server
(`server/index.ts`), 100Hz fixed-tick shared sim. **Before writing any code,
read `CLAUDE.md` and `docs/architecture.md` in full** — they are the contract.
The non-negotiables you must not break:

- `src/sim/` stays pure and deterministic (no DOM/Pixi/`Math.random()`); the
  identical sim runs on client and server and the prediction/replay system
  (`pred err ≈ 0` on the debug overlay) depends on bit-identical behavior.
- Every tunable goes in `src/config.ts` with a comment explaining units and
  the reasoning, matching the existing comment style.
- The in-process loopback path (`src/net/server.ts` + `LoopbackTransport`,
  the commented-out block in `main.ts`) must keep working.
- Tests: `npm test` (vitest) and `npm run build` (typecheck) must be green
  after every phase. Netcode behavior changes get unit tests alongside the
  existing ones in `src/net/*.test.ts`.
- Update `docs/roadmap.md` (add an M2.17 section recording what you did, in
  the established format) and the "Current milestone status" section of
  `CLAUDE.md` when you finish.

Work in the phase order below — it is sorted by (value ÷ risk), and each
phase ends runnable and individually committable. **Commit after each phase**
with a message explaining the why, matching the repo's commit style. If a
phase's verification fails and you can't resolve it, commit the completed
phases and report rather than pushing a broken build.

Background for all phases: live testing on the deployed build (~70ms RTT,
WSS/TCP on Railway) says the game is much better post-M2.16 but still reads
as laggy versus original Subspace. Analysis found the causes are (a) a
client-side frame-pacing bug, (b) two tuning items left over from the 33→50Hz
broadcast change, and (c) remote ships being interpolated in the past when
this game's physics supports drawing them at the present. Server CPU/JS is
measured and not a factor (69µs/tick fully loaded with 16 players).

---

## Phase A — Fix whole-scene judder: pass the real sub-tick alpha (bug fix)

**Problem.** `src/main.ts` (search for `renderer.draw(view, 1, dt`) hard-codes
render alpha to 1, but the predicted local ship only advances in whole 10ms
sim ticks (`Predictor.predict` replays whole inputs; `ClientInputManager
.produce` emits one command per elapsed tick from a fixed-timestep
accumulator). At 60fps each frame covers alternately 1 or 2 ticks, so local
motion advances +10ms, +20ms, +10ms… on a uniform ~16.7ms frame cadence.
Because the **camera follows the local ship** (`render/renderer.ts`, the
`camX/camY` lerp of `local.prevX→x`), the entire scene judders whenever the
player moves — including remote entities that are otherwise perfectly
smoothed. Classic fixed-timestep temporal aliasing; the pre-netcode prototype
passed the real accumulator alpha and the prediction rewrite lost it.

**Why the fix is safe.** Everything is already shaped for it:
- `movementSystem` records true `prevX/prevY/prevRotation` at the start of
  each step, so the predicted player's `prev*` genuinely is the previous
  tick's pose and `lerp(prev, current, alpha)` is exact continuous motion.
- All *baked* view entities (interpolated remotes, remote projectiles) set
  `prev* === current`, so a non-1 alpha is a no-op for them by construction.
- `ReconciliationSmoother.apply` shifts `prev*` by the same offset as
  current (its comment says "regardless of alpha" — it anticipated this).

**Implement.**
1. Expose the sub-tick fraction on `ClientInputManager`
   (`src/net/clientInput.ts`): `get alpha(): number { return
   this.accumulator / TICK_DT; }` (always in [0,1) after `produce`).
2. In `main.ts`, call `renderer.draw(view, inputMgr.alpha, dt, latestPings)`.
3. Check the predicted own-projectiles path: predicted shots come from the
   same stepped world so their `prev*` are also real — they should now
   render sub-tick smooth for free. Verify nothing else consumes alpha with
   baked-pose assumptions (grep `alpha` in `render/`).

**Verify.** `npm test`, `npm run build`. Then run it (`npm run server` +
`npm run dev`), hold thrust and strafe past walls: motion should be visibly
uniform at 60fps. For something falsifiable, temporarily log the per-frame
camera delta while thrusting at steady speed — before the fix it alternates
~±33% frame-to-frame; after, it should be near-constant. Remove the logging
before committing. Note the trade in a comment: the own ship now renders up
to 10ms in the past (standard fixed-timestep interpolation — the same model
M0 used).

---

## Phase B — Retune the adaptive-interp floor for the 50Hz broadcast rate

**Problem.** `NET.adaptiveInterp.minMs = 50` in `src/config.ts` was sized as
"~2 broadcast gaps at 33Hz", but M2.16 raised broadcasts to 50Hz
(`BROADCAST_EVERY = 2` in `server/index.ts`, 20ms spacing). The adaptive
target's spacing term now asks for only `20 × 1.5 = 30ms`, so on a clean
link the stale 50ms floor is the binding constraint — donating ~20ms of
unnecessary remote-view delay.

**Implement.** Lower `minMs` to 30 and update its comment to derive from
spacing (`≥ 1.5 × the 20ms broadcast gap`) rather than a hard-coded rate, so
the next rate change doesn't strand it again. Alternatively (better if cheap):
make the effective floor spacing-relative inside `AdaptiveInterpDelay.update`
— `max(cfg.minMs, meanIntervalMs * cfg.spacingFactor)` — with `minMs: 30` as
the absolute safety floor; then the config is self-correcting. Keep
`maxMs: 120` untouched.

**Verify.** Unit-test the new floor behavior in
`src/net/adaptiveInterp.test.ts` (clean link at 20ms spacing settles near
30–35ms; jittery lateness still raises it; 30ms absolute floor holds).
Live-check with the netsim panel: at zero simulated impairment, the overlay's
`interp` line should settle ~30–35ms with `extrap 0/s freeze 0/s`; at
80±30ms/3% it should climb like before.

---

## Phase C — Closed-loop input pacing (kill the standing input queue)

**Problem.** The server consumes exactly one input per tick;
`src/net/serverInput.ts` caps the standing queue at `MAX_BUFFERED = 6` and
drops oldest beyond it (lossy stopgap — its own comment names client-side
pacing as "the principled fix, a later milestone"; this is that milestone).
Client/server clock-rate drift or clumped delivery parks a standing 2–6 tick
backlog that adds 20–60ms to *every* subsequent input, or starves the queue
so the server pads with repeat-last (mispredictions). The feedback signal
already exists end-to-end: the server stamps `inputBufferDepth` into every
snapshot and `main.ts` stores it as `serverInputDepth`.

**Implement.** A slow feedback loop on the client's input-production clock:
- In `ClientInputManager`, scale the accumulator advance:
  `accumulator += min(dt, MAX_FRAME) * paceScale`, with `paceScale` bounded
  to ±2% (mirror the tick clock's slew bound reasoning — imperceptible, and
  ~±2 ticks/second of authority is plenty to track drift).
- Drive it from an EWMA of the reported depth (the raw value oscillates
  tick-to-tick; smooth over ~1s). Target depth ~1.5–2 ticks: below target →
  speed up, above → slow down. Feed it from the snapshot handler in
  `main.ts`. All constants in a new `INPUT.pacing` block in `config.ts`
  with the reasoning documented.
- Do **not** change the 1:1 seq-per-tick production model — pacing only
  changes how wall time maps to tick production, which the sequence-based
  replay (M2.4) and the server's seq-ordered consumption are indifferent to.
  Keep `MAX_BUFFERED` as the safety net.

**Verify.** Unit test the controller (`src/net/clientInput.test.ts` or a new
file): synthetic depth series converge to target; scale never exceeds bounds;
depth 0 with repeats → speeds up. Determinism/prediction suites stay green.
Add the live pace to the debug overlay (e.g. `pace +1.3%` on the upstream
line). Live: overlay `in-buf` should sit ~1–2 and, at netsim 80±30ms, `ack`
should sit close to `ping` + one broadcast interval.

---

## Phase D — Extrapolate remote ships to the estimated server present (flagged)

**The big feel change — do it last, behind a config flag.** Remote ships are
currently interpolated 30–120ms in the past plus ~RTT/2 of wire age
(`src/net/interpolation.ts`). But Subspace physics is near-ballistic:
frictionless, thrust-limited (Warbird 0.03 px/tick², afterburner 0.06), no
teleports. Extrapolating a remote ship at constant velocity over a 100ms
lead mispredicts by at most ½·a·t² ≈ **1.5–3px** against a 14px ship radius
(6–12px at a 250ms stall cap). That error is invisible next to the
100–170ms of staleness it removes — this is exactly how original Subspace
drew remotes, and it's the main remaining feel gap. M2.16 already did this
for remote *projectiles* (`src/net/remoteProjectiles.ts` — study it first;
same pattern: lead window from `serverNowMs`, `maxLeadMs` cap, freeze at cap).

**Implement.**
1. Config: `NET.remoteShips = { mode: "extrapolate" as "extrapolate" |
   "interpolate", maxLeadMs: 250, correctionHalfLifeMs: … }` — document that
   `"interpolate"` reverts to the M2.2 path wholesale.
2. In the interpolator (or a sibling module it delegates to), when mode is
   `extrapolate`: base each remote player on the **newest** snapshot, advance
   `leadTicks = clamp(serverNowMs − snap.tick×TICK_MS, 0, maxLeadMs) / TICK_MS`
   at constant velocity with sub-tick fraction (like remoteProjectiles'
   `frac`), rotation pinned to the newest snapshot value. Handle walls with
   the same collision/bounce treatment ships get in `movementSystem`
   (extract a shared pure helper rather than duplicating — it lives in
   `sim/` so both can use it). Freeze at the lead cap during stalls, exactly
   like projectiles.
3. **Correction smoothing:** on each new snapshot a remote's extrapolated
   pose jumps by the misprediction. Keep a per-remote-player decaying render
   offset (the `ReconciliationSmoother` pattern — generalize it or add a
   small per-player map): absorb the pose delta at snapshot arrival, decay
   with `correctionHalfLifeMs`, snap past `NET.maxSmoothDistancePx` (respawn
   /teleport rule, same as the local ship). Reuse the existing dead/respawn
   pin logic from `interpolatePlayer` so respawns pop cleanly.
4. **Lag-comp stamp:** with remotes drawn at present, the view tick you're
   aiming through is ~the estimated server present, so
   `SnapshotInterpolator.renderTick` must return
   `round(serverNowMs / TICK_MS)` in extrapolate mode (keep the monotonic
   floor). `compTicksFor` (`sim/systems/firing.ts`) already clamps
   `world.tick − renderTick` to ≥0, so a slightly-ahead estimate is safe.
   Net effect: rewind shrinks from interp+RTT to ~RTT — the overlay's
   `lagcomp` line should drop to roughly the RTT and `clamp 0/s` should
   become trivially true. The "dodged but died" window shrinks with it.
5. **Events:** ship-anchored events (`shipHit`/`shipDied`/`playerSpawned`)
   are currently released when the *past* render time passes their tick
   (`buildView`). In extrapolate mode release them promptly like
   `bombExploded` already is — the ships they anchor to are no longer drawn
   in the past. Keep the once-only tick watermarks.
6. Check the cosmetic-hit detectors still line up: `predictedHits` compares
   predicted shots (present) against enemies as drawn (now also present) —
   this gets *more* consistent; `incomingHits` unchanged. Nametags/HUD read
   the view world and need nothing.

**Verify.** Unit tests: extrapolation math (lead, cap, freeze), correction
absorb/decay/snap, renderTick-at-present monotonicity, prompt event release
— and that `mode: "interpolate"` reproduces the existing interpolation test
expectations (the flag is the regression guard). Full suites + build green.
Live A/B with netsim: at 80±30ms the remote bot should track visibly closer
to "where it really is" (shots you dodge on-screen should now correspond to
server misses), with only small eased corrections when it turns; with stall
300/2000 remotes freeze at the cap and recover without warping. Flip the
flag both ways and confirm both paths run. Document the trade-offs in the
config comment (micro-corrections on input changes; stall behavior) and add
an M2.17 roadmap entry explaining interpolate mode is retained as fallback.

---

## Explicitly out of scope for this session

- **UDP-class transport (WebTransport / WebRTC DataChannel).** Requires UDP
  ingress the current host (Railway) doesn't offer; it's a hosting decision
  first and a full session of its own once the host moves. The codebase is
  already shaped for it (acked-baseline deltas = the Quake 3 model, input
  redundancy, `Transport` interface) — do not pre-build any of it now.
- Victim-authoritative hits, multi-socket snapshot striping, binary input
  frames, prediction/GC micro-optimizations — all noted in the analysis,
  none belong in this session.

## Definition of done

All four phases committed separately, `npm test` + `npm run build` green,
netsim-verified as described, overlay showing the new signals (`pace`,
lower `interp`, `lagcomp ≈ RTT` in extrapolate mode), roadmap M2.17 +
`CLAUDE.md` status updated. If context runs short, phases A–C alone are a
complete, shippable improvement — land them and leave Phase D for a
follow-up rather than landing it half-verified.
