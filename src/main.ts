import { TICK_HZ, WARBIRD } from "./config";
import { Keyboard } from "./input/keyboard";
import { keyboardLockSupported, toggleFullscreen } from "./input/fullscreen";
import { loadMap } from "./map/loader";
import { computeBotInput } from "./sim/bot";
import { FixedLoop } from "./sim/loop";
import { isAlive } from "./sim/player";
import { World } from "./sim/world";
import { Renderer } from "./render/renderer";

/** The M1 combat bot's player id — a second player driven by AI, not a keyboard. */
const BOT_ID = "bot";

async function main() {
  const mount = document.getElementById("app")!;
  const hud = document.getElementById("hud")!;
  const killfeed = document.getElementById("killfeed")!;

  // 1. Load the map, 2. build the (pure) world, 3. set up the fixed-step loop.
  const map = await loadMap();
  const world = new World(map);
  world.localPlayer.name = "fecundity"; // (client identity; the network sets this in M2)
  world.addPlayer(BOT_ID, "Roaming Bot", 1, WARBIRD); // the thing to fight (M1)
  const loop = new FixedLoop(world);

  // 4. Input + renderer.
  const keyboard = new Keyboard();

  // Press F to toggle fullscreen (which also enables keyboard lock on Chromium,
  // letting us try to capture Ctrl+arrows from macOS Mission Control).
  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyF") toggleFullscreen(mount).catch(console.error);
  });
  if (!keyboardLockSupported()) {
    console.info(
      "Keyboard Lock API not available in this browser (Chromium-only); " +
        "Ctrl+arrows may still trigger OS shortcuts. Use Space to fire.",
    );
  }

  const renderer = new Renderer();
  await renderer.init(mount, map);

  // A throwaway kill feed: the real bitmap-font version arrives with the UI
  // toolkit in M3. For now we render recent kill lines into a DOM overlay.
  const feed = new KillFeed(killfeed);

  // 5. The render/animation loop. Sample input, advance the sim in fixed steps,
  //    then draw with interpolation. requestAnimationFrame runs at the display's
  //    refresh rate; the sim still ticks at exactly TICK_HZ.
  let last = performance.now();
  let fpsAccum = 0;
  let fpsFrames = 0;
  let fps = 0;

  function frame(now: number) {
    const dt = (now - last) / 1000;
    last = now;

    // Sample this frame's intent for both players: the human from the keyboard,
    // the bot from its AI. The sim is multiplayer-shaped — it steps from a map
    // of per-player inputs and doesn't care which came from a keyboard.
    const input = keyboard.sample();
    const botInput = computeBotInput(world, BOT_ID);
    const ctx = {
      inputs: new Map([
        [world.localPlayerId, input],
        [BOT_ID, botInput],
      ]),
    };
    const alpha = loop.advance(dt, ctx);
    renderer.draw(world, alpha, dt);

    // Drain this frame's sim events for the kill feed, then clear them. The
    // renderer already consumed the same events for explosions; main owns the
    // clear so every consumer sees them (architecture §4).
    for (const e of world.events) {
      if (e.type === "shipDied") feed.add(killLine(world, e.killer, e.victim), now);
    }
    world.events.length = 0;
    feed.render(now);

    // HUD (updated a few times a second).
    fpsAccum += dt;
    fpsFrames++;
    if (fpsAccum >= 0.25) {
      fps = Math.round(fpsFrames / fpsAccum);
      fpsAccum = 0;
      fpsFrames = 0;
    }
    const me = world.localPlayer;
    const k = me.kinematics;
    const speed = Math.hypot(k.vx, k.vy);
    const status = isAlive(me)
      ? `energy ${me.resources.energy.toFixed(0)}`
      : `RESPAWNING in ${((me.combat.respawnAt - world.tick) / TICK_HZ).toFixed(1)}s`;
    hud.textContent =
      `fps ${fps}  (sim ${TICK_HZ}Hz)\n` +
      `pos ${k.x.toFixed(0)}, ${k.y.toFixed(0)}\n` +
      `speed ${speed.toFixed(2)} px/tick\n` +
      `${status}\n` +
      `bounty ${me.combat.bounty}  score ${me.combat.score}  ` +
      `${me.combat.kills}-${me.combat.deaths} (K-D)\n` +
      `projectiles ${world.projectiles.length}`;

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/** Build a kill-feed line from a death event, looking names up on the world. */
function killLine(world: World, killer: string | null, victim: string): string {
  const name = (id: string) => world.players.get(id)?.name ?? id;
  if (killer && killer !== victim) return `${name(killer)} killed ${name(victim)}`;
  return `${name(victim)} was destroyed`;
}

/** A tiny self-expiring kill feed rendered into a DOM element. Throwaway until
 *  M3's bitmap-font UI replaces it. */
class KillFeed {
  private static readonly TTL_MS = 5000;
  private static readonly MAX_LINES = 5;
  private lines: { text: string; bornMs: number }[] = [];

  constructor(private readonly el: HTMLElement) {}

  add(text: string, nowMs: number): void {
    this.lines.push({ text, bornMs: nowMs });
    if (this.lines.length > KillFeed.MAX_LINES) this.lines.shift();
  }

  render(nowMs: number): void {
    this.lines = this.lines.filter((l) => nowMs - l.bornMs < KillFeed.TTL_MS);
    this.el.textContent = this.lines.map((l) => l.text).join("\n");
  }
}

main().catch((err) => {
  console.error(err);
  document.getElementById("hud")!.textContent = `Error: ${err.message}`;
});
