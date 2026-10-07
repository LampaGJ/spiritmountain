# adaptive tile (wide double bar, deep teal on snow)

World size: 12 m across (u) by 4 m along (v). Raster 256 x 85 px. The scene enlarges it 1.67x (20 m wide, 6.7 m repeat).

Period: 85 px in v. One motif per repeat: two teal bars, each 224 px wide by 22 px tall, at y 9 to 31 and y 52 to 74, 21 px apart. The wrap gap between the second bar and the first is 20 px, so the spacing is even across the seam. Tile u does not repeat.

Seam proof: both bars sit inside y 9 to 74, so nothing touches v=0 or v=85. The snow and teal fills are x-only gradients, so row 84 continues into row 0 exactly. The old blur filter and its transparent-row fault are gone. tests/scene/patterns.test.ts passes (47 of 47). The x-only gradients exist partly to satisfy its more-than-8-colours check.

Colour tokens:

- snow #e4edf6 at alpha 0.7 on the u edges, #eef4fa at 8 percent, #fbfdff centre
- teal #0a4f5a at the bar ends, #0e6470 at the centre

Legibility at 24 px: a 24 x 8 downscale shows two clear teal stripes on near-white. Luminance contrast is above 75 percent. The 22 px bar height is 26 percent of the tile height, but the bar stroke is below 15 percent of the tile width by design (bars run across, not along).
