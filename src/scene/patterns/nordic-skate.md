# Nordic trail, skate technique: tile

World size: 4 m across (u, 256 px) by 3 m along (v, 192 px). 64 px per metre on both axes.

Period: 96 px (1.5 m) along v. The tile holds exactly two periods, so 192 is an integer multiple of the period.

Seam proof: the cut group `#cuts` is instanced at y = -96, 0, 96 and 192, and the viewBox clips the result. Every instance is the same geometry shifted by a multiple of 96, so the pattern is invariant under a shift of 96 and therefore of 192. A stroke leaving the bottom edge at y = 192 is the same path that enters the top edge at y = 0 (instance k and instance k+2 coincide after the shift). The left cut spans y 8..41 (with its highlight and width up to 13 px) and the right cut y 56..89, per period. The y = -96 and y = 192 instances supply the strokes whose round caps and widths cross the edges. The corduroy lines are vertical, so they are constant in v. The grain uses feTurbulence with stitchTiles="stitch" and a base frequency of 6/192 along v and 8/256 along u, whole cycles per tile. u does not tile and need not.

Colour tokens

- snow base: #e6eef8 at the lane edges, #f4f8fd at the centre
- grain tint: #738fb3 at low alpha (35 percent layer, noise-driven)
- corduroy: #9fb3cb at 16 percent
- cut halo: #8da0b6 at 18 percent, 13 px
- cut body: #7f93a8 at 50 percent, 7 px
- cut core shadow: #6f84a0 at 45 percent, 3 px
- cut lit lip: #ffffff at 75 percent, 2.5 px, offset +5 px in y
- alpha: 0.6 at u = 0 and u = 256, 1.0 from u = 51 to 205 (linear gradient mask)

Illusion technique: each cut is three stacked strokes (wide halo, body, narrow core) that fake a soft-walled groove without blur, so nothing bleeds across the seam. A white lip offset below the cut reads as a lit far wall, with light from above. Left and right diagonals mirror each other, offset by half a period (48 px), which makes the herringbone chevron zigzag. Low-contrast vertical corduroy and noise grain sit underneath. Edge alpha comes from a horizontal luminance mask on the whole group.
