---
type: spec
status: active
title: Spirit Mountain GIS three.js scene with file-first annotations
goal: Render the Spirit Mountain Recreation Area from real, pinned GIS data in a three.js scene where every run, trail, lift and zone carries a schema-validated annotation of activities, seasons and stakeholder organizations.
items:
  - id: project-scaffold
    title: Scaffold the TypeScript, Vite and three.js project
    tier: architecture
    needs: []
  - id: gis-ingest-pipeline
    title: Pinned, replayable fetch of OpenStreetMap and USGS 3DEP inputs
    tier: architecture
    needs: [project-scaffold]
  - id: area-schema
    title: Zod v4 schemas for Area and Annotation
    tier: architecture
    needs: [project-scaffold]
  - id: osm-to-areas-transform
    title: Deterministic transform from raw OSM to local-metre areas GeoJSON
    tier: feature
    needs: [gis-ingest-pipeline, area-schema]
  - id: terrain-transform
    title: Deterministic transform from 3DEP GeoTIFF to a heightfield artifact
    tier: feature
    needs: [gis-ingest-pipeline]
  - id: terrain-mesh
    title: three.js terrain mesh from the heightfield
    tier: feature
    needs: [terrain-transform]
  - id: draped-area-lines
    title: Areas rendered as lines draped on the terrain, colored by kind
    tier: feature
    needs: [terrain-mesh, osm-to-areas-transform]
  - id: seed-annotations
    title: Generated seed annotations file keyed by stable area id
    tier: feature
    needs: [area-schema, osm-to-areas-transform]
  - id: annotation-panel
    title: Hover and click picking with a side panel showing the annotation
    tier: feature
    needs: [draped-area-lines, seed-annotations]
  - id: layer-filters
    title: Filter the scene by activity and season
    tier: polish
    needs: [annotation-panel]
  - id: contract-seams-manifest
    title: Seam manifest and artifact registry for the data flow
    tier: polish
    needs: [seed-annotations, terrain-transform, draped-area-lines]
constraints:
  - Every fetched input is pinned under data/raw/ with a sha256 and committed; every transform is deterministic and carries a replay record of inputHash, codeCommit and outputHash (user CLAUDE.md, data doctrine item 4).
  - Hand-edited data is illegal. Seed annotations are produced by a committed transform, and later human edits to data/annotations.json are treated as a primary-source input parsed at the boundary, not as a manipulation.
  - Foreign data (Overpass JSON, GeoTIFF bytes, annotations.json, areas.geojson) is parsed with Zod at the boundary where it enters, never validated at the sink. An empty result from a fetch or parse is an error, never an empty array.
  - Every new or changed Zod schema is reviewed by agent-zod-zealot before merge.
  - Determinism hazards (Date.now, Math.random, locale-sensitive sort) are banned inside transforms; sort keys are explicit and byte-stable.
  - Any script expected to run over 30 seconds emits heartbeat progress via /Users/graham/.claude/lib/progress.mjs to reports/.progress/.
  - Facts about the world (seasons, org roles, trail difficulty not present in OSM) are never invented; they are left as explicit blank fields.
  - Stack is TypeScript 5.9+, Vite, three.js, Zod v4, Vitest, tsx, ESLint 9, Prettier 3. GIS adapters are thin wrappers over geotiff.js, osmtogeojson and proj4js.
tracker: github
---

# Spirit Mountain GIS three.js scene with file-first annotations

This is a feasibility spike. It proves that public GIS data for the Spirit
Mountain Recreation Area (Duluth, Minnesota) can be rendered in three.js and
annotated through a schema, with a committed data file as the source of
truth. An in-scene editor is a later wave, see Non-goals.

Verified inputs as of 2026-10-06:

- OpenStreetMap via Overpass, bounding box 46.68,-92.26,46.74,-92.17, returns
  21 downhill piste ways, 40 nordic piste ways, 2 snow park ways, 15 mtb:scale
  ways, 1 mtb route relation, 4 chair lifts, 2 drag lifts, 1 rope tow, 1 magic
  carpet, 2 stations and 23 pylons. Endpoint https://overpass-api.de/api/interpreter
  requires a User-Agent header and returns 406 without one.
- USGS 3DEP via https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage
  returns a float32 GeoTIFF for the same bbox with no auth (HTTP 200,
  image/tiff).
- Not found: a published recreation-area boundary polygon or building
  footprints. The Duluth ArcGIS hub returned nothing to two API probes.

## project-scaffold — Scaffold the TypeScript, Vite and three.js project

**Goal**: Create the repo skeleton so every later item lands in a known
layout with a working dev server, test runner and lint. This is the one
place dependencies are chosen; later items add none without stating why.

**Acceptance**:
- `npm run dev` serves an index page that mounts an empty three.js canvas.
- `npm test` runs Vitest and passes a placeholder test.
- `npm run lint` and `npm run typecheck` pass on the empty project.
- `package.json` pins three, zod (v4), geotiff, osmtogeojson, proj4, vite,
  vitest, tsx, typescript, eslint, prettier, @types/three, @types/proj4.
- Layout exists: `src/scene/`, `src/schema/`, `src/data/`, `scripts/ingest/`,
  `data/raw/`, `data/`, `reports/.progress/`, `tests/`.

**Touches**: `package.json`, `tsconfig.json`, `vite.config.ts`,
`eslint.config.js`, `index.html`, `src/main.ts`

**Open gaps**: none

## gis-ingest-pipeline — Pinned, replayable fetch of OpenStreetMap and USGS 3DEP inputs

**Goal**: Fetch the two raw inputs once, pin them to disk with a sha256 and a
provenance record, and never fetch inline again. Every downstream transform
reads the pinned bytes, so the whole pipeline replays offline.

**Acceptance**:
- `npm run ingest:fetch` writes `data/raw/overpass.json` and
  `data/raw/3dep.tif` plus `data/raw/manifest.json` recording url, request
  body, fetched-at, byte length and sha256 for each.
- The Overpass request sends a User-Agent header and the exact query is
  stored in `scripts/ingest/overpass.ql`, committed.
- An HTTP status other than 200, a non-JSON Overpass body, or an Overpass
  response with zero elements exits non-zero with a named error. No empty
  file is written.
- The 3DEP request asks for pixelType F32, imageSR 3857, and a size that
  yields roughly 2 m per pixel over the bbox. The response is checked for
  content-type image/tiff before writing.
- The script emits progress heartbeats to `reports/.progress/ingest-fetch.json`.
- The raw files and manifest are committed.

**Touches**: `scripts/ingest/fetch.ts`, `scripts/ingest/overpass.ql`,
`scripts/ingest/manifest-schema.ts`, `data/raw/`

**Open gaps**: raw GeoTIFF size at 2 m per pixel is estimated under 5 MB; if
it exceeds 20 MB, coarsen to 3 m rather than add git-lfs.

## area-schema — Zod v4 schemas for Area and Annotation

**Goal**: Define the one canonical shape for a recreational area and for its
annotation, so the transform, the seed generator, the scene and any later
editor all parse the same contract. Types are inferred from the schemas,
never declared twice.

**Acceptance**:
- `src/schema/area.ts` exports `AreaSchema` with: `id` (string, the OSM
  type and id, for example `way/123`), `kind` (enum: downhill-run,
  nordic-trail, mtb-trail, lift, snow-park, mtb-route), `name` (string or
  null), `difficulty` (string or null, taken verbatim from OSM
  piste:difficulty or mtb:scale), `geometry` (LineString or Polygon in
  local metres with elevation as z), `osmTags` (record of string to string).
- `src/schema/annotation.ts` exports `AnnotationSchema` with: `areaId`,
  `activities` (list of `{ activity, seasons, notes }`, where activity is an
  enum covering alpine-ski, snowboard, nordic-classic, nordic-skate,
  snowshoe, fat-bike, mountain-bike, hike, trail-run, tubing, lift-ride,
  and seasons is a list of enum winter, spring, summer, fall), `stakeholders`
  (list of `{ orgId, role }` with role enum maintains, operates, programs,
  funds, advocates), `notes` (string, may be empty).
- `src/schema/organization.ts` exports `OrganizationSchema` with `id`,
  `name`, `url` (string or null), `type` (enum nonprofit, authority,
  municipal, club, business).
- `src/schema/annotations-file.ts` wraps the three into one file schema with
  a `version` field and a `generatedFrom` replay record.
- Every schema and every exported artifact producer carries TSDoc
  `@displayName`, `@strategicPurpose`, `@tacticalObjective`.
- Fixture tests prove each schema parses a valid sample and rejects a sample
  with one renamed field.
- agent-zod-zealot has reviewed the files and its lint passes.

**Touches**: `src/schema/area.ts`, `src/schema/annotation.ts`,
`src/schema/organization.ts`, `src/schema/annotations-file.ts`,
`tests/schema/`

**Open gaps**: the activity enum is seeded from the principal's list and
extended from OSM tags found; it is expected to grow.

## osm-to-areas-transform — Deterministic transform from raw OSM to local-metre areas GeoJSON

**Goal**: Turn the pinned Overpass JSON into `data/areas.geojson`, one
feature per recreational area, reprojected into a local east-north frame in
metres centred on the bbox, so the scene needs no projection math. Pylons
and stations are dropped; lifts keep their line geometry.

**Acceptance**:
- `npm run ingest:areas` reads only `data/raw/overpass.json`, parses it with
  a Zod schema for the Overpass envelope, runs osmtogeojson, reprojects
  with proj4 from EPSG:4326 to a local transverse Mercator (or EPSG:3857
  minus a fixed origin, recorded in the output), and writes
  `data/areas.geojson` plus `data/areas.replay.json` with inputHash,
  codeCommit, outputHash and declared effect `reduces`.
- Running the transform twice yields byte-identical output (test asserts
  equal sha256).
- Feature order is sorted by id; property keys are emitted in a fixed order.
- Every feature validates against `AreaSchema` with z set to 0 at this
  stage (elevation is draped in the scene, not baked here).
- Counts in the output match the verified counts above within the mapping
  rules, and a test asserts the total is above zero and above a floor of 80.
- A feature whose tags map to no `kind` is reported in a `dropped` list in
  the replay record, never silently discarded.

**Touches**: `scripts/ingest/areas.ts`, `scripts/ingest/overpass-schema.ts`,
`scripts/ingest/kind-mapping.ts`, `data/areas.geojson`,
`data/areas.replay.json`, `tests/ingest/areas.test.ts`

**Open gaps**: whether the mtb route relation (Duluth Traverse) is kept as
one feature or exploded into member ways; default is one feature per member
way with the relation name copied into tags.

## terrain-transform — Deterministic transform from 3DEP GeoTIFF to a heightfield artifact

**Goal**: Decode the pinned GeoTIFF once into a compact binary heightfield
plus a JSON header, so the browser loads a few hundred kilobytes of Float32
rather than parsing TIFF at runtime.

**Acceptance**:
- `npm run ingest:terrain` reads only `data/raw/3dep.tif`, decodes it with
  geotiff.js, and writes `data/terrain.f32` (row-major Float32 heights) and
  `data/terrain.json` (width, height, origin in the same local frame as
  areas, cell size in metres, min and max elevation, nodata handling) plus a
  replay record with declared effect `preserves`.
- Nodata pixels are replaced by the nearest valid neighbour and the count of
  replaced pixels is recorded in the header.
- Byte-identical across two runs (test).
- A test asserts the height at the known summit location is within 5 m of
  the published Spirit Mountain summit elevation recorded in the test.

**Touches**: `scripts/ingest/terrain.ts`, `data/terrain.f32`,
`data/terrain.json`, `tests/ingest/terrain.test.ts`

**Open gaps**: the published summit elevation value must be sourced and
cited in the test rather than assumed.

## terrain-mesh — three.js terrain mesh from the heightfield

**Goal**: Render the heightfield as a displaced plane with lighting and an
orbit camera, establishing the scene, camera and coordinate conventions
that every later item draws into.

**Acceptance**:
- `src/scene/terrain.ts` builds a PlaneGeometry sized from
  `data/terrain.json`, displaces vertices from `data/terrain.f32`, computes
  normals, and applies a slope-shaded MeshStandardMaterial.
- `src/scene/scene.ts` owns renderer, camera, OrbitControls, lights and a
  resize handler; the local metre frame maps to three.js x east, y up, z
  south.
- `src/data/load-terrain.ts` fetches the two artifacts and parses the header
  with Zod before use.
- The page renders the mountain recognisably with the chair lift corridors
  visible as terrain shape at the default camera.
- Vertical exaggeration is a single exported constant defaulting to 1.

**Touches**: `src/scene/scene.ts`, `src/scene/terrain.ts`,
`src/data/load-terrain.ts`, `src/main.ts`

**Open gaps**: none

## draped-area-lines — Areas rendered as lines draped on the terrain, colored by kind

**Goal**: Draw every area from `data/areas.geojson` as a line that follows
the ground, colored by kind, so the user can see runs, nordic trails, mtb
trails and lifts in one scene.

**Acceptance**:
- `src/data/load-areas.ts` fetches `data/areas.geojson` and parses it with
  `AreaSchema` at the boundary; a parse failure throws with the feature id.
- `src/scene/drape.ts` samples the heightfield bilinearly at each vertex and
  densifies segments longer than 10 m so lines do not cut through ridges.
- `src/scene/areas.ts` builds one Line2 or LineSegments per kind with a
  fixed palette in `src/scene/palette.ts`; lifts render straight (not
  draped) between their endpoints at cable height offset.
- Every feature carries a `userData.areaId` for picking.
- A unit test on `drape.ts` asserts a sampled point on a flat synthetic
  heightfield returns the plane height and a point on a ramp interpolates.

**Touches**: `src/data/load-areas.ts`, `src/scene/drape.ts`,
`src/scene/areas.ts`, `src/scene/palette.ts`, `tests/scene/drape.test.ts`

**Open gaps**: none

## seed-annotations — Generated seed annotations file keyed by stable area id

**Goal**: Produce `data/annotations.json` by a committed transform so the
file exists for every area from day one, with activities derived from kind
and all world facts left blank, and with the known stakeholder organizations
present as stubs.

**Acceptance**:
- `npm run ingest:annotations` reads `data/areas.geojson` and
  `scripts/ingest/organizations.seed.json`, and writes
  `data/annotations.json` validating against the annotations-file schema,
  plus a replay record with declared effect `expands`.
- Kind-to-activity defaults: downhill-run and snow-park get alpine-ski and
  snowboard with seasons [winter]; nordic-trail gets nordic-classic and
  nordic-skate with seasons [winter]; mtb-trail and mtb-route get
  mountain-bike with seasons [summer, fall]; lift gets lift-ride with
  seasons []. Every derived entry carries `notes: "derived from OSM kind"`.
- `stakeholders` is an empty list for every area. No role is assigned.
- Organizations seeded: Spirit Mountain Recreation Area Authority
  (authority), COGGS (nonprofit, https://coggs.com), Duluth Cross Country
  Ski Club (club), Grand Avenue Nordic Center (business), City of Duluth
  Parks and Recreation (municipal). Each has only id, name, url, type.
- If `data/annotations.json` already exists, the transform refuses to
  overwrite unless passed `--force`, so later human edits are not clobbered.
- Byte-identical across two runs (test).

**Touches**: `scripts/ingest/annotations.ts`,
`scripts/ingest/organizations.seed.json`, `data/annotations.json`,
`tests/ingest/annotations.test.ts`

**Open gaps**: additional stakeholder orgs (Duluth Nordic, adaptive sports
programs, alpine race club) are unverified and are not seeded.

## annotation-panel — Hover and click picking with a side panel showing the annotation

**Goal**: Let the user hover and click any drawn area to read its
annotation, which is the whole point of the scene for a stakeholder review.

**Acceptance**:
- Raycasting against the area lines highlights the hovered area and shows
  its name in a tooltip.
- Clicking opens a side panel (plain HTML and CSS, no UI framework) showing
  name, kind, difficulty, each activity with its seasons, each stakeholder
  with org name and role, and notes.
- Areas with no annotation entry show the panel with an explicit "no
  annotation" state rather than an empty panel.
- The panel is driven by the parsed annotations file loaded through
  `src/data/load-annotations.ts` with a Zod boundary parse.
- Keyboard: Escape closes the panel.

**Touches**: `src/scene/pick.ts`, `src/ui/panel.ts`, `src/ui/panel.css`,
`src/data/load-annotations.ts`, `index.html`

**Open gaps**: none

## layer-filters — Filter the scene by activity and season

**Goal**: Give a stakeholder a way to view only the winter nordic network, or
only summer mtb, which is the seasonal cross-section the principal asked
for.

**Acceptance**:
- A control strip lists every activity and every season as toggles.
- Toggling hides and shows area lines whose annotation activities do not
  match; terrain and lifts remain visible.
- The selected filter state is reflected in the URL hash so a view can be
  shared.
- A test on the filter predicate covers an area with two activities in
  different seasons.

**Touches**: `src/ui/filters.ts`, `src/scene/areas.ts`,
`tests/ui/filters.test.ts`

**Open gaps**: none

## contract-seams-manifest — Seam manifest and artifact registry for the data flow

**Goal**: Record every seam this spike created, which side gates it, and
roll the TSDoc annotations into one agent-readable manifest, so the second
wave starts from a measured map instead of memory.

**Acceptance**:
- agent-data-contract-cartographer produces `docs/contract-seams.json` and
  `docs/contract-seams.html` listing at least: Overpass response, 3DEP
  response, areas.geojson, terrain artifacts, annotations.json, and each
  transform as a manipulation node with its replay record.
- agent-schema-registry-architect compiles the TSDoc tags into one manifest
  and a CI script fails when the manifest is stale.
- Each seam records emitter_gate and consumer_gate; any one-sided seam
  carries a one-line decision for why.

**Touches**: `docs/contract-seams.json`, `docs/contract-seams.html`,
`scripts/registry/`, `package.json`

**Open gaps**: none

## Non-goals

- No in-browser annotation editor or write path in this spec. Annotations
  are edited in `data/annotations.json` outside the app. The editor is a
  second spec once the scene proves out, and it will treat the file as the
  source of truth.
- No recreation-area boundary polygon, building footprints or parcel data;
  none was found in a public machine-readable source. These remain flagged
  gaps.
- No basemap imagery or satellite texture on the terrain.
- No authentication, hosting or deployment.
- No invention of seasons, stakeholder roles, hours or trail status. Blank
  fields stay blank until a human fills them.
- No React or other UI framework; the panel and filters are plain HTML and
  CSS.
