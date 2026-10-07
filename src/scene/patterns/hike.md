# hike tile

World size: 1.2 m across (u) by 1.5 m along (v). Raster 256 x 320 px (about 213 px/m).

Period: 320 px in v (1.5 m, two strides of 0.75 m). Tile u does not repeat.

Seam proof: all content sits in one group `#period` that is drawn three times, at y=-320, 0 and +320, and clipped by the viewBox. Items that cross v=0/320 (roots, leaves, stones, shadows) therefore continue across the seam. The dirt and worn-tread fills are x-only gradients, so no colour step exists at the seam. Prints are centred at v=80 (left) and v=240 (right), 160 px apart, so the stride is unchanged across the wrap. A render of two stacked tiles shows no visible join.

Colour tokens:

- dirt edge #5a4128 at alpha 0.5, mid #7a5a36 / #9a7448, centre #a47c4c at alpha 1
- worn tread #b08856 / #bc9560
- boot print body #7a5632, lug shadow #35220f, lug highlight #c9a36e, shadow umber #3b2614
- stones #8a7a66 with highlight #c4b49a
- roots #4a3018 with #7a5430 highlight
- leaves #a8672c #7e4a22 #c08a3c #8c5a28 #9a6a30 #b07a34 #b88a40
- speckle #4a3320

Illusion technique: each boot print is a blurred umber shadow offset down-right, a lighter pressed-in sole, a deeper blurred heel, and two rows of small dark lug rectangles with a pale copy offset up-left, so the lugs read as sunk blocks lit from the upper left. Prints alternate left and right, 12 by 30 cm each, rotated a few degrees. Stones and roots carry the same offset blurred shadow plus a highlight. A worn pale centre band and edge alpha ramp from 1.0 to 0.5 let the photo bleed in at the sides, where leaf litter collects. Plain inline SVG with gradients, one Gaussian blur, `use`, no foreignObject, for resvg.
