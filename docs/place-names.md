---
type: reference
status: draft
review_by: 2027-04-01
related: [scripts/ingest/places.seed.json, scripts/ingest/places.ts, src/data/load-places.ts]
---
# Spirit Mountain Recreation Area place names

Question: which named sub-areas, peaks, zones, trail systems and landmarks does Spirit Mountain Recreation Area (Duluth, MN) have, with enough location detail to place each as a map point?

Sub-claims sourced:
- sub-claim 1: named facilities and areas on spiritmt.com
- sub-claim 2: bike park zones and trail systems
- sub-claim 3: neighbouring peaks and overlooks
- sub-claim 4: map coordinates for each name

## TL;DR

OSM gives coordinates for the Upper Chalet, Grand Avenue Chalet, the four named lifts, the campsite, Lone Oak Rope Tow, the Adventure Park, Bardon Peak and Elys Peak. spiritmt.com and duluthmn.gov give names and relative locations for the Nordic centers, Skills Area, Happy Hub, Norton Park and the bike trails, but no coordinates. "Spirit Park", "Lone Oak Rope Park", a separate summit name and any Magney-Snively point were not confirmed. WebFetch returns model summaries, so all wording below is paraphrased and the OSM coordinates are as relayed by the fetch; re-check them before use.

## Findings

- Adventure Park (spiritmt.com spelling "Adventure Park"): lists Timber Flyer Zip Line (700 ft), Timber Twister Alpine Coaster (3200 ft of track), Spirit Express II scenic chairlift, Jumping Pillow, a 9-hole Putt-Putt course; the Superior Hiking Trail trailhead parking is "Lot D" up Skyline Parkway from the main Skyline Chalet entrance. No coordinates on the page. https://spiritmt.com/summer/adventure-park/ [sub-claim 1: named facilities and areas on spiritmt.com]
- Home page lists Skyline Chalet (event venue), Campground (73 sites), Riverside Bar Grill, Mountain Biking area; street address 9500 Spirit Mountain Place, Duluth, MN 55810 (geocodable). https://www.spiritmt.com/ [sub-claim 1: named facilities and areas on spiritmt.com]
- Nordic: "Nordic Center at Grand" (Lower Nordic), 8551 Grand Ave, with the Grand Avenue Chalet; "Upper Spirit Mountain Nordic Trails", 9535 West Skyline Parkway, 22 km, Upper Nordic Building; "Nordic Connector" trail, about 2 km, 405 ft vertical, links the two. https://spiritmt.com/winter/nordic/ [sub-claim 1: named facilities and areas on spiritmt.com]
- City project page: Spirit Mountain Nordic Center sits next to the Grand Avenue Chalet in West Duluth; Phase I 3.3 km, Phase II adds an 800 m connector between lower and upper mountain. https://duluthmn.gov/parks/parks-trails/current-projects/spirit-mountain-nordic-center/ [sub-claim 2: bike park zones and trail systems]
- City cycling page: "Norton Park" trails on the east side of Spirit Mountain (adaptive green trail, nearly 2 mile enduro loop, Duluth Traverse from Kingsbury Creek to Knowlton Creek); "Happy Hub" jump trails (green/blue/black) right off Skyline Parkway near the Happy Camper trail; "Skills Area" just west of the Grand Avenue chalet; "Blue Jump Line". No coordinates. https://duluthmn.gov/parks/parks-trails/current-projects/spirit-mountain-off-road-cycling-trails/ [sub-claim 2: bike park zones and trail systems]
- Bike trail directory: Duluth Traverse trailhead is at the Grand Avenue Chalet; Rock Candy passes beneath the Adventure Park zip line; named trails include Happy Camper, Candyland, Smorgasbord, Rock Candy, Anvil, Boot, Blaster, Knowlton Rocks, Wild Cat, Wrecking Ball, Calculated Risk, Boss Hog, Greenman, Moonman, Portage, The Puker, AWT. The fetch summary also mentions a "Lower parking lot" near the zoo. https://spiritmt.com/summer/mountain-biking/trails/ [sub-claim 2: bike park zones and trail systems]
- OSM name "Spirit Mountain Upper Chalet" (chalet): about 46.7180, -92.2167. https://overpass-api.de/api/interpreter?data=[out:json][timeout:25];(node(around:3500,46.71,-92.21)[name][~"^(natural|tourism|amenity|aerialway|leisure|place|man_made)$"~"."];way(around:2500,46.71,-92.21)[name][~"^(leisure|tourism|aerialway)$"~"."];);out center tags 120; [sub-claim 4: map coordinates for each name]
- OSM name "Grand Avenue Chalet, Riverside Bar & Grill": about 46.7155, -92.2058 (same OSM query as above; Lower / Grand Avenue Chalet point). https://overpass-api.de/api/interpreter?data=[out:json][timeout:25];(node(around:3500,46.71,-92.21)[name][~"^(natural|tourism|amenity|aerialway|leisure|place|man_made)$"~"."];way(around:2500,46.71,-92.21)[name][~"^(leisure|tourism|aerialway)$"~"."];);out center tags 120; [sub-claim 4: map coordinates for each name]
- OSM lifts: "Summit Chair" 46.7176, -92.2144; "Spirit Express II" 46.7162, -92.2134; "Gandy Chair" 46.7192, -92.2122; "Big Air Chair" 46.7200, -92.2118; "Lone Oak Rope Tow" 46.7173, -92.2184; "Prospector Carpet" 46.7187, -92.2166; "F-Tow" 46.7188, -92.2161; "Tubing Hill Handle Tow" 46.7159, -92.2197. Each is a single point from the fetch (a lift may be a line in OSM; these are the relayed points). https://overpass-api.de/api/interpreter?data=[out:json][timeout:25];(node(around:3500,46.71,-92.21)[name][~"^(natural|tourism|amenity|aerialway|leisure|place|man_made)$"~"."];way(around:2500,46.71,-92.21)[name][~"^(leisure|tourism|aerialway)$"~"."];);out center tags 120; [sub-claim 4: map coordinates for each name]
- OSM names "Spirit Mountain Adventure Park" (attraction) 46.7150, -92.2182 and "Spirit Mountain Campsite" (camp_site) 46.7137, -92.2222. https://overpass-api.de/api/interpreter?data=[out:json][timeout:25];(node(around:3500,46.71,-92.21)[name][~"^(natural|tourism|amenity|aerialway|leisure|place|man_made)$"~"."];way(around:2500,46.71,-92.21)[name][~"^(leisure|tourism|aerialway)$"~"."];);out center tags 120; [sub-claim 4: map coordinates for each name]
- OSM names "Bardon Peak" (peak) 46.6897, -92.2357 and "Bardon Peak Overlook" (viewpoint) 46.6876, -92.2319. The city page spells it "Bardon's Peak" and says it is named for James Bardon of Superior, Wisconsin. https://overpass-api.de/api/interpreter?data=[out:json][timeout:25];(node(around:3500,46.71,-92.21)[name][~"^(natural|tourism|amenity|aerialway|leisure|place|man_made)$"~"."];way(around:2500,46.71,-92.21)[name][~"^(leisure|tourism|aerialway)$"~"."];);out center tags 120; [sub-claim 3: neighbouring peaks and overlooks]
- City Skyline Parkway page confirms "Bardon's Peak" as a named stop on the parkway (no coordinates). https://duluthmn.gov/parks/parks-trails/parks-listing/skyline-parkway/highlights/ [sub-claim 3: neighbouring peaks and overlooks]
- OSM name "Elys Peak" (peak), gnis:feature_id 661210, 46.6792029, -92.2525987. https://overpass-api.de/api/interpreter?data=[out:json][timeout:20];node[natural=peak][name~"Ely"](46.6,-92.4,46.8,-92.1);out; [sub-claim 3: neighbouring peaks and overlooks]
- OSM also names "Norton Park" 46.7216, -92.1955 (neighbourhood label near Kingsbury Creek side), "Riverside Park" 46.7114, -92.2044, "Lake Superior Zoo" 46.7256, -92.1913, "Indian Point Campground" 46.7215, -92.1843. These are neighbours, not Spirit Mountain features. https://overpass-api.de/api/interpreter?data=[out:json][timeout:25];(node(around:3500,46.71,-92.21)[name][~"^(natural|tourism|amenity|aerialway|leisure|place|man_made)$"~"."];way(around:2500,46.71,-92.21)[name][~"^(leisure|tourism|aerialway)$"~"."];);out center tags 120; [sub-claim 4: map coordinates for each name]

## Gaps

- unverified: "Spirit Park" and "Lone Oak Rope Park" as terrain park names. No fetched page used them; OSM only has "Lone Oak Rope Tow" (see findings). [sub-claim 1: named facilities and areas on spiritmt.com]
- unverified: whether "Skyline Chalet" (spiritmt.com) is the same building as OSM "Spirit Mountain Upper Chalet". Likely, not confirmed.
- unverified: a named summit or sub-peak of Spirit Mountain itself. Only OSM "Summit Chair" was found; no GNIS peak for it was fetched.
- unverified: a coordinate for Timber Twister, Timber Flyer, the Skills Area, Happy Hub, the Upper Nordic Building, Lot D and the Superior Hiking Trail trailhead. Only relative descriptions exist (Adventure Park OSM point is the nearest anchor).
- unverified: Magney-Snively Natural Area point, Knowlton Creek and Kingsbury Creek points, the Superior Hiking Trail Association Duluth page, COGGS/Duluth Traverse pages, Trailforks/RidePal. None fetched.
- unverified: https://spiritmt.com/winter/nordic-skiing/ returned HTTP 404; the Nordic data came from https://spiritmt.com/winter/nordic/ (reported as final URL of a ?p=33 fetch).
- unverified: broad Overpass query for named features (Knowlton, Kingsbury, Snively, etc.) timed out: https://overpass-api.de/api/interpreter?data=[out:json][timeout:25];(nwr(around:9000,46.70,-92.22)[name~"Ely|Bardon|Snively|Magney|Knowlton|Kingsbury|Skyline|Nordic|Spirit|Summit|Lookout|Overlook|Happy|Norton|Superior Hiking"][natural];node(around:9000,46.70,-92.22)[name][tourism=viewpoint];nwr(around:5000,46.71,-92.21)[name~"Nordic|Bike Park|Skills|Happy Hub|Timber|Spirit Mountain|Rope Park|Spirit Park|Chalet|Traverse"];);out center tags 80;
- unverified: peak/viewpoint Overpass query returned HTTP 504: https://overpass-api.de/api/interpreter?data=[out:json][timeout:20];(node(around:9000,46.70,-92.22)[natural=peak][name];node(around:9000,46.70,-92.22)[tourism=viewpoint][name];);out tags 40;
- Ely's Peak spelling: OSM has "Elys Peak"; the Skyline Parkway city page did not mention it.

## Confidence

Medium: names and relative locations come from originating pages, but fetches return model summaries (no verbatim quotes used), OSM coordinates are as relayed, and several asked-for names are unconfirmed.

## Verified vs Unverified

- Findings bullets: 14 (all with one URL). Unverified bullets under Gaps: 8.

## Reproduction

Searches run (4):
- Spirit Mountain Duluth bike park trails jump line skills area Spirit Mountain Bike Park trail map
- Magney-Snively Natural Area Bardon's Peak Ely's Peak Duluth trail Skyline Parkway
- Ely's Peak Duluth coordinates GNIS Bardon Peak latitude longitude
- Spirit Mountain Nordic Grand Avenue Nordic Center Duluth trails spiritmt.com

Fetches (12), in order:
- ok: https://www.spiritmt.com/
- ok: https://duluthmn.gov/parks/parks-trails/current-projects/spirit-mountain-off-road-cycling-trails/
- ok: https://spiritmt.com/summer/mountain-biking/trails/
- ok: https://spiritmt.com/summer/adventure-park/
- ok: https://duluthmn.gov/parks/parks-trails/parks-listing/skyline-parkway/highlights/
- ok: https://overpass-api.de/api/interpreter?data=[out:json][timeout:25];(node(around:3500,46.71,-92.21)[name][~"^(natural|tourism|amenity|aerialway|leisure|place|man_made)$"~"."];way(around:2500,46.71,-92.21)[name][~"^(leisure|tourism|aerialway)$"~"."];);out center tags 120;
- failed (404): https://spiritmt.com/winter/nordic-skiing/
- failed (timeout): the broad Overpass query named in Gaps
- ok: https://spiritmt.com/?p=33 (final URL reported https://spiritmt.com/winter/nordic/; cited as that URL, not itself fetched directly)
- failed (504): the peak/viewpoint Overpass query named in Gaps
- ok: https://duluthmn.gov/parks/parks-trails/current-projects/spirit-mountain-nordic-center/
- ok: https://overpass-api.de/api/interpreter?data=[out:json][timeout:20];node[natural=peak][name~"Ely"](46.6,-92.4,46.8,-92.1);out;

Note: the findings cite https://spiritmt.com/winter/nordic/ via the ?p=33 redirect report; treat as lightly verified.

## How the seed uses this report

The report above is verbatim research. The seed that turns it into labels is scripts/ingest/places.seed.json, read by npm run ingest:places, which writes data/places.json. Issue: https://github.com/LampaGJ/spiritmountain/issues/61

- Places with OSM coordinates are `verified: true` with lat and lon. Exception: the report's lift points are line midpoints (checked against data/areas.geojson), not top stations, so each lift is a `lift-top` anchored to the last vertex of its lift way, which runs uphill (checked against the 3DEP terrain). Summit Chair top is the summit position.
- Nordic Center at Grand takes the Grand Avenue Chalet position. "Spirit Park" and "Lone Oak Rope Park" are named ways in the pinned OSM areas, so they are anchored to the centroid of that way (https://www.openstreetmap.org/way/1016885258 and https://www.openstreetmap.org/way/1016885259), which settles those two Gaps for position, not for a web source.
- Skills Area, Happy Hub, the Upper Nordic Trails and the Timber Twister and Timber Flyer have only relative descriptions. They stay in the seed as `verified: false`, with no position, and never label a sign. A Skills Area 150 m west of the chalet was rejected as an invented offset.
- Left out on purpose: Riverside Park, Lake Superior Zoo and Indian Point Campground (the report calls them neighbours, not Spirit Mountain features), and the Nordic Connector trail (it is a trail, already named on its own sign).
- Norton Park uses the OSM neighbourhood label point. It is an approximation of the east-side bike trails the City page describes.

