# mtb-trail tile

World size: 1.5 m across (u) by 1.2 m along (v). Raster 256 x 204 px (about 170 px/m). The scene enlarges the tile 5x, so one repeat covers 7.5 m by 6 m on the ground.

Period: 204 px in v (1.2 m). Tile u does not repeat.

Motif: ONE bold tyre-tread chevron per repeat, centred at u=128, pointing along +v. Polyline (40,50) (128,126) (216,50), stroke 58 px (23% of tile width), miter join. Occupies roughly v 25 to 170. It is a bold map symbol: no knobs, leaves, roots or gradients.

Seam proof: the chevron sits inside v 25 to 170, so rows 0 and 203 are both pure ground (#c9a066). Last row continues into the first with zero difference. No gradient or filter, so nothing varies in v at the seam.

Colour tokens:

- ground ochre dirt #c9a066, alpha 1.0
- chevron dark umber #2e1a0c, alpha 1.0

Luminance contrast between motif and ground is about 90 percent. No feature is smaller than 58 px (23 percent of width).

Legibility at 24 px: the 24 x 19 px preview (sips) shows a clear dark V on tan, distinct from a flat strip. The two arms and the tip are each several pixels thick.
