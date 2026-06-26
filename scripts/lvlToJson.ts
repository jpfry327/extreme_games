/**
 * Convert a classic Subspace `.lvl` map into our sparse JSON tile format.
 *
 * A `.lvl` file is optionally prefixed with an embedded BMP tileset (magic
 * "BM"); the 4-byte little-endian field at offset 2 is that BMP's size, which
 * is exactly where the tile data begins. If there's no "BM" magic, the file is
 * tile data from byte 0.
 *
 * Tile data is a packed array of 4-byte little-endian entries:
 *   bits  0-11 = x      (0..1023)
 *   bits 12-23 = y      (0..1023)
 *   bits 24-31 = tile   (1..255)
 *
 * Our JSON is sparse: { "<flatIndex>": tileValue } with flatIndex = y*1024 + x,
 * any missing index meaning empty space — exactly what server/loadMap.ts and
 * src/map/loader.ts expand back into a GameMap.
 *
 * Usage: npx tsx scripts/lvlToJson.ts <input.lvl> <output.json>
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MAP_TILES = 1024; // must match src/config.ts

function convert(input: string, output: string): void {
  const buf = readFileSync(input);

  // Tile data starts after the embedded BMP tileset, if present.
  let offset = 0;
  if (buf[0] === 0x42 && buf[1] === 0x4d /* "BM" */) {
    offset = buf.readUInt32LE(2); // BMP size == tile-data start
  }

  const tileBytes = buf.length - offset;
  if (tileBytes % 4 !== 0) {
    throw new Error(`Tile region is ${tileBytes} bytes, not a multiple of 4`);
  }

  const sparse: Record<number, number> = {};
  let count = 0;
  let maxX = 0;
  let maxY = 0;
  const special: number[] = [];

  for (let i = offset; i < buf.length; i += 4) {
    const v = buf.readUInt32LE(i);
    const x = v & 0x3ff;
    const y = (v >> 12) & 0x3ff;
    const tile = (v >> 24) & 0xff;
    if (tile === 0) continue; // empty, shouldn't appear but skip defensively

    // Our tileset is 19x10 = 190 frames; renderer indexes frames[value-1].
    // Values >190 are Subspace "special" tiles (asteroids/station/wormhole/etc.)
    // with no plain wall frame — flag them so a bad import is obvious.
    if (tile > 190 && !special.includes(tile)) special.push(tile);

    sparse[y * MAP_TILES + x] = tile;
    count++;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(sparse));

  console.log(`Converted ${input} -> ${output}`);
  console.log(`  ${count} tiles, extent ${maxX + 1}x${maxY + 1} (grid ${MAP_TILES})`);
  if (special.length) {
    console.warn(`  WARNING: special tile values present (no wall frame): ${special.sort((a, b) => a - b).join(", ")}`);
  }
}

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error("Usage: npx tsx scripts/lvlToJson.ts <input.lvl> <output.json>");
  process.exit(1);
}
convert(input, output);
