# trail-run tile

World size: 1.0 m across (u) by 2.4 m along (v). Raster 256 x 614 px (256 px/m; 614 = round(256 x 2.4)).

Period: 614 px in v (2.4 m), which holds two strides of 307 px (1.2 m). Tile u does not repeat.

Seam proof: the whole `#period` group is drawn three times, at y=-614, 0 and +614, and the viewBox clips the result. The crossing root sits at v=607 to 610 and its stroke and blur spill past v=614, so the copy at y=-614 supplies the continuation at the top. The nearest print is centred at v=60 (extent about 26 to 95 with scuffs) and v=520 (extent about 486 to 585), so no print touches the seam. The two gradients vary only in x, so no colour step exists at v=0/614. Left prints sit at v=60 and 367, right prints at v=213 and 520, so same-side spacing is 307 px both inside the tile and across the seam (520 to 60+614 is 154 px between feet, matching 213 to 367).

Colour tokens:

- dirt edge #8a6a44 at alpha 0.5, mid #a98457 / #c29c68, centre #cba673 at alpha 1
- running line #dcc08e at alpha up to 0.55
- sole fill #a07c50, chevron lugs #6a4a2a, lit lip #e6cf9e, print shadow #4a3320
- scuff marks #6a4a2a at alpha 0.5
- pebbles #9a8c7a with highlight #cfc4b2
- root #5a3d22 with highlight #9a7348 and shadow #3b2614

Illusion technique: each print is a forefoot-heavy sole outline with a narrow midfoot, a very short heel stub and six chevron lugs pointing toward the toe. A blurred umber shadow offset down-right and a thin pale lip on the upper-left edge make the print read as pressed into the dirt. Short drag strokes and two crumbs behind each toe show the push-off. Left and right prints alternate with a 1.2 m same-side stride. Edge alpha ramps 1.0 to 0.5 so the aerial photo shows through. The palette is lighter and sandier than hike. Plain inline SVG with gradients, two Gaussian blurs, `use` and no foreignObject, for resvg.
