[out:json][timeout:60];
(
  way["piste:type"](46.68,-92.26,46.74,-92.17);
  way["aerialway"](46.68,-92.26,46.74,-92.17);
  way["highway"~"path|track|cycleway"]["mtb:scale"](46.68,-92.26,46.74,-92.17);
  way["route"="mtb"](46.68,-92.26,46.74,-92.17);
  relation["route"~"mtb|piste|ski"](46.68,-92.26,46.74,-92.17);
  relation["route"="hiking"](46.68,-92.26,46.74,-92.17);
    node["aerialway"](46.68,-92.26,46.74,-92.17);
  way["aerialway"="zip_line"](46.68,-92.26,46.74,-92.17);
  nwr["tourism"="camp_site"](46.68,-92.26,46.74,-92.17);
  nwr["sport"="climbing"](46.68,-92.26,46.74,-92.17);
  nwr["climbing"](46.68,-92.26,46.74,-92.17);
  nwr["attraction"](46.68,-92.26,46.74,-92.17);
  way["roller_coaster"="track"](46.68,-92.26,46.74,-92.17);
);
out geom;
