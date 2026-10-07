# fat-bike tile

World size: 1.5 m across (u) by 1.2 m along (v). Raster 256 x 204 px (about 170 px/m). The scene enlarges the tile 5x, so one repeat covers 7.5 m by 6 m on the ground.

Period: 204 px in v (1.2 m). Tile u does not repeat.

Motif: ONE wide fat-tyre tread block per repeat, centred at u=128. Pentagon (40,40) (216,40) (216,112) (128,168) (40,112), plus an 8 px round-joined stroke, so it spans about u 36 to 220 (72 percent of width) and v 36 to 172. Wide flat top with a shallow chevron point, distinct from the narrower mtb-trail chevron. No grain, cups, noise or gradients.

Seam proof: the block sits inside v 36 to 172, so rows 0 and 203 are both pure ground (#f4f8fd). Last row continues into the first with zero difference. No gradient or filter, so nothing varies in v at the seam.

Colour tokens:

- ground pale snow #f4f8fd, alpha 1.0
- tread block deep blue-grey #2c4260, alpha 1.0

Luminance contrast between motif and ground is about 90 percent. No feature is smaller than 72 px in v (35 percent of the tile).

Legibility at 24 px: the 24 x 19 px preview (sips) shows a clear dark blue shield on white, distinct from a flat strip and from the brown ground of mtb-trail.
