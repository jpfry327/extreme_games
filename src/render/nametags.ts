import { Container, Text } from "pixi.js";
import { isAlive } from "../sim/player";
import type { Player } from "../sim/types";
import type { World } from "../sim/world";

/** Linear interpolation helper (matches the renderer's). */
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// Original Subspace draws the name above the bounty in a small pixel font, your
// own ship in yellow and everyone else in white. We approximate that here with
// Pixi text; the pixel-perfect bitmap-font version is built in M3 (the font
// atlas), which this layer will then swap onto.
const SELF_COLOR = 0xffe066; // your own name — yellow
const OTHER_COLOR = 0xffffff; // everyone else — white
// The label hangs off the ship's lower-right corner (as in the original), its
// top-left anchored just past the hull.
const NAME_OFFSET_X = 8;
const NAME_OFFSET_Y = 8;

interface Tag {
  text: Text;
  lastLabel: string; // cache so we only re-rasterize when the text changes
  lastColor: number;
}

/**
 * One name/bounty label per player, drawn in world space so it tracks the ship.
 * Pooled and reused like the sprite layers. Reading the text is cheap but
 * *changing* it re-rasterizes the glyphs, so we only touch `.text`/tint when the
 * label or colour actually changes.
 */
export class NametagLayer {
  readonly container = new Container();
  private tags: Tag[] = [];

  update(world: World, alpha: number): void {
    const players: Player[] = [...world.players.values()];
    while (this.tags.length < players.length) this.tags.push(this.makeTag());

    for (let i = 0; i < this.tags.length; i++) {
      const tag = this.tags[i];
      const p = players[i];
      if (!p || !isAlive(p)) {
        tag.text.visible = false;
        continue;
      }

      const label = `${p.name}\n${p.combat.bounty}`;
      if (label !== tag.lastLabel) {
        tag.text.text = label;
        tag.lastLabel = label;
      }
      const color = p.id === world.localPlayerId ? SELF_COLOR : OTHER_COLOR;
      if (color !== tag.lastColor) {
        tag.text.tint = color;
        tag.lastColor = color;
      }

      const k = p.kinematics;
      tag.text.visible = true;
      tag.text.x = Math.round(lerp(k.prevX, k.x, alpha) + NAME_OFFSET_X);
      tag.text.y = Math.round(lerp(k.prevY, k.y, alpha) + NAME_OFFSET_Y);
    }
  }

  private makeTag(): Tag {
    const text = new Text({
      text: "",
      style: {
        fontFamily: "monospace",
        fontSize: 12,
        fill: 0xffffff, // tinted per-player; kept white so tint is exact
        align: "left",
        lineHeight: 13,
        stroke: { color: 0x000000, width: 3 }, // dark outline = readable on space
      },
    });
    text.anchor.set(0, 0); // top-left anchored at the ship's lower-right
    text.resolution = 2; // crisper small text
    this.container.addChild(text);
    return { text, lastLabel: "", lastColor: OTHER_COLOR };
  }
}
