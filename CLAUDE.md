# Spirit Mountain

An interactive three.js map of Spirit Mountain, Duluth, Minnesota, built from pinned public GIS data. Live site: https://lampagj.github.io/spiritmountain/

## Commands that gate every change

- `npm run typecheck`, `npm run lint` (eslint plus `scripts/lint-determinism.sh`), `npm test` (vitest), `npm run format:check`, `npm run build`. All five pass before a change is done.
- Run `node scripts/ui/gen-clicky.mjs --check` when `scripts/ui/clicky.config.json` or `src/ui/clicky.css` changes. `clicky.css` is generated: edit the config and rerun without `--check`.
- Dev server: `npx vite --port 5199`. Port 5173 is taken on this Mac.
- Node floor is `.nvmrc` (22.22.2); `package.json` engines allow newer.

## Data doctrine as applied here

- Raw inputs are pinned under `data/raw/` with a manifest and sha256. Transforms are committed scripts under `scripts/ingest/` that write a replay sidecar (`inputHash`, `codeCommit`, `outputHash`, `effect`).
- `codeCommit` is the last commit touching the transform's `TRANSFORM_SOURCES` closure (a test per transform enforces the closure). Ingests refuse uncommitted sources: run them from a clean worktree and never pass `--allow-dirty` for a record you commit.
- Hand-editing any `data/` file is forbidden, except `data/annotations.json`, which is a primary-source input. Fix everything else with a committed transform.
- Every artifact is parsed at the boundary with the Zod v4 schema in `src/schema/` (or the transform's own schema file). Never `JSON.parse` bare. An empty parse is an error, never `[]`.
- A new transform carries the TSDoc triple `@displayName` / `@strategicPurpose` / `@tacticalObjective` and `@manipulation`. Run `agent-zod-zealot` on any new or changed schema.
- `scripts/determinism-patterns.txt` bans `Date.now`, `new Date()`, `Math.random`, `crypto.random*`, `localeCompare`, `toLocale*`, `Promise.race/any/allSettled`, `for await`, and fetches in `scripts/ingest`. The lint skips five fetchers by name: `fetch.ts`, `imagery.ts`, `context.ts`, `sky.ts`, `fetch-buildings.ts` (`scripts/lint-determinism.sh:37`). It also scans `src/scene/drape.ts` and `src/ui/filter-predicate.ts`.
- Replay sidecars record package versions and `lockSubtreeSha256`, never node versions.

## Ingest order

Run as `npm run ingest:<name>`. Each needs the ones above it that it names.

- `fetch`: pins Overpass areas JSON and the 3DEP GeoTIFF, writes `data/frame.json`. Refuses to overwrite without `--refetch`.
- `areas`: OSM to local-metre areas GeoJSON. Refuses without `--force`.
- `terrain`: 3DEP to `terrain.f32` plus header.
- `annotations`: seeds `data/annotations.json` from areas and `organizations.seed.json`. Refuses without `--force`, which backs up the old file first.
- `imagery`: pins the NAIP image. Refuses without `--force`.
- `imagery-stats`: reduces the NAIP to the ground mean colour.
- `sky`: pins the Poly Haven HDR. Refuses without `--force`.
- `context`: pins 12 context tiles. Refuses without `--force`. `context-terrain` then decodes them.
- `buildings:fetch`: pins the buildings Overpass response. Refuses without `--force`. `buildings` then transforms it and refuses without `--force`.
- `surface`: pins the first-return raster through PDAL (`brew install pdal`). Refuses without `--force`. `surface-terrain` decodes it with no PDAL.
- Square window: `npm run ingest:surface -- --window square`, then `npm run ingest:surface-terrain -- --window square`.
- `trees` (#30): simulated trees and `core-nocanopy` from the surface, NAIP and footprints. Not committed yet; check `git log` before relying on it.
- `places` (#61): needs `fetch`, `areas`. Reads the hand-authored `scripts/ingest/places.seed.json` (primary-source input, like the organizations seed), projects it through the frame, resolves anchors against `areas.geojson`, writes `data/places.json`. Refuses without `--force`. A place with `verified: false` never labels a sign. The loader (`src/data/load-places.ts`) tolerates a missing file with one `console.info`.

## Scene conventions

- Local metres are EPSG:26915 minus the origin in `data/frame.json`. Scene x is east, y is elevation, z is minus north (`src/scene/frame.ts:35`). Camera at positive z looks north.
- Every object whose y encodes elevation lives in the one `ElevatedGroup` (`src/scene/elevated.ts:23`); exaggeration scales it about lake level and never rebuilds geometry. Ground plane and sky stay outside it.
- The active heightfield sampler is the bare-earth mesh surface, or the composite surface sampler while Surface is on. `areaLayerResult.redrape` (`src/scene/areas.ts:112`) re-drapes every non-lift line when it changes; lifts keep straight cables.
- Line colour is routed per sport by `sportForArea` (`src/scene/sport-routing.ts`); `AreaLayer.route` swaps per-activity materials on every filter change without rebuilding geometry.
- Every ground-side material gets `applyRadialFade` (`src/scene/fade.ts:37`) and then `handle.applyHorizon` (`src/scene/horizon.ts:79`, via `src/scene/scene.ts:64`). A new ground-side layer without both shows a hard edge or a seam at the horizon.
- Surface meshes are capped at 700 segments (square) and 1024 (core) (`src/scene/surface.ts:147`). Above that the renderer stalled over 45 s on 5.2M triangles. Do not raise the caps without a browser measurement.
- Track signs (`src/scene/billboards.ts`, #55, #60) are two families of sprites inside `ElevatedGroup`. Concentration signs hover at the length-weighted centroid of each group of tracks whose vertices lie within 250 m (`src/scene/track-key.ts` is the one track key; a group over 12 tracks and 1500 m splits by k-means) and have no pointer. A trail sign (one per named track) sits at the track's length midpoint: the name in bold over one sport chip per activity, with the panel and its tapered 15 degree tail drawn as one canvas path (#63; `drawSign`, `TAIL_PX`, `TAIL_X_FRACTION`). The sprite alone is the sign, centred at `(TAIL_X_FRACTION, 0)` so the tail apex sits on the trail point with no lift; `trailAnchor` in `buildBillboardLayer` is the one place that point is chosen. The Adventure Park place sign (`HERO_PLACE_ID`) is the MAIN sign (#70): a sprite in the same layer, `HERO_SCALE` 1.8x the normal width, floating `HERO_OFFSET_M` 40 m above the active surface, never decluttered; its projected rect is the fixed rect `declutterStep` makes every other sign yield to. Every canvas is sized to its content by `layoutSign` (padding, name lines, count, chips) and the sprite takes the canvas's own width:height ratio, so no sign is stretched; a place sign stacks name (bold, up to two lines), count, then centred chips. Both families go through one declutter with hysteresis (`declutterStep`: a pass at most every 150 ms and only after the camera moves 0.5 degrees or 2 m; hide at over 25 percent overlap; show after 600 ms clear; 220 ms fades; positions never depend on the camera). The per-frame callback divides sprite y-scale by `effectiveScale` and fades by distance itself, because the sprite shader skips `applyRadialFade`.
- Layers load lazily and toggle by URL hash keys: `activity`, `season`, `imagery=off`, `buildings=off`, `surface=on`, `trees=on`, `exag=` (0.1 to 10). The codec is `src/ui/filter-hash.ts:10`.

## UI conventions

- The rail is generated from `scripts/ui/clicky.config.json` with the clicky-button engine at `~/Projects/clicky-button` (override with `CLICKY_BUTTON_DIR`).
- The rail has no Activity group (#56): it starts at Clear Filters, then the status line and Layers. Activities appear only as the season menu's second row (`src/ui/season-menu.ts`) while a season is selected; `activity` hash keys still parse and apply.
- Icons come only from `src/ui/icons.json`, parsed at `src/ui/icons.ts:19`. Names are verified Material Symbols; never invent one. `iconFor` throws on an unknown id.
- No `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` in `src/` (`tests/lint/no-inner-html.test.ts`). Build DOM with `createElement` and `textContent`.
- Tuning controls go through `registerDebugControl` / `registerDebugToggle` in `src/ui/debug-panel.ts` (the collapsed DEBUG panel, top right, `sm-debug-open` in localStorage). No hash key: it is not state of record. Sport strands shift on screen by the `uStrandShift` uniform patched in `src/scene/areas.ts` (`patchStrandShader`); `AreaLayer.strandMode` says whether the patch landed.
- The hash codec lives in `src/ui/filter-hash.ts`; a new hash key goes through its Zod schema, never ad hoc parsing.
- One top bar (`#season-bar`, `src/ui/top-bar.ts`) holds `[View ▾] [seasons] [Layers ▾]`, the status line and the activity row. View and Layers are popouts (plain buttons in a `div`, one open at a time); the rail holds only Clear Filters and hides when no filter is active. The terrain exaggeration slider lives in the DEBUG panel (`src/ui/mount-filters.ts`); `exag=` stays the state of record.

## Git and tracker

- Branches are `epic/*` and `feat/*`, cut from `main`, merged `--no-ff`. Stage explicit paths. All git goes through `agent-git-guardian`.
- `.github/workflows/pages.yml` deploys `main` to Pages with `GITHUB_PAGES=1 npm run build`.
- Issues live on GitHub (`LampaGJ/spiritmountain`) and carry a `Target branch:` line.
- Fetch an issue body with `gh api repos/LampaGJ/spiritmountain/issues/N --jq .body`, never `gh issue view` in a TTY. NUL escapes get mangled; write NUL as `\x00`.

## Known traps

- The `cp` alias is `cp -i` and hangs non-interactive copies. Use `command cp -f`.
- A hidden Chrome tab suspends `requestAnimationFrame`, so frame probes look frozen.
- Vite hot reload aborts long page evaluations while files change.
- GitHub stores `\u0000` as `\^@`.
- The adhoc-data-script guard wants `.safeParse(` or `@manipulation` in new data scripts.
- Unquoted globs abort under zsh and read as "not found". Quote them or use `find`.

## Pointers

- Spec, with the Deviations log and Non-goals: `docs/superpowers/specs/2026-10-06-spirit-mountain-gis-scene-design.md`.
- Place names for the concentration signs, with sources and gaps: `docs/place-names.md`.
- Activity rules and their original sources, with gaps: `docs/activity-audit.md`.
- Stakeholder research: `docs/stakeholder-orgs.md`. Machine-readable seed: `scripts/ingest/organizations.seed.json`.
