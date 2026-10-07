import frameUrl from '../data/frame.json?url';
import terrainBinUrl from '../data/terrain.f32?url';
import terrainHeaderUrl from '../data/terrain.json?url';
import { loadTerrain } from './data/load-terrain';
import { toScene } from './scene/frame';
import { createScene } from './scene/scene';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('index.html is missing the #app element');
}

const { header, heightfield } = await loadTerrain({
  headerUrl: terrainHeaderUrl,
  binUrl: terrainBinUrl,
  frameUrl,
}).catch((error: unknown) => {
  app.textContent = `Terrain failed to load: ${String(error)}`;
  throw error;
});

const handle = createScene(app, heightfield, { lakeLevelM: header.minElev });

import imageryManifestJson from '../data/raw/imagery-manifest.json';
import naipUrl from '../data/raw/naip.jpg?url';
import { FADE_OUTER_M } from '../scripts/ingest/context-tiles';
import { ImageryManifestSchema } from '../scripts/ingest/imagery-manifest-schema';
import { loadContext, loadContextTextures } from './data/load-context';
import { installContext, type ContextHandle } from './scene/context';
import { headerBox, installSurfaceAsync, type SurfaceHandle } from './scene/surface';
import { groundSlopeColor } from './scene/ground';
import { loadImagery } from './data/load-imagery';
import { decodeHash } from './ui/filter-hash';
import { Color, type Material, type Texture } from 'three';
import { loadImageryStats } from './data/load-imagery-stats';
import { loadSky } from './data/load-sky';
import { loadSurface } from './data/load-surface';
import { loadTrees, type LoadedTrees } from './data/load-trees';
import type { LoadedTerrain } from './data/load-terrain';
import { installTrees, type TreesHandle } from './scene/trees';

/** Failure channel for the imagery layer: one line in its own element, and the terrain keeps its slope shading. */
function reportImageryFailure(message: string): void {
  console.error(`imagery: ${message}`);
  const status = document.createElement('div');
  status.id = 'imagery-status';
  status.setAttribute('role', 'alert');
  status.textContent = `imagery unavailable: ${message}`;
  document.body.append(status);
}

let imageryTexture: Texture | null = null;
/** Mean linear colour of the photo, once data/imagery-stats.json has loaded; the ground uses it when imagery is on. */
let groundMean: Color | null = null;
/** The context ring, once it has loaded; null until then and when every tile failed. */
let contextHandle: ContextHandle | null = null;
/** The first-return surface layer, once it has loaded; null until then and when both heightfields failed. */
let surfaceHandle: SurfaceHandle | null = null;
/** The simulated trees (instanced meshes), present only while Trees is on; disposed when it turns off. */
let treesHandle: TreesHandle | null = null;
/** The decoded tree records and the core heightfield without canopy, once data/trees.* has loaded. */
let treesData: LoadedTrees | null = null;
let noCanopyLayer: LoadedTerrain | null = null;
let treesWanted = decodeHash(location.hash).filter.trees === true;
let treesRequested = false;
let imageryWanted = decodeHash(location.hash).filter.imagery !== false;
const applyImagery = (): void => {
  handle.setImagery(imageryWanted ? imageryTexture : null);
  handle.setGroundColor(imageryWanted ? groundMean : null);
  contextHandle?.setImagery(imageryWanted);
  surfaceHandle?.setImagery(imageryWanted);
};
/** The filter strip calls this on mount and on every toggle; it also fires before the photo has loaded. */
export const setImageryWanted = (on: boolean): void => {
  imageryWanted = on;
  applyImagery();
};

// Not awaited: the terrain is already on screen with slope shading, and a failed load only adds the status line.
const imageryManifest = ImageryManifestSchema.safeParse(imageryManifestJson);
if (!imageryManifest.success) {
  reportImageryFailure(imageryManifest.error.issues.map((i) => i.message).join('; '));
} else {
  void loadImagery({
    url: naipUrl,
    capabilities: handle.renderer.capabilities,
    expectedWidth: imageryManifest.data.width,
  }).then((result) => {
    if (result.texture === null) return reportImageryFailure(result.reason);
    imageryTexture = result.texture;
    surfaceHandle?.setTexture(result.texture);
    applyImagery();
  });
}

import areasUrl from '../data/areas.geojson?url';
import { loadAreas } from './data/load-areas';
import { installAreas, type AreaLayer } from './scene/areas';
import { createMeshSurface } from './scene/heightfield';
import { deriveLandmarks } from './scene/landmarks';
import { focusBoxOf, type FocusBox } from './scene/views';

/**
 * Failure channel for the areas layer. Writes the message to its own element with textContent and
 * never touches #app, so a failed load leaves the rendered terrain on screen.
 */
function reportAreasFailure(message: string): { error: string } {
  console.error(`areas: ${message}`);
  const status = document.createElement('div');
  status.id = 'areas-status';
  status.setAttribute('role', 'alert');
  status.textContent = `areas unavailable: ${message}`;
  document.body.append(status);
  return { error: message };
}

const meshSurface = createMeshSurface(heightfield);
let areaLayerResult: AreaLayer | { error: string };
try {
  const areas = await loadAreas(areasUrl);
  areaLayerResult = installAreas(handle.elevated, areas, meshSurface, (east, north, elevation) => {
    const p = toScene(east, north, elevation);
    return [p.x, p.y, p.z];
  });
} catch (error) {
  areaLayerResult = reportAreasFailure(error instanceof Error ? error.message : String(error));
}
// The fade is centred on the resort focus box (downhill runs and lifts), or on the centre tile when there is none.
let fadeCentre = {
  east: heightfield.originEast + ((heightfield.cols - 1) * heightfield.cellSizeEast) / 2,
  north: heightfield.originNorth - ((heightfield.rows - 1) * heightfield.cellSizeNorth) / 2,
};
const sampleHeight = (east: number, north: number): number =>
  meshSurface.sample(east, north).height;
let resortFocus: FocusBox | null = null;
if (!('error' in areaLayerResult)) {
  const focus = focusBoxOf(areaLayerResult.registry.values());
  if (focus) {
    resortFocus = focus;
    const liftOnly = deriveLandmarks(areaLayerResult.registry.values(), null, sampleHeight);
    handle.setView('resort', focus, liftOnly ?? undefined);
    fadeCentre = {
      east: (focus.minEast + focus.maxEast) / 2,
      north: (focus.minNorth + focus.maxNorth) / 2,
    };
  }
}
handle.setFadeCentre(fadeCentre);
// #exag=2.5 is honoured here, once the terrain, areas and view are in, so a failed annotations load cannot lose it.
const setSceneExaggeration = (k: number): void => handle.setExaggeration(k);
setSceneExaggeration(decodeHash(location.hash).filter.exag ?? 1);

/** One line in the shared imagery status element for the ground or sky; the scene keeps its fallback look. */
function reportSceneFailure(what: string, message: string): void {
  console.error(`${what}: ${message}`);
  let status = document.getElementById('imagery-status');
  if (!status) {
    status = document.createElement('div');
    status.id = 'imagery-status';
    status.setAttribute('role', 'alert');
    document.body.append(status);
  }
  status.textContent = `${what} unavailable: ${message.split('\n')[0] ?? message}`;
}

// Not awaited: ground and sky arrive after the terrain is already on screen. Failures keep the flat sky and slope-coloured ground.
void loadImageryStats().then((stats) => {
  if ('error' in stats) {
    reportSceneFailure('ground colour', stats.error);
    handle.setGround(groundSlopeColor(), header.minElev);
    return;
  }
  groundMean = new Color(stats.meanLinear.r, stats.meanLinear.g, stats.meanLinear.b);
  handle.setGround(groundMean, header.minElev);
  handle.setGroundColor(imageryWanted ? groundMean : null);
});
void loadSky().then((sky) => {
  if ('error' in sky) {
    handle.setSkyFallback();
    handle.setHorizonSky(null);
    return reportSceneFailure('sky', sky.error);
  }
  handle.setSky(sky);
  handle.setHorizonSky(sky);
  console.info('sky: panorama applied');
});

import buildingsUrl from '../data/buildings.geojson?url';
import { loadBuildings } from './data/load-buildings';
import { buildBuildingsLayer, type BuildingsLayer } from './scene/buildings';

/** One line in the imagery status element for the buildings layer; the terrain and areas are never touched. */
function reportBuildingsFailure(message: string): void {
  console.error(`buildings: ${message}`);
  let status = document.getElementById('imagery-status');
  if (!status) {
    status = document.createElement('div');
    status.id = 'imagery-status';
    status.setAttribute('role', 'alert');
    document.body.append(status);
  }
  status.textContent = `buildings unavailable: ${message.split('\n')[0] ?? message}`;
}

let buildingsLayer: BuildingsLayer | null = null;
let buildingsWanted = decodeHash(location.hash).filter.buildings !== false;
/** The filter strip calls this on mount and on every toggle; it can fire before the buildings have loaded. */
export const setBuildingsWanted = (on: boolean): void => {
  buildingsWanted = on;
  buildingsLayer?.setVisible(on);
};

// The landmark view is re-applied once the buildings load, unless the user has already moved the camera.
let resortMoved = false;
handle.controls.addEventListener('start', () => {
  resortMoved = true;
});
// Not awaited: the terrain and areas are already usable, and a failure here only adds a status line.
void loadBuildings(buildingsUrl)
  .then((result) => {
    if ('error' in result) return reportBuildingsFailure(result.error);
    if (resortFocus && !('error' in areaLayerResult) && !resortMoved) {
      const landmarks = deriveLandmarks(
        areaLayerResult.registry.values(),
        result.features,
        sampleHeight,
      );
      if (landmarks) handle.setView('resort', resortFocus, landmarks);
    }
    const layer = buildBuildingsLayer(result.features, meshSurface, { centre: fadeCentre });
    layer.setVisible(buildingsWanted);
    handle.applyHorizon(layer.mesh.material as Material);
    handle.elevated.add(layer.mesh);
    buildingsLayer = layer;
    if (layer.dropped.length > 0) {
      console.warn(
        `buildings: ${layer.dropped.length} footprints dropped (${layer.dropped[0]?.id}: ${layer.dropped[0]?.reason})`,
      );
    }
  })
  .catch((error: unknown) => {
    reportBuildingsFailure(error instanceof Error ? error.message : String(error));
  });

/** One line in the imagery status element for the surface layer; the terrain, buildings and areas are never touched. */
function reportSurfaceFailure(message: string): void {
  console.error(`surface: ${message}`);
  let status = document.getElementById('imagery-status');
  if (!status) {
    status = document.createElement('div');
    status.id = 'imagery-status';
    status.setAttribute('role', 'alert');
    document.body.append(status);
  }
  status.textContent = `surface unavailable: ${message.split('\n')[0] ?? message}`;
}

/** Writes the transient "loading surface…" line, and clears it only if nothing else has replaced it. */
const LOADING_SURFACE_TEXT = 'loading surface…';
function setSurfaceLoading(on: boolean): void {
  let status = document.getElementById('imagery-status');
  if (on) {
    if (!status) {
      status = document.createElement('div');
      status.id = 'imagery-status';
      status.setAttribute('role', 'alert');
      document.body.append(status);
    }
    status.textContent = LOADING_SURFACE_TEXT;
  } else if (status?.textContent === LOADING_SURFACE_TEXT) {
    status.textContent = '';
  }
}

/** Lets the browser paint and handle input between the two heavy geometry builds. */
const yieldToBrowser = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function')
      requestIdleCallback(() => resolve(), { timeout: 200 });
    else setTimeout(resolve, 0);
  });

let surfaceWanted = decodeHash(location.hash).filter.surface === true;
let surfaceRequested = false;
/** Area lines follow the drawn surface while it is visible, and return to bare earth when it is hidden. */
const applySurfaceDrape = (): void => {
  if ('error' in areaLayerResult) return;
  areaLayerResult.redrape(
    surfaceWanted && surfaceHandle ? surfaceHandle.sampler(meshSurface) : meshSurface,
  );
};

/** Loads and builds the surface the first time it is wanted; the default page with Surface off never pays for it. */
function requestSurface(): void {
  if (surfaceRequested) return;
  surfaceRequested = true;
  setSurfaceLoading(true);
  void loadSurface({ frameUrl })
    .then(async (result) => {
      const failures = [result.square, result.core].flatMap((layer) =>
        'error' in layer ? [layer.error] : [],
      );
      if (failures.length === 2) return reportSurfaceFailure(failures.join('; '));
      surfaceHandle = await installSurfaceAsync(
        handle.elevated,
        result,
        { fadeCentre, imageryBox: headerBox(header), imagery: imageryTexture },
        yieldToBrowser,
      );
      for (const mesh of Object.values(surfaceHandle.meshes)) {
        handle.applyHorizon(mesh.material as Material);
      }
      surfaceHandle.setImagery(imageryWanted);
      surfaceHandle.setVisible(surfaceWanted);
      applyTreesMode();
      setSurfaceLoading(false);
      if (failures.length > 0) reportSurfaceFailure(failures.join('; '));
      console.info(
        'surface: imagery edge delta (m, positive = inside the photo)',
        surfaceHandle.imageryDelta,
      );
    })
    .catch((error: unknown) => {
      reportSurfaceFailure(error instanceof Error ? error.message : String(error));
    });
}

/** The filter strip calls this on mount and on every toggle; the first on starts the lazy load. */
export const setSurfaceWanted = (on: boolean): void => {
  surfaceWanted = on;
  if (on) requestSurface();
  surfaceHandle?.setVisible(on);
  applyTreesMode();
};
if (surfaceWanted) requestSurface();

/**
 * Trees on: the instanced trees are built (from the cached records) and shown, and while the Surface layer is also on the
 * core mesh swaps to the core-nocanopy heightfield, so the LiDAR canopy blobs give way to the simulated trees. Trees off:
 * the trees are disposed and the normal core returns. Lines re-drape onto whichever composite is drawn.
 */
function applyTreesMode(): void {
  const showTrees = treesWanted && treesData !== null;
  if (showTrees && treesData && !treesHandle) {
    treesHandle = installTrees(handle.elevated, treesData, { fadeCentre });
    handle.applyHorizon(treesHandle.material);
  }
  if (!showTrees && treesHandle) {
    treesHandle.dispose();
    treesHandle = null;
  }
  treesHandle?.setVisible(showTrees);
  const mixed = showTrees && surfaceWanted && noCanopyLayer !== null;
  surfaceHandle?.setCoreVariant(mixed ? 'nocanopy' : 'canopy', noCanopyLayer ?? undefined);
  applySurfaceDrape();
}

/** One line in the imagery status element for the trees layer; the terrain, surface and areas are never touched. */
function reportTreesFailure(message: string): void {
  console.error(`trees: ${message}`);
  let status = document.getElementById('imagery-status');
  if (!status) {
    status = document.createElement('div');
    status.id = 'imagery-status';
    status.setAttribute('role', 'alert');
    document.body.append(status);
  }
  status.textContent = `trees unavailable: ${message.split('\n')[0] ?? message}`;
}

/** Loads the trees the first time they are wanted; the default page with Trees off never pays for them. */
function requestTrees(): void {
  if (treesRequested) return;
  treesRequested = true;
  void loadTrees({ frameUrl })
    .then((result) => {
      if ('error' in result.trees) return reportTreesFailure(result.trees.error);
      treesData = result.trees;
      if ('error' in result.noCanopy) reportTreesFailure(result.noCanopy.error);
      else noCanopyLayer = result.noCanopy;
      applyTreesMode();
    })
    .catch((error: unknown) => {
      reportTreesFailure(error instanceof Error ? error.message : String(error));
    });
}

/** The filter strip calls this on mount and on every toggle; the first on starts the lazy load. */
export const setTreesWanted = (on: boolean): void => {
  treesWanted = on;
  if (on) requestTrees();
  applyTreesMode();
};
if (treesWanted) requestTrees();

/** One line in the imagery status element for the context ring; a failure here never touches the centre terrain. */
function reportContextFailure(message: string): void {
  console.error(`context: ${message}`);
  let status = document.getElementById('imagery-status');
  if (!status) {
    status = document.createElement('div');
    status.id = 'imagery-status';
    status.setAttribute('role', 'alert');
    document.body.append(status);
  }
  status.textContent = `context unavailable: ${message}`;
}

// Not awaited: the centre terrain, areas and panel are already usable; tiles that fail just stay out of the ring.
void loadContext({ frameUrl })
  .then((context) => {
    if (context.missing.length > 0) {
      reportContextFailure(
        `${context.missing.length} of ${context.tiles.length + context.missing.length} tiles missing (${context.missing[0]?.key}: ${context.missing[0]?.reason})`,
      );
    }
    if (context.tiles.length === 0) return;
    contextHandle = installContext(handle.elevated, context.tiles, {
      fadeCentre,
      imageryOn: imageryWanted,
    });
    for (const mesh of contextHandle.meshes.values()) {
      handle.applyHorizon(mesh.material as Material);
    }
    handle.setContextExtent(FADE_OUTER_M);
    const failures: string[] = [];
    return loadContextTextures(context.tiles, {
      capabilities: handle.renderer.capabilities,
      onTexture: (key, texture) => contextHandle?.setTexture(key, texture),
      onFailure: (key, reason) => failures.push(`${key}: ${reason}`),
    }).then(() => {
      if (failures.length > 0) {
        reportContextFailure(`${failures.length} tile photos failed (${failures[0]})`);
      }
    });
  })
  .catch((error: unknown) => {
    reportContextFailure(error instanceof Error ? error.message : String(error));
  });
export const areaLayer: AreaLayer | { error: string } = areaLayerResult;

import annotationsUrl from '../data/annotations.json?url';
import {
  failedAnnotationsHandle,
  wireAnnotations,
  type AnnotationsHandle,
} from './wire-annotations';

const panelRoot = document.getElementById('annotation-panel');
const tooltipRoot = document.getElementById('pick-tooltip');
if (!panelRoot || !tooltipRoot)
  throw new Error('index.html is missing #annotation-panel or #pick-tooltip');

/**
 * Resolves to the annotations handle and never rejects: a failed areas layer or any wiring error becomes a failed handle,
 * which #14 shows as "filters unavailable". An AnnotationsLoadError is already handled inside wireAnnotations (red panel state).
 */
export const annotationsReady: Promise<AnnotationsHandle> =
  'error' in areaLayer
    ? Promise.resolve(failedAnnotationsHandle(`areas unavailable: ${areaLayer.error}`))
    : wireAnnotations({
        scene: handle,
        registry: areaLayer.registry,
        annotationsUrl,
        panelRoot,
        tooltipRoot,
      }).catch((error: unknown) => {
        console.error(error);
        return failedAnnotationsHandle(error instanceof Error ? error.message : String(error));
      });

import type { AreaEntry } from './scene/areas';
import { mountFilters } from './ui/mount-filters';
import { mountViews } from './ui/views-strip';

mountViews({
  setView: (name) => handle.setView(name),
  initial: 'error' in areaLayer ? 'overview' : 'resort',
  onUserMove: (listener) => {
    handle.controls.addEventListener('start', listener);
    return () => handle.controls.removeEventListener('start', listener);
  },
});

// annotationsReady never rejects, so this needs no catch, and the .then keeps a slow annotations load from blocking the module.
void annotationsReady.then((handle) => {
  const registry: ReadonlyMap<string, AreaEntry> =
    'error' in areaLayer ? new Map() : areaLayer.registry;
  mountFilters({
    registry,
    handle,
    setImagery: setImageryWanted,
    setBuildings: setBuildingsWanted,
    setSurface: setSurfaceWanted,
    setTrees: setTreesWanted,
    setExaggeration: setSceneExaggeration,
  });
});

if (import.meta.env.DEV) {
  (window as unknown as { __spirit: unknown }).__spirit = {
    renderer: handle.renderer,
    scene: handle.scene,
  };
}

export { handle, heightfield, toScene };
