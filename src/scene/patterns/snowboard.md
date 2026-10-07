# snowboard tile (deep-blue S-curve)

World size: 12 m across (u, 256 px, 21.33 px/m) by 6 m along (v, 128 px). Scene later enlarges it to 20 m wide, so one repeat is 6 m on the ground. Tile repeats along v only. Size is unchanged at 256 x 128 px.

Motif: one stroke, 44 px wide (17 percent of the tile width), swinging between x=66 and x=190 and crossing the centre once per period at y=0 and y=64 (one S per tile).

Seam proof: the path is three cubic Beziers between the extremes (190,32), (66,96) and (190,160), starting at (66,-32), with vertical tangents at each extreme. The curve is exactly periodic every 128 px, and the viewBox clips the overrun. Measured with resvg: seam row difference 1.55 against an interior maximum of 2.33 (patterns.test.ts passes).

Colour tokens: ground #FFFFFF; stroke #0B3A8F. Alpha is 1.0 everywhere.

Legibility at 24 px: the 24 x 12 preview shows a clear dark-blue S on white. Contrast is about 11:1 in luminance.
