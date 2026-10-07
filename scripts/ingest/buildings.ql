[out:json][timeout:90];
(
  way["building"](46.68,-92.26,46.74,-92.17);
  relation["building"](46.68,-92.26,46.74,-92.17);
  way["man_made"~"tower|mast|water_tower|storage_tank"](46.68,-92.26,46.74,-92.17);
);
out geom;
