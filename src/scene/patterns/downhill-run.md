# downhill-run tile (groomed corduroy)

World size: 12 m across (u, 256 px, 21.33 px/m) by 1.5 m along (v, 32 px). Tile repeats along v only.

Period: ridge pitch 8 px (0.375 m, 32 ridges across); vertical period 32 px (1.5 m).

Seam proof: every element is either a full-height rect with no v-dependence (the sheen rect, the alpha mask rect, whose gradients vary only in x) or a pattern whose tile is 8x32, so its vertical period equals the tile height. Nothing varies with y, so row 0 and row 32 have identical content. Ridge gradient is symmetric (groove, ridge, groove), so it is also continuous across the 8 px pattern joins. No filters, no blur bleed across the edge.

Colour tokens:

- groove: #B9CBE3 (edge of pitch), #C9D8EB (shoulder)
- ridge crest: #EAF1F9
- sheen: #F0F5FB at 0 to 0.22 opacity, peak at centre
- alpha mask: luminance #999999 at u edges (0.6 alpha), #F2F2F2 inside 18 to 82 percent (0.95 alpha)

Illusion technique: corduroy is a 1-D periodic luminance ramp. Each ridge is a symmetric gradient (cool blue groove, near-white crest) so the eye reads a rounded rib lit from above; the cooler groove tone gives the shadow without any drawn lines. A wide, faint centre sheen adds a groomed-gloss falloff, and a luminance mask drops alpha to 60 percent at the edges so the aerial photo bleeds in. The 8 px pitch gives about 1.2 px grooves at 20 px display (reads as a tint band) and distinct ribs at 200 px without stripe harshness.
