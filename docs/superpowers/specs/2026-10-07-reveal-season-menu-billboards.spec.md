---
type: spec
status: active
title: Black-until-ready reveal, season menu, sport colours and billboards
goal: Show the user only a finished view, let a season drive which activities are offered, and replace the ribbon and symbol experiments with one colour per sport on plain lines plus a floating 3D sign per area group.
tracker: github
items:
  - id: sport-colour-lines
    title: One colour per sport on plain lines; ribbons and extruded symbols removed
    tier: architecture
    needs: []
  - id: loading-reveal
    title: Black canvas until every requested layer and the first frame are ready, then a centre-out vignette reveal
    tier: feature
    needs: []
  - id: season-menu
    title: Season buttons across the top with a per-season activity dropdown
    tier: feature
    needs: [sport-colour-lines]
  - id: sport-billboards
    title: Floating 3D sign per area cluster showing the sport glyph and label in the sport colour
    tier: feature
    needs: [sport-colour-lines]
constraints:
  - Project CLAUDE.md gates apply to every item: typecheck, lint, format:check, test, build all green before done.
  - No innerHTML, outerHTML, insertAdjacentHTML or document.write in src/ (tests/lint/no-inner-html.test.ts).
  - Icons come only from src/ui/icons.json; the URL hash codec in src/ui/filter-hash.ts stays the record of filter state.
  - Every ground-side material gets applyRadialFade then handle.applyHorizon; every elevation-bearing object lives in the ElevatedGroup.
  - Feasibility spike: the most direct working demonstration wins over the most defensible one.
---

# Reveal, season menu, sport colours and billboards

Graham, 2026-10-07, verbatim: "i dont like that a view is shown before all assets are loaded in--first one square of land is shown, then other elements fill in... I want to only show the user the final view. keep view black until view is rendered and then reveal it via opaque-to-transparent vignette opening from center point of view out to edges until full view is seen by user. plan for new seasonal buttons to run along the top of the page as a menu. only relevant activities per seaason should be shown. when a season is selected, show all relevant facility traces and show a dropdown with all seasonal activities enabled. user can then turn them off one by one or turn off the season to go back to the default view. I don't think we have been successful with the track designs. lets go back to simple geometric lines of varying color and instead associate each sport with a given color and show the sport symbol in same color floating as a sort of billboard above relevant areas of the park e.g. using symbol and label from relevant button but displayed as a banner or flag or billboard added onto the landscape in 3d".

## sport-colour-lines — One colour per sport on plain lines; ribbons and extruded symbols removed

**Goal**
Trails go back to plain Line2 geometry, but coloured by sport instead of by area kind. One palette entry per activity in ActivitySchema (src/schema/annotation.ts) becomes the single source of colour for lines, rail buttons and later billboards. The ribbon slabs (#31) and the extruded symbols (#38) are deleted outright: they did not read as trail markings and Graham has rejected both.

**Acceptance**
- A new `SPORT_COLOR: Record<Activity, number>` in src/scene/palette.ts (or a sibling) with eleven distinct, high-saturation colours that stay distinguishable against the NAIP greens and against each other; lift-ride keeps the lift colour.
- Each area's line colour is routed by activity: the selected Activity filter's activity if the area has it, else the area's first annotated activity, else a neutral grey; the routing function is the existing tileForArea logic from src/scene/ribbon-kinds.ts renamed to a sport routing module, with its tests carried over.
- The line layer re-colours on every filter change (applyFilter path in src/ui/filter-apply.ts and mount-filters.ts) without rebuilding geometry: one LineMaterial per activity, lines re-parented to the material by sport.
- The ghost pass (#36) stays and follows the sport colour.
- src/scene/ribbons.ts, src/scene/symbols.ts, src/scene/symbol-sources.ts, src/scene/symbols/, src/scene/ribbon-kinds.ts (except the routing that moves), their tests, and their wiring in src/main.ts and src/ui/mount-filters.ts are removed; `grep -rn ribbon src tests` returns nothing but the activity routing module.
- README and CLAUDE.md lines that mention ribbons or tiles are updated in the same change.
- All five gates pass.

**Touches**
src/scene/palette.ts, src/scene/areas.ts, src/scene/filter-apply.ts or src/ui/filter-apply.ts, src/ui/mount-filters.ts, src/main.ts, src/scene/ribbon-kinds.ts (routing kept, renamed), deletions listed above, tests/scene/areas.test.ts, tests/scene/ribbon-routing.test.ts (renamed), README.md, CLAUDE.md.

**Open gaps**
none

## loading-reveal — Black canvas until every requested layer and the first frame are ready, then a centre-out vignette reveal

**Goal**
The user never sees the scene assemble. A full-screen black overlay covers the canvas until terrain, imagery, areas, sky, and every lazily loaded layer the URL hash requested (buildings, surface, trees) have installed and one frame has rendered with them. Then the overlay opens from the view centre outwards as a radial opaque-to-transparent vignette over about 1.2 s. A later toggle that triggers a lazy load re-covers only if the load takes longer than a short grace period, so toggles stay snappy.

**Acceptance**
- A readiness tracker (src/ui/reveal.ts or src/scene/ready.ts) that registers named promises (terrain, imagery, areas, sky, buildings, surface, trees) and resolves when every registered one has settled and `renderer` has completed one frame after the last settle (use handle.onFrame).
- The overlay is a DOM element (no innerHTML) with a CSS radial-gradient mask or a shader quad; the reveal animates the transparent radius from 0 to the frame diagonal over about 1.2 s with ease-out; `prefers-reduced-motion` gets a 200 ms fade instead.
- Layers that fail to load (surface or buildings error paths already report to #imagery-status) count as settled so the reveal never hangs; a 20 s watchdog reveals anyway and logs which layer never settled.
- The overlay is pointer-events none after reveal and removed from the DOM.
- A unit test for the tracker (jsdom): three registered promises, settle order arbitrary, reveal fires once after the frame callback; a failed promise still counts; the watchdog fires.
- Headless Chrome screenshot sequence proves it: a capture before readiness is black, a capture after is the full scene, both via playwright-core.
- All five gates pass.

**Touches**
src/main.ts, src/scene/scene.ts (onFrame already exists), new src/ui/reveal.ts and reveal.css, index.html, tests/ui/reveal.test.ts.

**Open gaps**
Whether the vignette should also play on view changes (Resort, Overview, Top Down) that need no loading: default no, a flag in the tracker allows it.

## season-menu — Season buttons across the top with a per-season activity dropdown

**Goal**
Winter, Spring, Summer and Fall run along the top of the page as a menu on every viewport. Picking a season shows every area with an activity in that season and opens a dropdown listing only that season's activities, all enabled; the user turns activities off one at a time, and turning the season off returns to the default view. The left rail's Season group goes away and its Activity group shows only the chosen season's activities.

**Acceptance**
- A top bar built by the clicky engine config (scripts/ui/clicky.config.json, regenerate src/ui/clicky.css with `node scripts/ui/gen-clicky.mjs`) with four season keys and Material Symbols glyphs from src/ui/icons.json; on phones it sits above the bottom bar (#33) without overlapping the canvas controls.
- The season-to-activity map is derived from data: an activity is in a season when any annotation lists it with that season (src/schema/annotation.ts seasons); the map is computed once from data/annotations.json at mount.
- Selecting a season sets the hash `season=<s>` and `activity=<all of that season's activities>`; the dropdown lists those activities with checkboxes bound to the hash; unchecking removes that activity from the hash; clearing the season removes both keys. src/ui/filter-hash.ts gains nothing new unless the multi-activity list needs a codec change, in which case the Zod schema there changes with a test.
- The left rail: Season group removed; Activity group filtered to the season's activities when a season is active, all activities when none; counts still from facetCounts.
- The ghost pass and line colours follow the sport routing from sport-colour-lines.
- jsdom tests: season map from a fixture annotations file; selecting a season writes the expected hash; unchecking one activity updates the hash; clearing restores default.
- All five gates pass; headless Chrome screenshots on desktop and 390x844 phone.

**Touches**
scripts/ui/clicky.config.json, src/ui/clicky.css, src/ui/rail.ts, src/ui/rail.css, src/ui/filters.ts, src/ui/mount-filters.ts, src/ui/filter-hash.ts, src/ui/filter-predicate.ts, src/ui/icons.json, index.html, tests/ui/*.

**Open gaps**
Whether "Spring" with zero activities in the seed data should render disabled or hidden: render disabled with a 0 count, matching the rail's current behaviour.

## sport-billboards — Floating 3D sign per area cluster showing the sport glyph and label in the sport colour

**Goal**
Each sport announces itself on the landscape: a flat sign floating above the area (or a cluster of nearby areas of the same sport) showing the rail button's Material Symbols glyph and title-case label in the sport colour, like a banner on a pole. Signs are sized in screen space so they stay legible from the Resort and Overview views, merge when they would overlap, and hide when their sport is filtered out.

**Acceptance**
- One sign per cluster: areas with the same routed sport whose centroids lie within 150 m are one cluster (single-linkage); the sign sits at the cluster centroid, at the active surface height plus 25 m, re-draped on surface change like the lines.
- The sign is a three.js Sprite (camera-facing) whose texture is drawn on a canvas: rounded panel in the sport colour at 90 percent opacity, the glyph from the Material Symbols font (already loaded for the rail; wait for document.fonts.ready before drawing) and the label in white; a thin pole (Line2 or a cylinder) from the ground to the sign.
- Screen-space sizing: `sizeAttenuation` off or a per-frame scale so the panel is about 160 px wide at any distance, capped so it never exceeds 20 percent of the viewport width on phones.
- Signs for a sport are visible only when that sport is in the current routing (selected activity, or the area's first activity when nothing is selected) and the area is visible under the filter; applyFilter updates them.
- Sprites get applyRadialFade and applyHorizon only if they are ground-side; a sign is not, so it skips both but still fades out beyond the context radius by its own distance check.
- Tests: clustering on synthetic centroids; label and glyph lookup from src/ui/icons.json for all eleven activities; visibility under a filter; the canvas drawing covered by a smoke test that the texture has non-transparent pixels (jsdom canvas may need `canvas` package; if absent, test the drawing function's calls through a fake 2D context).
- All five gates pass; headless Chrome screenshots on Resort and Overview show the signs.

**Touches**
new src/scene/billboards.ts, src/ui/icons.ts (glyph codepoint lookup), src/main.ts, src/ui/mount-filters.ts, tests/scene/billboards.test.ts.

**Open gaps**
Whether the panel should also show the area name on hover; deferred to the annotation panel (#34).

## Non-goals

- No annotation editor (#34).
- No new data ingests; the season map and the signs derive from data/annotations.json and the existing areas.
- No changes to the terrain, surface, trees, buildings or horizon layers beyond re-draping signs.
- No preloading of layers the hash did not request; the reveal waits only for what was asked.
