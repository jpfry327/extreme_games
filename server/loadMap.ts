/**
 * Server-side map loader — reads map.json from the filesystem using Node's `fs`
 * module instead of `fetch`, which is browser-only. The pure `GameMap` it
 * returns is identical to what the browser client builds via src/map/loader.ts.
 * (src/map/loader.ts even has a comment pointing here for the server path.)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAP_TILES } from "../src/config";
import { GameMap } from "../src/sim/gamemap";

export function loadMapSync(): GameMap {
  const raw = readFileSync(
    join(import.meta.dirname, "../assets/arenas/svs/map.json"),
    "utf8",
  );
  const sparse = JSON.parse(raw) as Record<string, number>;

  const tiles = new Uint8Array(MAP_TILES * MAP_TILES);
  for (const key in sparse) {
    const idx = +key;
    if (idx >= 0 && idx < tiles.length) tiles[idx] = sparse[key];
  }

  return new GameMap(MAP_TILES, MAP_TILES, tiles);
}
