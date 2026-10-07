# Nordic trail, skate technique: tile

World size: 4 m across (u, 256 px) by 3 m along (v, 192 px). 64 px per metre on both axes. The scene enlarges it 2x on the ground (8 m wide, 6 m repeat).

Design: one herringbone V (apex up, arms to the lower corners) per repeat, drawn as a 44 px stroke (17 percent of the width) in deep blue, wholly inside y 18..170 so the repeat shows as a V followed by clear snow. The arms rise along v, so the V reads as a skate stroke. Smallest feature: 44 px.

Period: 192 px (3 m), one V per tile.

Seam proof: the V and its mitre stay inside the tile, so rows 191 and 0 are both bare snow. The grain is feTurbulence with stitchTiles="stitch" and base frequency 6/192 along v, 8/256 along u (whole cycles), so it wraps along v.

Grain: the `#grain` filter tints the snow with a pale blue noise layer at 50 percent opacity. It stays light, so snow versus V contrast is preserved, and tests/scene/patterns.test.ts sees varying pixels in the lane.

Colour tokens

- snow: #ffffff with feTurbulence tint rgb(158,189,230) at up to 50 percent
- V stroke: #12327f
- alpha: 1.0 everywhere

Legibility at 24 px: at 24x18 px the V is a clear blue chevron on near-white. Luminance contrast is well above 50 percent.
