# hike tile

World size: 1.2 m across (u) by 1.5 m along (v). Raster 256 x 320 px. The scene enlarges it 4x (4.8 m wide, 6 m repeat).

Period: 320 px in v (1.5 m). One big boot-print silhouette per repeat, centred: forefoot (x 50 to 206, y 30 to 190) and heel (x 70 to 186, y 204 to 292), 14 px of ground between them. Tile u does not repeat.

Seam proof: the motif sits at y 30 to 292, so no shape touches v=0 or v=320. The ground fill is an x-only gradient, so row 319 continues into row 0 exactly. tests/scene/patterns.test.ts passes (47 of 47).

Colour tokens:

- ground tan #d2b27c, alpha 0.6 at the u edges ramping to 1.0 by 8 percent
- boot silhouette #2a1a0c

Legibility at 24 px: a 24 x 30 downscale shows a dark forefoot blob over a smaller heel blob on tan, clearly not a flat strip. Luminance contrast is above 80 percent. Smallest feature is the 14 px gap (about 1/23 of the tile height) and it still reads at 24 px.
