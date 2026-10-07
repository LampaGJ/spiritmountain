# fat-bike tile

World size: 1.5 m across (u) by 1.2 m along (v). Raster 256 x 204 px (about 170 px/m). The tyre track is 20 px wide, about 12 cm.

Period: 204 px in v (1.2 m). Tile u does not repeat.

Seam proof: all content sits in `#period`, drawn at y=-204, 0 and +204 and clipped by the viewBox. The track centre line is `128 + 4.5 sin(2 pi y/204) + 1.8 sin(4 pi y/204 + 1.1) + 0.8 sin(10 pi y/204 + 2)`, a sum of harmonics of 204, so the wobble and the track edges match at v=0 and v=204. The track polylines are sampled every 6 px (34 steps per period) and run 12 px past each end. Knob rows repeat every 51 px (204/4), with side knobs on v=0 so they straddle the seam and the instances complete them. Groomer grain is a pattern 4 px wide by 204 px high. The turbulence uses stitchTiles over a 256 x 204 region. Gradients vary only in x. Loose snow dabs are inside the period group and wrap through the instances.

Colour tokens:

- snow lane #F1F6FC (centre), #EBF2FA, #DCE7F4, edge #C3D2E6, alpha 0.5 at the edges to 1.0 in the lane
- groomer grain #9FB3CE at alpha up to 0.13, noise tint rgb(158,179,209)
- track bed #D4E0F0 and #E4ECF7
- track shoulder shadow #9DB0CC, shoulder light #FFFFFF
- knob cup shadow #7F93B2, cup floor #8CA0BE, cup lit lip #C9D6E8, cup rim #F8FBFF
- loose snow #F4F8FD (light), #B7C6DB (shaded)
- flecks #FFFFFF and #A9BAD2

Illusion technique: the knobs are cups pressed into the snow, so the upper-left wall carries a blurred blue-grey shadow and the lower-right lip catches a pale highlight, the reverse of the raised knobs in mtb-trail. Light comes from the top left. The side knobs tilt 14 degrees outward and the centre knobs sit half a row away, so the staggered rows read as a fat-bike tread with wide gaps. The track bed is a slightly darker compacted band with a shaded left shoulder and a lit right shoulder, which gives a shallow trench. Fine x-only stripes plus stitched fractal noise, faded toward the verges by a mask, suggest groomer texture. Soft ellipses of light and shaded snow at the edges read as loose snow, and the alpha ramp from 1.0 to 0.5 lets the photo bleed in. Plain inline SVG: paths, gradients, one pattern, a mask, blur and feTurbulence, no foreignObject, checked with @resvg/resvg-js.
