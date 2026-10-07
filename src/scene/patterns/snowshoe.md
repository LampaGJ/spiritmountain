# Snowshoe trail: tile

World size: 1.5 m across (u, 256 px) by 2 m along (v, 341 px). About 170.7 px per metre on both axes. The scene enlarges it 3x on the ground (4.5 m wide, 6 m repeat).

Design: one big oval snowshoe print per repeat, centred at (128, 170.5). The ring is 36 px thick (14 percent of the width; centre-line ellipse 100 x 140, outer edge 118 x 158). Inside, a crosshatch of two diagonal bands each way, 30 px wide, clipped to the inner ellipse (82 x 122). Smallest feature: the white diamonds between bands, about 40 px.

Period: 341 px (2 m), one print per tile.

Seam proof: the ring spans y 12.5..328.5, so rows 340 and 0 are both plain snow, and nothing else varies along v.

Colour tokens

- snow: #ffffff
- ring and crosshatch: #3b5878 (slate blue)
- alpha: 1.0 everywhere

Legibility at 24 px: at 24x32 px the oval ring and the diamond crosshatch both read, so the print is distinct from a flat strip. The crosshatch is the weakest element, but it still shows as a darker interior.
