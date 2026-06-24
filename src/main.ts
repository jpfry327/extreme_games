import { TICK_HZ } from "./config";
import { Keyboard } from "./input/keyboard";
import { keyboardLockSupported, toggleFullscreen } from "./input/fullscreen";
import { loadMap } from "./map/loader";
import { isAlive } from "./sim/player";
import { World } from "./sim/world";
import { Renderer } from "./render/renderer";
import { WebSocketTransport } from "./net/WebSocketTransport";
import { applySnapshot } from "./net/snapshot";

// To run without a server (in-process loopback, M2.0 mode), swap the import
// above for these three and uncomment the loopback block below:
//   import { GameServer, BOT_PLAYER_ID } from "./net/server";
//   import { LoopbackTransport } from "./net/transport";
//   import { computeBotInput } from "./sim/bot";

async function main() {
  const mount = document.getElementById("app")!;
  const hud = document.getElementById("hud")!;
  const killfeed = document.getElementById("killfeed")!;

  // 1. Load the map.
  const map = await loadMap();

  // 2. Create the client world — snapshot-driven, never stepped by the client.
  const clientWorld = new World(map, 1, false);

  // 3. Input + renderer — initialize NOW so the canvas is on screen while we
  //    connect. The game loop starts immediately in "connecting…" mode.
  const keyboard = new Keyboard();

  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyF") toggleFullscreen(mount).catch(console.error);
  });
  if (!keyboardLockSupported()) {
    console.info(
      "Keyboard Lock API not available (Chromium-only); " +
        "Ctrl+arrows may trigger OS shortcuts. Use Space to fire.",
    );
  }

  const renderer = new Renderer();
  await renderer.init(mount, map);
  const feed = new KillFeed(killfeed);

  // 4. Connect to the authoritative server over WebSocket.
  //    The Vite dev proxy routes /ws → ws://localhost:3000 (see vite.config.ts).
  //    Run `npm run server` in a separate terminal before opening the browser.
  //
  //    To swap back to in-process loopback (no server needed), replace these
  //    four lines with the loopback block commented out below.
  const transport = new WebSocketTransport(
    `ws://${location.host}/ws`,
    "fecundity",
  );

  // --- loopback alternative (no server needed) ---
  // const server = new GameServer(map);
  // server.authoritativeWorld.localPlayer.name = "fecundity";
  // const transport = new LoopbackTransport(server, server.localPlayerId);
  // ------------------------------------------------

  transport.setSnapshotHandler((snap) => applySnapshot(clientWorld, snap));

  // `connected` flips true once the server sends `welcome` and we know our
  // PlayerId. The render loop runs in "connecting…" mode until then.
  let connected = false;
  transport.onConnected = (playerId) => {
    clientWorld.localPlayerId = playerId;
    connected = true;
    console.info(`[client] connected as ${playerId}`);
  };
  transport.start();

  // 5. Render loop. Starts immediately — even before the server replies — so
  //    the canvas is live and the "connecting…" HUD is visible right away.
  let last = performance.now();
  let fpsAccum = 0;
  let fpsFrames = 0;
  let fps = 0;

  function frame(now: number) {
    const dt = (now - last) / 1000;
    last = now;

    if (!connected) {
      hud.textContent = "connecting…";
      requestAnimationFrame(frame);
      return;
    }

    transport.sendInput(keyboard.sample());

    // --- loopback only: advance the in-process server + feed the bot ---
    // const alpha = server.advance(dt);
    // transport.sendInputAs(BOT_PLAYER_ID, computeBotInput(clientWorld, BOT_PLAYER_ID));
    // --------------------------------------------------------------------

    // Draw from the client world. Every pixel has passed through the
    // serialize → deserialize round-trip (snapshot from the server).
    // Own ship visibly lags RTT in M2.1; M2.4 adds prediction to fix that.
    renderer.draw(clientWorld, 1, dt);

    // Drain events piggybacked on the snapshot.
    for (const e of clientWorld.events) {
      if (e.type === "shipDied")
        feed.add(killLine(clientWorld, e.killer, e.victim), now);
    }
    clientWorld.events.length = 0;
    feed.render(now);

    // HUD.
    fpsAccum += dt;
    fpsFrames++;
    if (fpsAccum >= 0.25) {
      fps = Math.round(fpsFrames / fpsAccum);
      fpsAccum = 0;
      fpsFrames = 0;
    }
    const me = clientWorld.localPlayer;
    if (me) {
      const k = me.kinematics;
      const speed = Math.hypot(k.vx, k.vy);
      const status = isAlive(me)
        ? `energy ${me.resources.energy.toFixed(0)}`
        : `RESPAWNING in ${((me.combat.respawnAt - clientWorld.tick) / TICK_HZ).toFixed(1)}s`;
      hud.textContent =
        `fps ${fps}  (sim ${TICK_HZ}Hz)\n` +
        `pos ${k.x.toFixed(0)}, ${k.y.toFixed(0)}\n` +
        `speed ${speed.toFixed(2)} px/tick\n` +
        `${status}\n` +
        `bounty ${me.combat.bounty}  score ${me.combat.score}  ` +
        `${me.combat.kills}-${me.combat.deaths} (K-D)\n` +
        `projectiles ${clientWorld.projectiles.length}`;
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function killLine(world: World, killer: string | null, victim: string): string {
  const name = (id: string) => world.players.get(id)?.name ?? id;
  if (killer && killer !== victim) return `${name(killer)} killed ${name(victim)}`;
  return `${name(victim)} was destroyed`;
}

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
