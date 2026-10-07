# mtb-trail tile

World size: 1.5 m across (u) by 1.2 m along (v). Raster 256 x 204 px (about 170 px/m; 204 px is 1.2 m at 170 px/m).

Period: 204 px in v (1.2 m). Tile u does not repeat.

Seam proof: knob row 0 is centred on v=0, so each print is cut by the top edge. The whole content group `#period` is drawn three times, at y=-204, 0 and +204. The copy at y=-204 puts the lower half of row 0 (its v=204 instance) at the top edge as the continuation, and the copy at y=+204 puts the upper half at the bottom edge. All gradients vary only in x, so no colour step exists at v=0/204. Knob rows are 34 px apart (6 rows x 34 = 204), so spacing across the seam is unchanged. Roots and leaves near v=204 spill over and reappear at the top the same way.

Colour tokens:

- dirt edge #5a4128 at alpha 0.5, mid #7a5a36 / #9a7448, centre #a47c4c at alpha 1
- tread #b08856 (edges #8f683c)
- knob body #6b4a2a, knob highlight #c09a66, knob shadow umber #3b2614
- damp sheen #e8d4a8 at alpha up to 0.22
- leaves #a8672c #7e4a22 #c08a3c #8c5a28 #9a6a30 #b07a34 #b88a40
- roots #4a3018 with #7a5430 highlight

Illusion technique: blurred umber shadow under each raised knob plus a thin pale highlight on its lit side gives relief. Staggered rows read as a tire tread. A soft x-only sheen band suggests damp. Edge alpha ramps 1.0 to 0.5 so the aerial photo shows through. Plain inline SVG with gradients, one Gaussian blur filter, `use` and no foreignObject, for resvg.
