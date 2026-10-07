# snowboard tile (groomed run with carved turns)

World size: 12 m across (u, 256 px, 21.33 px/m) by 6 m along (v, 128 px). Tile repeats along v only.

Period: corduroy pitch 8 px (0.375 m); carve period 128 px (6 m), exactly one full S (one left and one right turn) per tile; vertical period of the whole tile 128 px.

Seam proof: the corduroy is an 8x128 pattern whose gradient varies only in x, so its vertical period equals H. The alpha mask is a full-height rect with an x-only gradient. Each carve is a polyline x(y) = 128 + A sin(2 pi y / 128 + phase) sampled every 4 px from y = -128 to 256; the sine has period exactly 128 and 4 divides 128, so vertices repeat identically at -H, 0, +H and the viewBox clips the overrun. The fringe stroke uses the same function offset by a multiple of the sine, so it is periodic too. Spray flecks are generated once for y in [0,128) and instanced at -H, 0, +H. The blur filter regions span y -140 to 270, so no blur edge falls inside the tile. Checked numerically: rendering the geometry with the viewBox shifted by 128 px gives a mean per-channel difference of 0.19 of 255 (the residual is only fleck instances beyond +2 px, absent by design). No clipPath is used, because resvg drops the lower rows when a clipPath sits inside a mask group.

Colour tokens:

- corduroy groove #C3D2E6, shoulder #CFDCEC, crest #E6EEF7 (lower contrast than downhill-run)
- trench wall #8EA5C6 (0.9 opacity), trench floor #B3C4DD (0.95 opacity)
- sprayed fringe and flecks #F4F8FD, #FAFCFF
- alpha mask luminance #999999 at u edges (0.6 alpha), #F2F2F2 inside 18 to 82 percent (0.95 alpha)

Illusion technique: three S-shaped carves with phases 0, 0.37 and 0.71 of a period sweep edge to edge and cross, like a freeride braid. Each is a two-stroke trench: a darker blue-grey wall stroke 11 to 13 px wide under a lighter, narrower floor stroke, so the wall reads as a sharp-edged shallow groove without any blur. On the outside of each turn, a blurred near-white stroke offset by a fraction of the same sine (the sign flips at the inflection, so it always sits on the outer side) lies under the trench, plus scattered small white flecks, which reads as snow thrown off the edge. The low-contrast corduroy underneath stays visible, so the carves look cut into groomed snow.
