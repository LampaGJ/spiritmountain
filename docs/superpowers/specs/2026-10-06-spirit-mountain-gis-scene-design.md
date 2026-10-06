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
    needs: [terrain-transform, gis-ingest-pipeline]
  - id: draped-area-lines
    title: Areas rendered as lines draped on the terrain, colored by kind
    tier: feature
    needs: [terrain-mesh, osm-to-areas-transform, area-schema]
  - id: seed-annotations
    title: Generated seed annotations file keyed by stable area id
    tier: feature
    needs: [area-schema, osm-to-areas-transform]
  - id: annotation-panel
    title: Hover and click picking with a side panel showing the annotation
    tier: feature
    needs: [draped-area-lines, area-schema]
  - id: layer-filters
    title: Filter the scene by activity and season
    tier: polish
    needs: [annotation-panel]
  - id: contract-seams-manifest
    title: Seam manifest and artifact registry for the data flow
    tier: polish
    needs: [seed-annotations, terrain-transform, draped-area-lines]
constraints:
  - Every fetched input is pinned under data/raw/ with a sha256 and committed; every transform is deterministic and carries a replay record of inputHash, codeCommit and outputHash (user CLAUDE.md, data doctrine item 4). The outputHash lives in the replay sidecar, not in the annotations file's generatedFrom (D-05).
  - Hand-edited data is illegal. Seed annotations are produced by a committed transform, and later human edits to data/annotations.json are treated as a primary-source input parsed at the boundary, not as a manipulation.
  - Foreign data (Overpass JSON, annotations.json, areas.geojson, manifest.json, frame.json) is parsed with Zod at the boundary where it enters, never validated at the sink. GeoTIFF bytes are checked by named assertions and the manifest cross-check, and the headers derived from them are Zod-parsed (D-11). An empty result from a fetch or parse is an error, never an empty array.
  - Every new or changed Zod schema is reviewed by agent-zod-zealot before merge.
  - Determinism hazards (Date.now, Math.random, locale-sensitive sort) are banned inside transforms; sort keys are explicit and byte-stable.
  - Replay sidecars record package versions and a lockSubtreeSha256, never node or v8 versions; Node is pinned through .nvmrc and package.json engines (D-14).
  - Any script expected to run over 30 seconds emits heartbeat progress via /Users/graham/.claude/lib/progress.mjs to reports/.progress/.
  - Facts about the world (seasons, org roles, trail difficulty not present in OSM) are never invented; they are left as explicit blank fields. The one exception is the lift cable display offsets, which are labelled display-only and not surveyed (D-16).
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

Decisions made while the implementation issues were reviewed are recorded in
the Deviations log before Non-goals. Where an item below states behaviour that
differs from the first draft of this spec, the Deviations log names the issue
that decided it.

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
- A repo-wide `.gitattributes` exists before the first binary pin is
  committed (D-13). It sets `* text=auto eol=lf`, marks `data/**`,
  `tests/fixtures/**`, `scripts/ingest/organizations.seed.json` and
  `scripts/ingest/overpass.ql` as `-text`, marks `*.tif` and `*.f32` as
  `binary`, and sets `*.sh text eol=lf`.
- `git check-attr text -- data/raw/3dep.tif data/terrain.f32
  data/annotations.json tests/fixtures/areas-mini.expected.geojson
  scripts/ingest/organizations.seed.json scripts/ingest/overpass.ql` prints
  `unset` for every path.

**Touches**: `package.json`, `tsconfig.json`, `vite.config.ts`,
`eslint.config.js`, `index.html`, `src/main.ts`, `.gitattributes`

**Open gaps**: none

## gis-ingest-pipeline — Pinned, replayable fetch of OpenStreetMap and USGS 3DEP inputs

**Goal**: Fetch the two raw inputs once, pin them to disk with a sha256 and a
provenance record, and never fetch inline again. Every downstream transform
reads the pinned bytes, so the whole pipeline replays offline.

**Acceptance**:
- `npm run ingest:fetch` writes `data/raw/overpass.json` and
  `data/raw/3dep.tif` plus `data/raw/manifest.json` recording url, request
  body, fetched-at, byte length and sha256 for each. It also writes
  `data/frame.json`, the local-frame definition derived from constants
  already parsed by `FrameSchema` (D-02).
- The Overpass request sends a User-Agent header and the exact query is
  stored in `scripts/ingest/overpass.ql`, committed.
- An HTTP status other than 200, a non-JSON Overpass body, or an Overpass
  response with zero elements exits non-zero with a named error. No empty
  file is written.
- The 3DEP request asks for pixelType F32, imageSR 26915 (NAD83 / UTM zone
  15N), and a size that yields 5 m per pixel over the bbox (D-01). The
  response is checked for content-type image/tiff before writing.
- The script emits progress heartbeats to `reports/.progress/ingest-fetch.json`.
- The raw files, `manifest.json` and `frame.json` are committed by explicit
  path under the repo-wide `.gitattributes` (D-13). After the commit,
  `git ls-files data/raw/overpass.json data/raw/3dep.tif
  data/raw/manifest.json data/frame.json` lists all four and
  `git status --porcelain data` is empty.

**Touches**: `scripts/ingest/fetch.ts`, `scripts/ingest/overpass.ql`,
`scripts/ingest/manifest-schema.ts`, `src/schema/frame.ts`, `data/raw/`,
`data/frame.json`

**Open gaps**: D-17 ratification pending: the retry ladder, the request
scheduler and the `--refetch` archive in `fetch.ts` are hand-written (about 50
lines, over the 20-line glue exception) and no framework search was recorded;
the principal ratifies them or names a replacement.

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
  adaptive, and seasons is a list of enum winter, spring, summer, fall),
  `stakeholders` (list of `{ orgId, role }` with role enum maintains,
  operates, programs, funds, advocates), `notes` (string, may be empty).
- `src/schema/organization.ts` exports `OrganizationSchema` with seven
  fields (D-04): `id`, `name`, `url` (string or null), `type` (enum
  nonprofit, authority, municipal, club, business, state-agency),
  `activities`, `sourceUrl` and `verified` (boolean).
- `src/schema/annotations-file.ts` wraps the three into one file schema with
  a `version` field and a `generatedFrom` record of `{ inputHash,
  codeCommit, effect }`. It omits `outputHash`, which lives in the replay
  sidecar (D-05).
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
and stations are dropped; lifts keep their line geometry. Ways that lie
partly outside the bbox are kept whole, not clipped, because clipping invents
vertices and changes the partition counts (D-15).

**Acceptance**:
- `npm run ingest:areas` reads `data/raw/overpass.json`, plus
  `data/raw/manifest.json` and `data/frame.json` as consumer-gate inputs
  parsed with their schemas (D-02). It parses the Overpass JSON with a Zod
  schema for the Overpass envelope, runs osmtogeojson, reprojects with
  proj4 from EPSG:4326 to the local frame defined in `data/frame.json`, and
  writes `data/areas.geojson` plus `data/areas.replay.json` with inputHash,
  codeCommit, outputHash, declared effect `reduces`, package versions and
  `lockSubtreeSha256`, and no node or v8 version (D-14).
- Running the transform twice yields byte-identical output (test asserts
  equal sha256).
- Feature order is sorted by id; property keys are emitted in a fixed order.
- Every feature validates against `AreaSchema` with z set to 0 at this
  stage (elevation is draped in the scene, not baked here).
- Counts in the output match the verified counts above within the mapping
  rules, and a test asserts the total is above zero and above a floor of 80.
- A feature whose tags map to no `kind` is reported in a `dropped` list in
  the replay record, never silently discarded.
- Ways partly outside the bbox appear whole in the output (D-15).

**Touches**: `scripts/ingest/areas.ts`, `scripts/ingest/overpass-schema.ts`,
`scripts/ingest/kind-mapping.ts`, `data/areas.geojson`,
`data/areas.replay.json`, `tests/ingest/areas.test.ts`

**Open gaps**: none. The mtb route relation (Duluth Traverse) and the Nordic
Connector relation are exploded into member ways, one feature per member way
with the relation name copied into tags.

## terrain-transform — Deterministic transform from 3DEP GeoTIFF to a heightfield artifact

**Goal**: Decode the pinned GeoTIFF once into a compact binary heightfield
plus a JSON header, so the browser loads one Float32 file of about 7.5 MB
(7,494,880 bytes at 5 m per pixel, D-01) rather than parsing TIFF at runtime.

**Acceptance**:
- `npm run ingest:terrain` reads `data/raw/3dep.tif`, plus
  `data/raw/manifest.json` and `data/frame.json` as consumer-gate inputs
  parsed with their schemas (D-02). It decodes the TIFF with geotiff.js, and
  writes `data/terrain.f32` (row-major Float32 heights) and
  `data/terrain.json` (width, height, origin in the same local frame as
  areas, cell size in metres, min and max elevation, nodata handling) plus a
  replay record with declared effect `preserves`, package versions and
  `lockSubtreeSha256`, and no node or v8 version (D-14).
- GeoTIFF bytes are checked by named assertions and the manifest
  cross-check, and `data/terrain.json` is parsed with `TerrainHeaderSchema`
  (D-11).
- Nodata pixels are replaced by the nearest valid neighbour and the count of
  replaced pixels is recorded in the header.
- Byte-identical across two runs (test).
- The summit test takes the maximum heightfield value within a 150 m radius
  of the LiDAR-derived summit (46.717165 N, 92.224042 W, projected through
  the local frame) and asserts it within 10 m of 407.07 m, the maximum of
  the USGS 3DEP 1 m DEM (Minnesota DNR LiDAR, acquired 2021) recorded by
  the committed probe `scripts/probes/summit-max.mjs` in
  `data/probes/summit-max.json`, cross-checked by the USGS point service
  at 406.97 m (D-03).
- The header's `plausibleRangeM` of 150 to 500 is labelled "sanity bound,
  not surveyed" (D-03).

**Touches**: `scripts/ingest/terrain.ts`, `scripts/ingest/terrain-deps.ts`,
`scripts/ingest/terrain-replay-schema.ts`, `data/terrain.f32`,
`data/terrain.json`, `tests/ingest/terrain.test.ts`

**Open gaps**: none. The former D-03 summit-source gap closed on 2026-10-06 with the LiDAR probe; the Wikipedia coordinate reads 371 m on the same raster.

## terrain-mesh — three.js terrain mesh from the heightfield

**Goal**: Render the heightfield as a displaced plane with lighting and an
orbit camera, establishing the scene, camera and coordinate conventions
that every later item draws into.

**Acceptance**:
- `src/scene/terrain.ts` builds a PlaneGeometry sized from
  `data/terrain.json`, displaces vertices from `data/terrain.f32`, computes
  normals, and applies a slope-shaded MeshStandardMaterial.
- `src/scene/heightfield.ts` exposes the parsed heightfield for terrain and
  for drape sampling; `src/scene/views.ts` holds the camera views.
- `src/scene/scene.ts` owns renderer, camera, OrbitControls, lights and a
  resize handler; the local metre frame maps to three.js x east, y up, z
  south.
- `src/data/load-terrain.ts` fetches the three artifacts (`terrain.f32`,
  `terrain.json` and `frame.json`, D-02) and parses the header and the frame
  with Zod before use. The loader converts the header's corner origin to the
  first cell centre.
- The page renders the mountain recognisably with the chair lift corridors
  visible as terrain shape at the default camera.
- Vertical exaggeration is a single exported constant defaulting to 1.
- `npm run build` exits 0, because `?url` imports hide a missing artifact
  from tsc and Vitest.

**Touches**: `src/scene/scene.ts`, `src/scene/terrain.ts`,
`src/scene/heightfield.ts`, `src/scene/views.ts`, `src/schema/frame.ts`,
`src/data/load-terrain.ts`, `src/main.ts`, `vite.config.ts`

**Open gaps**: none

## draped-area-lines — Areas rendered as lines draped on the terrain, colored by kind

**Goal**: Draw every area from `data/areas.geojson` as a line that follows
the ground, colored by kind, so the user can see runs, nordic trails, mtb
trails and lifts in one scene.

**Acceptance**:
- `src/data/load-areas.ts` fetches `data/areas.geojson` and parses it once
  with the strict area feature-collection schema built on `AreaSchema`; a
  parse failure throws one error that names every failing feature id.
- `src/scene/drape.ts` samples the heightfield bilinearly at each vertex and
  densifies segments longer than 10 m so lines do not cut through ridges.
- `src/scene/areas.ts` builds one Line2 per ring, so picking and filtering
  act on single areas (D-07), with a fixed palette in
  `src/scene/palette.ts`. Lift cables run through the OSM vertices at cable
  height offset (D-07). The draw-call count is measured at implementation
  and no figure is promised here (D-07).
- Lift cable offsets are display-only and not surveyed: four measured
  per-type offsets plus one `LIFT_DEFAULT_OFFSET_M = 8` for every other
  aerialway value. A missing aerialway tag throws (D-16).
- Every ring Line2 carries `userData.areaId` for picking.
- If the areas load or install fails, `src/main.ts` exports an `areaLayer`
  of `{ status: 'failed', message }` and shows the message in a dedicated
  alert element, instead of blanking the module.
- A unit test on `drape.ts` asserts a sampled point on a flat synthetic
  heightfield returns the plane height and a point on a ramp interpolates.
- `npm run build` exits 0 with the areas artifact present.

**Touches**: `src/data/load-areas.ts`, `src/scene/drape.ts`,
`src/scene/areas.ts`, `src/scene/palette.ts`, `src/scene/heightfield.ts`,
`tests/scene/drape.test.ts`

**Open gaps**: none

## seed-annotations — Generated seed annotations file keyed by stable area id

**Goal**: Produce `data/annotations.json` by a committed transform so the
file exists for every area from day one, with activities derived from kind
and all world facts left blank, and with the known stakeholder organizations
present as seeded records.

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
- The seed holds 23 organizations (D-04, D-06), each with seven fields: id,
  name, url, type, activities, sourceUrl and verified. Types are nonprofit,
  authority, municipal, club, business and state-agency. Ten organizations
  that could not be verified are seeded with `verified: false`. Grand Avenue
  Nordic Center is not in the seed. COGGS is seeded with a null url.
- Organizations with `verified: false` are never rendered (stakeholders is
  `[]` for every area), and any later link to one must show `verified: false`
  distinctly.
- If `data/annotations.json` already exists, the transform refuses to
  overwrite unless passed `--force`, so later human edits are not clobbered.
  Run `--force` only on the first generated commit.
- Byte-identical across two runs (test).

**Touches**: `scripts/ingest/annotations.ts`,
`scripts/ingest/organizations.seed.json`, `data/annotations.json`,
`tests/ingest/annotations.test.ts`

**Open gaps**: none. The first draft's gap (additional stakeholder orgs
unverified and not seeded) is replaced by D-06: they are seeded with
`verified: false`.

## annotation-panel — Hover and click picking with a side panel showing the annotation

**Goal**: Let the user hover and click any drawn area to read its
annotation, which is the whole point of the scene for a stakeholder review.

**Acceptance**:
- Raycasting against the per-ring area Line2 objects highlights the hovered
  area and shows its name in a tooltip. Picking skips lines whose
  `visible` is false.
- Clicking opens a side panel (plain HTML and CSS, no UI framework) showing
  name, kind, difficulty, each activity with its seasons, each stakeholder
  with org name and role, and notes.
- Areas with no annotation entry show the panel with an explicit "no
  annotation" state rather than an empty panel.
- The panel is driven by the parsed annotations file loaded through
  `src/data/load-annotations.ts` with a Zod boundary parse. An unknown
  orgId fails closed with `AnnotationsLoadError`.
- On a failed annotations load the panel shows a failed state instead of
  throwing, and the filter strip is disabled.
- Keyboard: Escape closes the panel.
- The panel work may build and test against a fixture annotations file that
  is generated independently of the seed transform (D-10). Merge waits until
  `seed-annotations` has merged and the panel runs against the real
  `data/annotations.json`.

**Touches**: `src/scene/pick.ts`, `src/ui/panel.ts`, `src/ui/panel.css`,
`src/data/load-annotations.ts`, `src/wire-annotations.ts`, `index.html`

**Open gaps**: D-10: `needs: seed-annotations` is relaxed to a merge gate;
the frontmatter needs lists `area-schema` instead, so panel work can start
before the seed transform lands.

## layer-filters — Filter the scene by activity and season

**Goal**: Give a stakeholder a way to view only the winter nordic network, or
only summer mtb, which is the seasonal cross-section the principal asked
for.

**Acceptance**:
- A control strip lists every activity except lift-ride, and every season,
  as toggles. There is no lift-ride toggle because lifts stay visible (D-08).
- Toggling hides and shows area lines whose annotation activities do not
  match; terrain and lifts remain visible. Filtering toggles `visible` on
  each ring Line2 of an area (D-07).
- The selected filter state is reflected in the URL hash so a view can be
  shared. Unknown hash keys are ignored with a visible notice.
- A test on the filter predicate covers an area with two activities in
  different seasons.
- On a failed annotations load, the strip is disabled and shows "filters
  unavailable: annotations failed to load".

**Touches**: `src/ui/filters.ts`, `src/ui/filter-hash.ts`,
`src/ui/filter-predicate.ts`, `src/scene/filter-apply.ts`,
`src/scene/areas.ts`, `tests/ui/filters.test.ts`

**Open gaps**: none

## contract-seams-manifest — Seam manifest and artifact registry for the data flow

**Goal**: Record every seam this spike created, which side gates it, and
roll the TSDoc annotations into one agent-readable manifest, so the second
wave starts from a measured map instead of memory.

**Acceptance**:
- agent-data-contract-cartographer produces `docs/contract-seams.json` and
  `docs/contract-seams.html` listing at least: Overpass response, 3DEP
  response, areas.geojson, terrain artifacts, frame.json, annotations.json,
  and each transform as a manipulation node with its replay record.
- agent-schema-registry-architect compiles the TSDoc tags into one manifest
  and a CI script fails when the manifest is stale.
- Each seam records emitter_gate and consumer_gate; any one-sided seam
  carries a one-line decision for why.
- `.github/workflows/ci.yml` runs the audit, `npm test` and `npm run build`
  (D-12). A local `npm run audit:*` demonstration exits non-zero on a stale
  manifest, and one green CI run is recorded.

**Touches**: `docs/contract-seams.json`, `docs/contract-seams.html`,
`scripts/registry/`, `package.json`, `.github/workflows/ci.yml`

**Open gaps**: none

## Deviations log

- D-01: 3DEP request uses imageSR 26915 at 5 m per pixel, the size Open gap is resolved, and the terrain Goal changes from a few hundred kilobytes to about 7.5 MB (7,494,880 bytes); decided by #7 and #9, 2026-10-06.
- D-02: Transforms read manifest.json and frame.json as consumer-gate inputs, and the frame lives in data/frame.json as a third terrain artifact; decided by #7 (emitter) with #8, #9 and #11 (consumers), 2026-10-06.
- D-03: The summit test is the max within a 150 m radius, within 10 m of 407.07 m, the USGS 3DEP 1 m LiDAR maximum recorded by scripts/probes/summit-max.mjs (cross-check 406.97 m); the earlier Wikipedia 396 m value is retired; decided by #9 and amended 2026-10-06.
- D-04: Organization has seven fields and six types, and the activity enum gains adaptive; decided by #6 and #10, 2026-10-06.
- D-05: generatedFrom omits outputHash, which lives in the replay sidecar; decided by #6 (Decision 4), 2026-10-06.
- D-06: Unverified orgs are seeded with verified:false, which replaces the Open gap that left them unseeded; decided by #10, 2026-10-06.
- D-07: One Line2 per ring for picking and filtering, cables run through OSM vertices, and no draw-call figure until measured; decided by #12 and #14, 2026-10-06.
- D-08: The filter strip has no lift-ride toggle because lifts stay visible; decided by #14, 2026-10-06.
- D-09: terrain-mesh needs gis-ingest-pipeline and draped-area-lines needs area-schema, and Touches add heightfield.ts, frame.ts, views.ts and vite.config.ts; decided by #11 and #12, 2026-10-06.
- D-10: annotation-panel no longer needs seed-annotations in frontmatter, which becomes a merge gate with fixture-based development before it; decided by #13, 2026-10-06.
- D-11: GeoTIFF bytes are checked by named assertions and the manifest cross-check, and derived headers are Zod-parsed; decided by #9, 2026-10-06.
- D-12: ci.yml joins contract-seams-manifest Touches while deployment stays a non-goal; decided by #15, 2026-10-06.
- D-13: Raw files are committed under a repo-wide .gitattributes owned by the scaffold; decided by #5, 2026-10-06.
- D-14: Replay sidecars carry package versions and lockSubtreeSha256, not node and v8; decided by #8 and #9, 2026-10-06.
- D-15: Ways partly outside the bbox are kept whole, not clipped; decided by #8, 2026-10-06.
- D-16: Lift cable display offsets are unsurveyed display constants, four measured plus a default of 8 m; decided by #12, 2026-10-06.
- D-17: The fetch retry ladder, scheduler and --refetch archive are hand-written and ratification is pending; decided by #7, 2026-10-06.

## Non-goals

- No in-browser annotation editor or write path in this spec. Annotations
  are edited in `data/annotations.json` outside the app. The editor is a
  second spec once the scene proves out, and it will treat the file as the
  source of truth.
- No recreation-area boundary polygon, building footprints or parcel data;
  none was found in a public machine-readable source. These remain flagged
  gaps.
- No basemap imagery or satellite texture on the terrain.
- No authentication, hosting or deployment. The CI workflow in
  `.github/workflows/ci.yml` is in scope for contract-seams-manifest only.
- No invention of seasons, stakeholder roles, hours or trail status. Blank
  fields stay blank until a human fills them.
- No React or other UI framework; the panel and filters are plain HTML and
  CSS.
