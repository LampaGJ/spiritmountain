# downhill-run tile (blue groomer chevrons)

World size: 12 m across (u, 256 px, 21.33 px/m) by 1.5 m along (v, 32 px). Scene later enlarges it to 20 m wide, so one repeat is 2.5 m on the ground. Tile repeats along v only. Size is unchanged at 256 x 32 px.

Motif: one zigzag band of four 64 px legs across the tile (two chevrons), 45 degrees in world space, band thickness 16 px along v (half the period). Mid blue on white, a piste-map groomer-stripe icon.

Seam proof: the zigzag drops 32 px per 64 px leg and the period is 32 px, so the band shifted by one period lands on itself. A second copy drawn at y -32 fills the top rows, the viewBox clips both. Row 31 continues into row 0 with no break (patterns.test.ts passes).

Colour tokens: ground #FFFFFF; motif gradient #2F6FC4 at the edges to #1F58AA at the centre (x only, so it cannot break the seam). Alpha is 1.0 everywhere.

Legibility at 24 px: the 24 x 3 preview still shows a blue wave on white, clearly not a flat strip. Contrast is about 6:1 in luminance.

Exception to the stroke rule: the tile is only 32 px tall, so 15 percent of tile width cannot apply along v; the band is 16 px (50 percent of the period) instead.
