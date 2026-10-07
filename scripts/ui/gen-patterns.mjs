// Rasterises the eleven trail-ribbon tiles (one per activity that has a ribbon) in src/scene/patterns/<tile>.svg to <tile>.png and writes patterns.json.
// Usage: node scripts/ui/gen-patterns.mjs            (writes the PNGs and the manifest)
//        node scripts/ui/gen-patterns.mjs --check    (exits 1 when a committed PNG or the manifest is stale)
// Output is a pure function of (SVG bytes, @resvg/resvg-js version): no clock, no randomness, no system fonts
// (the tiles contain no text). The manifest records, per tile, the world size the tile covers, the repeat
// period along the trail, the pixel size and the sha256 of both the SVG and the PNG.
// The activity-to-tile map is ACTIVITY_TILE in src/scene/ribbon-kinds.ts; lift-ride has no tile (lifts stay cables).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', '..', 'src', 'scene', 'patterns');

/**
 * World size per tile, from each tile's .md note. widthM is across the trail (image x, not repeated);
 * periodM is along the trail (image y, repeated). nordic-skate's tile holds two 1.5 m strokes, so its
 * repeat is the full 3 m tile height.
 */
const TILES = [
  { name: 'downhill-run', widthM: 12, periodM: 1.5 },
  { name: 'nordic-classic', widthM: 4, periodM: 2 },
  { name: 'nordic-skate', widthM: 4, periodM: 3 },
  { name: 'mtb-trail', widthM: 1.5, periodM: 1.2 },
  { name: 'snowboard', widthM: 12, periodM: 6 },
  { name: 'snowshoe', widthM: 1.5, periodM: 2 },
  { name: 'fat-bike', widthM: 1.5, periodM: 1.2 },
  { name: 'hike', widthM: 1.2, periodM: 1.5 },
  { name: 'trail-run', widthM: 1, periodM: 2.4 },
  { name: 'tubing', widthM: 12, periodM: 4 },
  { name: 'adaptive', widthM: 12, periodM: 4 },
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Renders one tile at its authored pixel size. Returns the PNG bytes and the size. */
function render(name) {
  const svg = readFileSync(join(dir, `${name}.svg`));
  const resvg = new Resvg(svg, { fitTo: { mode: 'original' }, font: { loadSystemFonts: false } });
  const image = resvg.render();
  return { svg, png: image.asPng(), widthPx: image.width, heightPx: image.height };
}

const manifest = { tiles: {} };
const pngs = new Map();
for (const tile of TILES) {
  const { svg, png, widthPx, heightPx } = render(tile.name);
  pngs.set(tile.name, png);
  manifest.tiles[tile.name] = {
    file: `${tile.name}.png`,
    widthM: tile.widthM,
    periodM: tile.periodM,
    widthPx,
    heightPx,
    svgSha256: sha256(svg),
    pngSha256: sha256(png),
  };
}
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const stale = [];
  for (const [name, png] of pngs) {
    let committed = null;
    try {
      committed = readFileSync(join(dir, `${name}.png`));
    } catch {
      /* missing counts as stale */
    }
    if (committed === null || !committed.equals(png)) stale.push(`${name}.png`);
  }
  let committedManifest = null;
  try {
    committedManifest = readFileSync(join(dir, 'patterns.json'), 'utf8');
  } catch {
    /* missing counts as stale */
  }
  if (committedManifest !== manifestText) stale.push('patterns.json');
  if (stale.length > 0) {
    console.error(
      `gen-patterns: stale: ${stale.join(', ')}. Run: node scripts/ui/gen-patterns.mjs`,
    );
    process.exit(1);
  }
  console.log(`gen-patterns: ${pngs.size} tiles up to date`);
} else {
  for (const [name, png] of pngs) writeFileSync(join(dir, `${name}.png`), png);
  writeFileSync(join(dir, 'patterns.json'), manifestText);
  console.log(`gen-patterns: wrote ${pngs.size} PNGs and patterns.json`);
}
