# nordic-classic tile

World size: 4 m across (u, 256 px) by 2 m along (v, 128 px). Scale 64 px/m.
Period: 128 px (2 m) in v. u does not tile.

Geometry: groove centres at x=32 and x=44.8 (pair centre 38.4 px = 0.6 m from left edge). Groove width 4.5 px = 7 cm. Pitch 12.8 px = 20 cm.

Seam proof: every shape except the pole plants is a full-height rect (y 0..128, no v-dependence). The groomer fill is a pattern 16x64, and 64 divides 128 twice. The alpha mask and edge gradient vary in x only. The pole-plant ellipses sit at y 58..69, fully inside the tile, so none is clipped at v=0 or v=128. Row 0 and row 128 are therefore identical.

Colour tokens: snow #eef4fb, streak shade #dce7f4 / #d3e0f0, highlight #ffffff, groove shadow wall #5d7190, groove mid #8396b0, groove floor #a9b9cd, rim shade #b8c7da, pole plant #9fb2c9. Edge alpha 0.6 at u=0 and u=256, ramping to 1.0 by 9 percent inward.

Illusion technique: relief comes from fake lighting from the right. Each groove has a dark left wall line, a gradient floor, a white lit rim on the right and a soft blue shade rim on the left. Groomer corduroy is low-contrast vertical streaks plus tiny cross ticks. Pole plants are small blue-grey ellipses with a white glint, one per side per 2 m.
