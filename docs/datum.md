---
type: reference
status: draft
review_by: 2027-04-01
related: [scripts/ingest/local-frame.ts, scripts/measure/imagery-alignment.ts, tests/ingest/local-frame.test.ts]
---
# Datum: OSM WGS84 to NAD83(2011)

TL;DR: OSM coordinates are WGS84, which here means ITRF2014 to within centimetres. The 3DEP terrain and the NAIP photos are NAD83(2011), UTM zone 15N. The ingests used to project OSM with the NAD83 UTM definition and no datum shift, which misplaces every OSM feature by about 1.2 m at Duluth. They now apply the EPSG:8970 Helmert transformation, ITRF2014 to NAD83(2011), at epoch 2010.0, before the UTM projection. At the frame centre this moves OSM features (+0.84, -0.90) m (east, north). The frame origin does not move.

Issue: https://github.com/LampaGJ/spiritmountain/issues/77. Measurement that motivated it: https://github.com/LampaGJ/spiritmountain/issues/75

## Which inputs are in which datum

- OSM (areas, buildings, the places seed, which was read off OSM): WGS84. Current WGS84 realisations, G1762 and G2139, agree with ITRF2014 and ITRF2020 to a few centimetres, so WGS84 is treated as ITRF2014.
- USGS 3DEP and USDA NAIP, as the project requests them: EPSG:26915, NAD83 / UTM zone 15N. The current NAD83 realisation is NAD83(2011), epoch 2010.0.
- NAD83(2011) is fixed to the North American plate. ITRF is not, so the difference between the two grows by about 2 cm a year at Duluth.

## What the code does

- `itrf2014ToNad83` (`scripts/ingest/local-frame.ts:99`) converts lon/lat to geocentric X, Y, Z on GRS80 with proj4, applies the 7-parameter time-dependent Helmert, and converts back. Ellipsoidal height is 0; a height of a few hundred metres changes the horizontal result by well under a millimetre.
- proj4js has no time-dependent Helmert, so the 15 parameters are applied in code. They live in `ITRF2014_TO_NAD83_2011` (`scripts/ingest/local-frame.ts:62`).
- `osmToLocal` (`scripts/ingest/local-frame.ts:135`) is the OSM entry point. The areas transform (`scripts/ingest/areas.ts:57`, `scripts/ingest/areas.ts:161`), the buildings transform (`scripts/ingest/buildings.ts:71`) and the places transform (`scripts/ingest/places-core.ts:122`, `scripts/ingest/places-core.ts:134`) call it.
- `toLocal` (`scripts/ingest/local-frame.ts:43`) stays the frame projection with no shift. Use it for NAD83 inputs, such as the LiDAR summit point in `tests/ingest/terrain-real.test.ts`, and for the frame constants.

## Parameters

- Source: EPSG:8970, "ITRF2014 to NAD83(2011) (1)", https://epsg.io/8970
- Method: Time-dependent Coordinate Frame rotation (geocentric), EPSG method 1056. The rotation sign follows the coordinate frame convention, not the position vector convention.
- Reference epoch: 2010.0.
- Translations: tx 1.00530 m, ty -1.90921 m, tz -0.54157 m.
- Rotations: rx 26.78138 mas, ry -0.42027 mas, rz 10.93206 mas (mas: milliarcseconds).
- Scale: 0.36891 ppb.
- Rates per year: tx 0.00079 m, ty -0.00060 m, tz -0.00144 m; rx 0.06667 mas, ry -0.75744 mas, rz -0.05133 mas; scale -0.07201 ppb.
- Lineage: the EPSG remarks describe it as the joint US-Canada NAD83(CORS96) to ITRF96 transformation (EPSG:6864), chained with the IGS ITRF96 to ITRF97 values and the IERS ITRF97 to ITRF2014 values. NGS HTDP is the NGS tool for this transformation, https://geodesy.noaa.gov/TOOLS/Htdp/Htdp.shtml , and its method is described in Pearson and Snay 2013, https://doi.org/10.1007/s10291-012-0255-y ; HTDP's own parameter table was not fetched for this note. The IERS ITRF2014 parameters are at https://itrf.ign.fr/docs/solutions/itrf2014/Transfo-ITRF2014_ITRFs.txt

## Epoch choice

- `OSM_EPOCH` is 2010.0 (`scripts/ingest/local-frame.ts:86`), the NAD83(2011) reference epoch, so the rate terms are zero.
- An OSM trace has no single epoch. Edits come from GPS tracks and imagery of many years, and the imagery OSM editors trace is itself often NAD83-referenced.
- Sensitivity: at epoch 2026.77 the shift at the frame centre is (+1.156, -0.867) m instead of (+0.841, -0.897) m. That is 0.32 m more east. The choice of epoch is therefore worth about 0.3 m, less than the OSM tracing noise of 2 to 4 m per feature.

## Expected shift at Duluth, and the independent check

- This code, at the frame centre (lon -92.215, lat 46.71), epoch 2010.0: NAD83(2011) lon -92.214989115, lat 46.709991857, which is (+0.841, -0.897) m in UTM 15N, 1.23 m in total.
- Independent value: PROJ 9.9.0 (Homebrew) with its EPSG database, run on 2026-10-08:
  - `echo '46.71 -92.215 0 2010.0' | cs2cs -d 6 EPSG:9000 EPSG:6344` printed `560002.953299 5173236.587037 0.892424 2010.0`
  - `echo '46.71 -92.215 0 2010.0' | cs2cs -d 9 EPSG:9000 EPSG:6318` printed `46.709991857 -92.214989115 0.892424276 2010.0`
  - `echo '46.71 -92.215 0 2026.77' | cs2cs -d 6 EPSG:9000 EPSG:6344` printed `560003.268135 5173236.616329 0.873868 2026.77`
  - `projinfo -s EPSG:7789 -t EPSG:6318 --spatial-test intersects` listed exactly one candidate, "ITRF2014 to NAD83(2011) (1)", with the parameters above.
- Against the unshifted frame origin (560002.112256, 5173237.483559), PROJ's shift is (+0.841, -0.897) m. The tests in `tests/ingest/local-frame.test.ts` hold this code to PROJ within 0.05 m at both epochs, and to 1e-7 degrees in geographic coordinates.
- NGS NCAT was tried as a second check and does not accept an ITRF input datum. https://geodesy.noaa.gov/api/ncat/llh?lat=46.71&lon=-92.215&eht=0&inDatum=itrf2014&outDatum=nad83(2011) returned `{"error": "Invalid inputDatum"}`, and so did `ITRF2014`, `itrf2008`, `wgs84(g1762)` and `WGS84(G2139)`. HTDP itself is a downloadable program and form at the URL above. Neither was run here.

## The frame origin stays

- `ORIGIN` (`scripts/ingest/local-frame.ts:30`) is the unshifted UTM projection of the bbox centre constants `LON0`, `LAT0`. Those constants are just numbers that define a study area. They are not a surveyed point.
- Local metres are absolute UTM minus `ORIGIN`. Any constant works as long as every layer subtracts the same one. The terrain, imagery, context tiles and surface already use this `ORIGIN`, so it stays, and `data/frame.json` is unchanged.
- `gridEnvelope` and the 3DEP and NAIP requests also stay. They are defined in the NAD83 frame, and the pinned rasters match them.

## What it should do to the #75 measurement

- The #75 inset mean, photo minus OSM, was (-1.11, -0.97) m with standard errors (0.84, 0.58) m.
- Moving OSM by (+0.84, -0.90) m predicts about (-1.95, -0.07) m. The north component closes. The east component grows, because the shift is east-going.
- The east mean before the shift was 1.3 standard errors from zero, so it was not significant evidence of a datum error. The datum shift is applied because it is the correct conversion, not because it is fitted to these features.
- Re-run with `npx tsx scripts/measure/imagery-alignment.ts --compare <before.json>` after the regenerated data lands, and record the measured before and after on the issue.
