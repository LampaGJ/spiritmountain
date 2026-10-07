# Spirit Mountain

An interactive 3D map of the Spirit Mountain Recreation Area in Duluth, Minnesota. It drapes real aerial photography over a lidar terrain model, then adds the ski runs, nordic trails, bike trails and lifts from OpenStreetMap, every building, the tree canopy and a photographic sky. Each run, trail and lift can carry a note about which activities happen there, in which seasons, and which local organisations look after it. Everything runs in the browser from static files, and every number in those files can be rebuilt from a pinned public source.

<!-- Screenshot placeholder: add docs/screenshots/default-view.png (the default view from the lower chalet lot) and reference it here. -->

Live site: https://lampagj.github.io/spiritmountain/

This is a proof of concept. It shows what is technically possible with public data. It is not a product launch.

## What you see

The page opens at eye level in the lower chalet parking lot, looking up the main lift toward the Upper Chalet. Drag to orbit. Scroll to zoom. Hover a line to highlight it. Click it to open the side panel with its annotation.

The left rail has four groups of keys.

- Activity: alpine ski, snowboard, nordic classic, nordic skate, snowshoe, fat bike, mountain bike, hike, trail run, tubing, adaptive and lift ride. Pick one or more to hide every area that does not match.
- Season: winter, spring, summer and fall.
- Layers: Imagery, Buildings, Surface, Trees and a terrain exaggeration slider.
- View: Resort, Overview and Top-down camera views, plus a key that clears the filters.

Each layer and filter has a URL hash key, so you can share exactly what you are looking at.

- `#activity=mountain-bike,hike` filters by activity.
- `#season=summer` filters by season.
- `#imagery=off` hides the aerial photo.
- `#buildings=off` hides the 2,723 extruded building footprints.
- `#surface=on` shows the first-return surface: roofs and treetops as the lidar saw them. It is off by default because it is heavy.
- `#trees=on` shows simulated individual trees built from the canopy height and the photo's greenness.
- `#exag=3` exaggerates the relief three times about lake level. The range is 0.1 to 10.

Keys combine with `&`, for example `#season=winter&surface=on&exag=2`.

Beyond the terrain tiles, the ground fades into a flat colour and then into the true horizon, and the sky is a photographic panorama.

## Data sources

Every input is fetched once, pinned under `data/raw/` with its request, response status and sha256, and committed.

- Trails, runs, lifts and buildings: OpenStreetMap through the Overpass API. Licence: ODbL. Map data by [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). The query box is 46.68,-92.26 to 46.74,-92.17.
- Terrain: USGS 3DEP bare-earth elevation, requested from the national map service at 5 m per pixel in EPSG:26915. The underlying source is the 1 m bare-earth DEM from the Minnesota DNR LiDAR collection of 2021. Public domain. Twelve lower-resolution tiles (30 m) surround the resort tile.
- Imagery: USGS NAIPPlus orthoimagery, requested for exactly the terrain's box (4000 by 3879 pixels). Public domain. Ten-metre NAIP tiles cover the surrounding ring.
- First-return surface: the USGS Entwine point clouds `MN_LakeSuperior_2_2021` and `MN_LakeSuperior_1_2021`, read with PDAL. The first return of each pulse gives roofs and treetops. The second cloud covers the eastern part of the larger square window. Public domain.
- Sky: a Poly Haven HDRI, `kloofendal_48d_partly_cloudy_puresky` at 1k, by Greg Zaal with sky edits by Jarod Guest. Licence: CC0.
- Stakeholder organisations: 23 organisations researched from public pages, 13 verified and 10 not. The findings and their source links are in [docs/stakeholder-orgs.md](docs/stakeholder-orgs.md). The machine-readable list is `scripts/ingest/organizations.seed.json`.

Facts not found in a source are left blank. The project does not invent seasons, roles, hours or trail status.

## How it is built

The pipeline is a chain. Each arrow is a deterministic script, and each script writes a replay record.

- Raw pins in `data/raw/` (Overpass JSON, 3DEP GeoTIFF, NAIP JPEG, context tiles, PDAL rasters, sky HDR), each with a manifest and sha256.
- Transforms in `scripts/ingest/` read only those pins and `data/frame.json`.
- Artifacts in `data/`: `areas.geojson`, `terrain.f32`, `buildings.geojson`, `context/`, `surface/`, `imagery-stats.json`, `trees.bin` and `annotations.json`.
- Replay records beside them: `areas.replay.json`, `terrain.replay.json`, `buildings.replay.json`, `imagery-stats.replay.json`, `annotations.replay.json`, `context/context.replay.json`, `surface/surface.replay.json`, `surface/square.replay.json` and `trees.replay.json`.
- Loaders in `src/data/` parse every artifact with a Zod schema before the scene sees it.
- The scene in `src/scene/` builds three.js geometry from the parsed data.
- The interface in `src/ui/` reads and writes the URL hash.
- Vite builds static files, and a GitHub Actions workflow publishes them to GitHub Pages on every push to `main`.

A replay record holds the `inputHash`, the `codeCommit`, the `outputHash` and the declared effect: `preserves`, `reduces` or `expands`. Run a transform again at the recorded commit on the pinned input and the output bytes hash to the same value. That is the proof. The declared effect is only a quick check. An automated replay verifier is still open work (#19).

## Running locally

You need Node 22.22.2 or newer. The exact version is in `.nvmrc`.

```sh
npm install
npx vite --port 5199
```

Then open http://localhost:5199/. The committed `data/` is enough to run the site. You only run the ingest commands to rebuild it.

```sh
npm run typecheck
npm run lint
npm test
npm run format:check
npm run build
```

`npm run build` makes a root-relative build. `GITHUB_PAGES=1 npm run build` makes the `/spiritmountain/` build that Pages serves.

The ingest commands run in this order. The fetching ones need network access.

```sh
npm run ingest:fetch
npm run ingest:areas
npm run ingest:terrain
npm run ingest:annotations
npm run ingest:imagery
npm run ingest:imagery-stats
npm run ingest:sky
npm run ingest:context
npm run ingest:context-terrain
npm run ingest:buildings:fetch
npm run ingest:buildings
npm run ingest:surface
npm run ingest:surface-terrain
npm run ingest:trees
```

`ingest:surface` reads the public point cloud through [PDAL](https://pdal.io). Install it first (for example `brew install pdal`) and make sure `pdal` is on your `PATH`. Every other command needs only Node. For the larger square window, run `npm run ingest:surface -- --window square` and then `npm run ingest:surface-terrain -- --window square`.

The fetching commands, `ingest:areas`, `ingest:buildings` and `ingest:annotations` refuse to overwrite an existing pin or output. Pass `--force` to replace it (`--refetch` for `ingest:fetch`). `ingest:annotations` backs up your annotations file first, because people edit it.

## Reproducibility rules

Every data step is deterministic code. It is committed, and it can be replayed from a pinned input to a byte-identical output. A transform may not read the clock, draw a random number, sort by locale or fetch over the network. A lint (`npm run lint:determinism`) greps for those hazards. The only scripts exempt from it are the five that fetch the pins.

Nobody edits data by hand, with one exception: `data/annotations.json`. If any other file is wrong, the fix is a change to the transform, committed, and the file is regenerated. A transform records the last commit that touched its own source files. For that reason an ingest refuses to run on uncommitted changes. Run it from a clean worktree.

## Project layout

- `data/`: committed artifacts, replay records and the raw pins under `data/raw/`.
- `scripts/ingest/`: the fetchers and transforms, with their schemas.
- `scripts/ui/`: the generator for the rail's CSS.
- `scripts/lint-determinism.sh` and `scripts/determinism-patterns.txt`: the determinism lint.
- `scripts/probes/` and `scripts/fixtures/`: one-off measurements and fixture builders.
- `src/schema/`: the Zod schemas for areas, annotations, organisations, terrain and replay records.
- `src/data/`: loaders that parse each artifact at the boundary.
- `src/scene/`: three.js layers, camera views, fade and horizon shading.
- `src/ui/`: the rail, annotation panel, filters and the URL hash codec.
- `tests/`: Vitest suites for ingest, scene, data and interface code.
- `docs/`: the design spec and the stakeholder research.
- `.github/workflows/`: the Pages deployment.

## Annotations

`data/annotations.json` is the source of truth for what the map says about each area. It holds a version, a `generatedFrom` record, a list of organisations and a list of annotations. There is one annotation per area, keyed by the area's OpenStreetMap id.

```json
{
  "areaId": "way/1008678100",
  "activities": [{ "activity": "mountain-bike", "seasons": ["summer", "fall"], "notes": "" }],
  "stakeholders": [{ "orgId": "cyclists-of-gitchee-gumee-shores", "role": "maintains" }],
  "notes": ""
}
```

- `areaId` is `node/N`, `way/N` or `relation/N`, and must match an area in `data/areas.geojson`.
- `activity` is one of the twelve activities listed under What you see. `seasons` is a list of `winter`, `spring`, `summer` and `fall`, and it may be empty.
- `orgId` must match an organisation `id` in the same file. `role` is `maintains`, `operates`, `programs`, `funds` or `advocates`.
- Notes are plain text. Empty means nothing is recorded.

To edit it, change the file directly and commit. The loader checks the whole file against its schema when the page loads. It rejects unknown fields, duplicate ids and stakeholders that name no organisation, and it reports the first issue. Run `npm test` to check your edit. Do not run `ingest:annotations --force` after editing: it regenerates the seed and discards your work (it keeps a backup).

## Roadmap

Open work on GitHub (https://github.com/LampaGJ/spiritmountain/issues):

- #30: the trees layer, with simulated trees from the canopy height model and photo greenness, replacing the lidar canopy blobs in the core.
- #31: trail ribbons, with repeating pattern textures per trail kind draped along every contour.
- #15 and #4: a manifest of the data seams and a registry of every artifact.
- #19: a replay verifier that checks each record against its inputs.
- #20: shared helpers for atomic writes and comparators.

The spec lists what is out of scope for now, including an in-browser annotation editor. See `docs/superpowers/specs/2026-10-06-spirit-mountain-gis-scene-design.md`.

## Licence and attribution

No code licence is declared yet. Until one is added, the code is not licensed for reuse.

Data attributions:

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL.
- Elevation, orthoimagery and point clouds: USGS 3DEP and NAIP, public domain. The 2021 lidar was collected for the Minnesota DNR.
- Sky: Poly Haven, CC0.
