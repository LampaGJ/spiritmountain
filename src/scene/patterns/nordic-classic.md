# Nordic trail, classic technique: tile

World size: 4 m across (u, 256 px) by 2 m along (v, 128 px). 64 px per metre on both axes. The scene enlarges it 3x on the ground (12 m wide, 6 m repeat).

Design: a bold map symbol. Two dark-blue track grooves, each 44 px (17 percent of the width) wide, run the full tile height and are centred on the tile (x 66..110 and 146..190, centre 128). One cross-tick 24 px tall (19 percent of the period) bridges the grooves at y 52..76, once per period. Smallest feature: 24 px (above 1/8 of the 128 px period axis, 16 px).

Period: 128 px (2 m), one tick per tile.

Seam proof: grooves and the snow gradient are constant in v, and the tick lies wholly inside y 52..76, so row 127 and row 0 are identical rows (plain snow plus grooves).

Colour tokens

- snow: #ffffff at the centre to #eaf1fa at the edges (x-only gradient)
- groove: #14307a to #2447a0 (x gradient per groove)
- cross-tick: #1b3a8c
- alpha: 1.0 inside, 0.6 at u = 0 and u = 256 with a 4 percent ramp (x-only mask)

Legibility at 24 px: at 24x12 px the two dark grooves and the bridging tick read as a blue H on white. Luminance contrast is well above 50 percent.
