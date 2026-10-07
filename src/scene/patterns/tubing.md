# tubing tile

World size: 12 m across (u, 256 px) by 4 m along (v, 85 px). Scale about 21.3 px/m. Period: 85 px (4 m) in v. u does not tile.

Layout: four chutes 48 px (2.25 m) wide at x=8, 72, 136, 200 (centres 32, 96, 160, 224). Berms 16 px (0.75 m) wide at x=56, 120, 184, plus 8 px half-berms at both outer edges. Dividers run the full height.

Seam proof: chutes, berms, polish streaks, shadow lines and the alpha mask are full-height rects that vary only in x (no filters, so no blur falloff at the top or bottom). Pressure marks are grouped once as `marks` and instanced at y offsets -85, 0 and +85, clipped by the viewBox. Row 0 and row 85 are therefore identical.

Colour tokens: base snow #eef4fb; chute gradient #bfd3ea / #d3e3f5 / #dcebfa / #d0e1f4 / #c6daf0; polish #ffffff at 0.8 (streak) and 0.55 (core line); berm shadow flank #9fb3cd, mid #c3d2e5, crest #ffffff, soft flank #f1f6fc, far edge #d6e2f1; berm cast shadow on chute #8ea6c4 at 0.35; mark ring #7e98ba at 0.5, mark fill #b9cfe8 to #97b0d0, mark rim highlight #ffffff at 0.8. Edge alpha 0.6 at u=0 and u=256, ramping to 1.0 by 5 percent inward (the soft outer berms).

Illusion technique: light comes from the right, as in the other snow tiles. Each berm is a horizontal gradient from a blue-grey shadowed left flank to a white crest right of centre, which reads as a rounded ridge, and a thin dark line at the chute's left edge fakes the berm's cast shadow. Chutes are bluer, with a bright centre polish streak for gloss. Each tube mark is a shallow radial dent with a dark upper-left rim and a white lower-right lip, which reads as a pressed-in hollow. Two marks per chute per 4 m, staggered between chutes and nudged 1 px sideways so the lanes do not look cloned.
