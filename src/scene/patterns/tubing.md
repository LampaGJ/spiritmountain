# tubing tile (orange tube ring)

World size: 12 m across (u, 256 px, 21.33 px/m) by 4 m along (v, 85 px). Scene later enlarges it to 20 m wide, so one repeat is about 6.7 m on the ground. Tile repeats along v only. Size is unchanged at 256 x 85 px.

Motif: one ring (donut) centred at (128, 42.5), centreline radius 28 px, stroke 22 px, so outer radius 39 px and inner hole radius 17 px. The ring is 78 px across against an 85 px period.

Seam proof: the ring sits wholly inside the tile (top at y=3.5, bottom at y=81.5), so rows 84 and 0 are both plain ground and match exactly (patterns.test.ts passes).

Colour tokens: ground #FFFFFF; ring #E8590C. Alpha is 1.0 everywhere.

Legibility at 24 px: the 24 x 8 preview shows an orange ring with a white hole on white. Contrast is about 3.5:1 in luminance (orange is brighter than the blues), and the hue difference carries it.

Exception to the stroke rule: the tile is only 85 px tall, so a stroke of 15 percent of the width (38 px) does not fit; the stroke is 22 px (26 percent of the period, above the 1/8 minimum).
