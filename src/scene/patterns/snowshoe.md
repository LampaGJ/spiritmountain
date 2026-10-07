# snowshoe tile

World size: 1.5 m across (u, 256 px) by 2.0 m along (v, 341 px). Scale 170.67 px/m.
Period: 341 px (2 m) in v. u does not tile.

Geometry: each print is 43 by 120 px (25 by 70 cm). Left print centre (112, 85.3), toed out 7 degrees. Right print centre (144, 255.8), toed out 7 degrees. The two sit 170.5 px (1 m, half the 2 m same-foot stride) apart in v.

Seam proof: the base, trough, edge rules and alpha mask are x-only full-height shapes. Both prints lie fully inside y 0..341 (left spans about 25..145, right about 196..316), so nothing is clipped at the seam. Loose-snow speckle uses feTurbulence with stitchTiles="stitch" on a filter region exactly equal to the tile (0,0,256,341), so the noise wraps. Measured with resvg-js: mean row0 versus last-row difference is 2.07 levels, against 1.45 for ordinary adjacent interior rows, which is noise-grain continuity.

Colour tokens: snow #eef4fb, trough shade #c3d2e5 / #cbd9ea / #d2deed, trough edge shade #b8c7da, lit rim #ffffff, print wall shadow #7f94b1, wall mid #b3c4da, print floor #d9e5f2, deck #d3e0f0 with hatch #9fb2c9, heel crescent #6a7f9d (edge #4f6382), speckle white #ffffff and blue-grey #9eb3cc. Edge alpha 0.55 at u=0 and u=256, ramping to 1.0 by 12 percent inward.

Illusion technique: relief comes from fake lighting from the right. Each print is a depression: a gradient from a dark left wall to a lit right floor, a thin blue outline, and an offset white stroke outside the lower right as the lit lip. The deck is an inner ellipse filled with a 45 degree crosshatch pattern at low contrast. The heel is a crisp dark crescent with a white glint on its lower edge, and a short slot marks the ball of the foot. The trough is a soft full-height gradient band of compressed snow between the prints. Loose snow at the edges is thresholded fractal noise (white and blue-grey specks), masked by an x-only weight so it fades out toward the trough.
