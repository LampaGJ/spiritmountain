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

## Scene conventions

- Local metres are EPSG:26915 minus the origin in `data/frame.json`. Scene x is east, y is elevation, z is minus north (`src/scene/frame.ts:35`). Camera at positive z looks north.
- Every object whose y encodes elevation lives in the one `ElevatedGroup` (`src/scene/elevated.ts:23`); exaggeration scales it about lake level and never rebuilds geometry. Ground plane and sky stay outside it.
- The active heightfield sampler is the bare-earth mesh surface, or the composite surface sampler while Surface is on. `areaLayerResult.redrape` (`src/scene/areas.ts:112`) re-drapes every non-lift line when it changes; lifts keep straight cables.
- Line colour is routed per sport by `sportForArea` (`src/scene/sport-routing.ts`); `AreaLayer.route` swaps per-activity materials on every filter change without rebuilding geometry.
- Every ground-side material gets `applyRadialFade` (`src/scene/fade.ts:37`) and then `handle.applyHorizon` (`src/scene/horizon.ts:79`, via `src/scene/scene.ts:64`). A new ground-side layer without both shows a hard edge or a seam at the horizon.
- Surface meshes are capped at 700 segments (square) and 1024 (core) (`src/scene/surface.ts:147`). Above that the renderer stalled over 45 s on 5.2M triangles. Do not raise the caps without a browser measurement.
- Track signs (`src/scene/billboards.ts`) mark the START and END of each track (`src/scene/track-key.ts` is the one track key) as one rigid group per sign inside `ElevatedGroup`: a 15 degree right-triangle pointer plus a sprite; the per-frame callback divides sprite y-scale by `effectiveScale`, scales the pointer's x by it, and fades by distance itself, because the sprite shader skips `applyRadialFade`.
- Layers load lazily and toggle by URL hash keys: `activity`, `season`, `imagery=off`, `buildings=off`, `surface=on`, `trees=on`, `exag=` (0.1 to 10). The codec is `src/ui/filter-hash.ts:10`.

## UI conventions

- The rail is generated from `scripts/ui/clicky.config.json` with the clicky-button engine at `~/Projects/clicky-button` (override with `CLICKY_BUTTON_DIR`).
- Icons come only from `src/ui/icons.json`, parsed at `src/ui/icons.ts:19`. Names are verified Material Symbols; never invent one. `iconFor` throws on an unknown id.
- No `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` in `src/` (`tests/lint/no-inner-html.test.ts`). Build DOM with `createElement` and `textContent`.
- The hash codec lives in `src/ui/filter-hash.ts`; a new hash key goes through its Zod schema, never ad hoc parsing.

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
- Stakeholder research: `docs/stakeholder-orgs.md`. Machine-readable seed: `scripts/ingest/organizations.seed.json`.
