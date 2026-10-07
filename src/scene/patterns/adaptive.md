# adaptive tile (sit-ski / mono-ski with outriggers, groomed run)

World size: 12 m across (u, 256 px, 21.33 px/m) by 4 m along (v, 85 px). Tile repeats along v only.

Period: 85 px (3.98 m). One carve sine period per tile, amplitude 14 px (0.66 m). Four outrigger plants per period, one every 21.25 px (about 1.0 m), alternating left and right. The brief asked for 1.3 m, but 1.3 m does not divide 4 m, and alternation needs an even count per period, so 4 marks at 1.0 m is the nearest seamless choice. Each side is planted every 2.0 m.

Seam proof: the corduroy pattern is 8x85, so its vertical period equals the tile height. The carve is a polyline of x = 128 + 14 sin(2 pi y / 85) sampled from y = -85 to 170 and clipped to the viewBox, so row 0 and row 85 match exactly. Each outrigger mark is instanced at y offsets -85, 0, +85 and clipped. Mark x follows the same periodic function, so offsets agree. The blur filter region spans y = -100 to 185, so blur does not truncate at the seam. The alpha mask varies only in x.

Colour tokens:

- corduroy: #C3D2E6, #CFDCEC, #E6EEF7 (same family as snowboard, 8 px pitch)
- carve: #6F86A8 core 3 px, #4A6086 at 0.7 opacity inner 1.2 px, white halo #FFFFFF at 0.55 opacity 5.5 px
- outrigger crescent: #4F6688 with #F4F8FD rim; basket dot #3B4F72
- alpha mask: #999999 at u edges (0.6 alpha), #F2F2F2 inside 18 to 82 percent

Illusion technique: one deep line plus two staggered rows of crescents. The line is wider than the true 10 cm (3 px against 2.1 px) so it survives at 20 px, and its white halo reads as a pressed lip of snow. The signature feature is the outrigger plants. Each is a cupped crescent with a dark basket-hole dot, set 12.8 px (60 cm) off the ski line on alternating sides, and each follows the carve as it weaves. At 20 px display the carve is a thin line and the plants become a zigzag of dots either side of it. A snowboard has a wide sweeping arc with no flanking marks, and a downhill run is bare corduroy, so the flanking dot rhythm tells adaptive apart. The small blur (0.5 px) softens the marks as if pressed into snow.

Raster fix (#31 integration): the blur filter region was y -100 to 185, which made resvg render rows 68 to 84 fully transparent. It is now y -20 to 105 (20 px past each tile edge, enough for a 0.5 px blur). A test in tests/scene/patterns.test.ts fails on any fully transparent row.
