# trail-run tile

World size: 1.0 m across (u) by 2.4 m along (v). Raster 256 x 614 px. The scene enlarges it 2.5x (2.5 m wide, 6 m repeat).

Period: 614 px in v (2.4 m). One bold chevron per repeat, a polyline (36,470) (128,240) (220,470) stroked 76 px wide (30 percent of the tile width) with a miter join. The tip points toward v=0 (image up); flip the polyline vertically if the scene shows it pointing against travel. Tile u does not repeat.

Seam proof: the chevron spans about y 145 to 505, so nothing touches v=0 or v=614. The ground is an x-only gradient, so the last row continues into the first. tests/scene/patterns.test.ts passes (47 of 47).

Colour tokens:

- ground ochre #e0ac45, alpha 0.6 at the u edges ramping to 1.0 by 8 percent
- chevron #2e1a08

Legibility at 24 px: a 24 x 58 downscale shows a dark upward arrowhead centred on ochre. The chevron is the only dark shape and reads at once. Luminance contrast is above 80 percent.
